import Foundation
import StoreKit

/// A structured error surface the bridge can map to a `CAPPluginCall.reject`.
struct AppleIapError: Error {
    let code: String
    let message: String

    static let notConfigured = AppleIapError(code: "NOT_CONFIGURED", message: "AppleIap.configure must be called before purchase")
    static let productNotFound = AppleIapError(code: "PRODUCT_NOT_FOUND", message: "No StoreKit product found for the requested productId")
    static let jwsUnverified = AppleIapError(code: "JWS_UNVERIFIED", message: "StoreKit returned an unverified transaction")
    static let serverUnreachable = AppleIapError(code: "SERVER_UNREACHABLE", message: "Could not reach the AIRI server to submit the transaction")
    static let serverError = AppleIapError(code: "SERVER_ERROR", message: "Server rejected the transaction with a retriable error")
}

/// Thread-safe configuration and transaction state holder.
///
/// StoreKit 2 APIs are `async` and thread-safe, but we still serialize our
/// config mutations and in-flight HTTP dispatches through an actor so the
/// `Transaction.updates` long-lived listener and user-initiated purchases
/// cannot step on each other.
actor AppleIapStoreKit {
    private struct Config {
        let serverBaseUrl: URL
        let bearerToken: String
        let appAccountToken: UUID
    }

    private var config: Config?
    private var backgroundTasksStarted = false
    private var urlSession: URLSession

    init() {
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.waitsForConnectivity = false
        sessionConfig.timeoutIntervalForRequest = 20
        sessionConfig.timeoutIntervalForResource = 30
        self.urlSession = URLSession(configuration: sessionConfig)
    }

    /// Atomically replace the config. Starts the Transaction.updates listener
    /// and drains Transaction.unfinished on the first call.
    func configure(serverBaseUrl: URL, bearerToken: String, appAccountToken: UUID) {
        self.config = Config(serverBaseUrl: serverBaseUrl, bearerToken: bearerToken, appAccountToken: appAccountToken)

        guard !backgroundTasksStarted else {
            return
        }
        backgroundTasksStarted = true
        startTransactionUpdatesListener()
        drainUnfinishedTransactions()
    }

    /// Load StoreKit products and shape them for the JS side.
    ///
    /// Unknown product IDs are silently dropped to match the documented
    /// behavior and avoid a hard failure when App Store Connect configuration
    /// is partially rolled out.
    func loadProducts(productIds: [String]) async throws -> [[String: Any]] {
        let products = try await Product.products(for: productIds)
        return products.map { product in
            // StoreKit 2 exposes price as Decimal; convert to integer micros
            // to preserve precision across the JS bridge. JS side multiplies
            // by 1 / 1_000_000 only when it needs the numeric value.
            let priceMicros = NSDecimalNumber(decimal: product.price * 1_000_000).int64Value
            return [
                "id": product.id,
                "displayName": product.displayName,
                "description": product.description,
                "displayPrice": product.displayPrice,
                "priceMicros": priceMicros,
                "currencyCode": product.priceFormatStyle.currencyCode
            ]
        }
    }

    /// Present the StoreKit purchase sheet, POST the JWS to the server, and
    /// finish the transaction only after the server acknowledges.
    func purchase(productId: String) async throws -> [String: Any] {
        guard let current = config else {
            throw AppleIapError.notConfigured
        }

        let products = try await Product.products(for: [productId])
        guard let product = products.first else {
            throw AppleIapError.productNotFound
        }

        let result = try await product.purchase(options: [.appAccountToken(current.appAccountToken)])

        switch result {
        case .success(let verification):
            switch verification {
            case .verified(let transaction):
                // NOTICE:
                // Submit BEFORE calling transaction.finish(). If submit fails with a
                // retriable error we deliberately leave the transaction unfinished so
                // StoreKit redelivers it via Transaction.updates / Transaction.unfinished
                // on the next session. Combined with the server-side unique
                // transaction_id + fluxCredited atomic claim this yields at-most-once
                // credit semantics.
                let jws = verification.jwsRepresentation
                let submitResult = try await submitAndFinish(transaction: transaction, jws: jws, config: current)
                var payload: [String: Any] = [
                    "status": "success",
                    "transactionId": String(transaction.id)
                ]
                if let applied = submitResult["applied"] as? Bool {
                    payload["applied"] = applied
                }
                if let balanceAfter = submitResult["balanceAfter"] as? Int {
                    payload["balanceAfter"] = balanceAfter
                } else if let balanceAfter = submitResult["balanceAfter"] as? Double {
                    payload["balanceAfter"] = Int(balanceAfter)
                }
                return payload
            case .unverified:
                throw AppleIapError.jwsUnverified
            }
        case .userCancelled:
            return ["status": "userCancelled"]
        case .pending:
            return ["status": "pending"]
        @unknown default:
            return ["status": "pending"]
        }
    }

    // MARK: - Internal helpers

    /// Long-lived consumer of the StoreKit 2 `Transaction.updates` stream.
    ///
    /// Handles Ask-to-Buy approvals, StoreKit re-delivery after network
    /// failures, and promoted purchases. Any verified transaction is treated
    /// identically to a purchase-initiated one: submit + finish.
    private func startTransactionUpdatesListener() {
        Task.detached { [weak self] in
            for await verification in Transaction.updates {
                guard let self = self else { return }
                await self.handleVerificationSilently(verification)
            }
        }
    }

    /// On first configure, iterate existing unfinished transactions and push
    /// them through the same submit-and-finish pipeline.
    private func drainUnfinishedTransactions() {
        Task.detached { [weak self] in
            guard let self = self else { return }
            for await verification in Transaction.unfinished {
                await self.handleVerificationSilently(verification)
            }
        }
    }

    private func handleVerificationSilently(_ verification: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = verification else {
            return
        }
        guard let current = config else {
            // Not yet configured — drop; the next configure() call will drain again.
            return
        }
        do {
            _ = try await submitAndFinish(transaction: transaction, jws: verification.jwsRepresentation, config: current)
        } catch {
            // Transient errors: leave the transaction unfinished so it
            // redelivers next session. Nothing to surface to JS — the user
            // initiated no foreground action here.
            NSLog("[AppleIap] background submit failed for txn=\(transaction.id): \(error)")
        }
    }

    private func submitAndFinish(transaction: Transaction, jws: String, config current: Config) async throws -> [String: Any] {
        let url = current.serverBaseUrl.appendingPathComponent("api/v1/apple-iap/transactions")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(current.bearerToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["signedTransaction": jws])

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            NSLog("[AppleIap] network error posting txn=\(transaction.id): \(error)")
            throw AppleIapError.serverUnreachable
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw AppleIapError.serverUnreachable
        }

        switch httpResponse.statusCode {
        case 200...299:
            // Success or idempotent replay: in both cases the server's state
            // is authoritative and we must finish locally to stop StoreKit
            // from re-delivering the same transaction.
            await transaction.finish()
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            return json
        case 400...499:
            // Non-retriable: misconfigured bundle, unknown product, token
            // mismatch. Finish anyway so we do not death-loop on startup.
            let bodySnippet = String(data: data, encoding: .utf8) ?? ""
            NSLog("[AppleIap] server rejected txn=\(transaction.id) status=\(httpResponse.statusCode) body=\(bodySnippet)")
            await transaction.finish()
            throw AppleIapError(code: "SERVER_REJECTED", message: "Server rejected transaction: \(httpResponse.statusCode)")
        default:
            // 5xx or unexpected: leave unfinished so StoreKit redelivers.
            NSLog("[AppleIap] server 5xx for txn=\(transaction.id) status=\(httpResponse.statusCode)")
            throw AppleIapError.serverError
        }
    }
}
