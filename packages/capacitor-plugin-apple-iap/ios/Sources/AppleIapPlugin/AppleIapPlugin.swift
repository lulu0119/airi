import Capacitor
import Foundation

/// Capacitor bridge for the AppleIap plugin.
///
/// All business logic lives in `AppleIapStoreKit`. This class only marshals
/// plugin calls across the Capacitor bridge. Three methods are exposed:
/// `configure`, `getProducts`, `purchase`. There are no events — JWS strings
/// and `transaction.finish()` are kept inside the native layer.
@objc(AppleIapPlugin)
public class AppleIapPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleIapPlugin"
    public let jsName = "AppleIap"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise)
    ]

    private let store = AppleIapStoreKit()

    @objc func configure(_ call: CAPPluginCall) {
        guard
            let serverBaseUrl = call.getString("serverBaseUrl"),
            let bearerToken = call.getString("bearerToken"),
            let appAccountTokenStr = call.getString("appAccountToken")
        else {
            call.reject("MISSING_ARGUMENTS", "serverBaseUrl, bearerToken, and appAccountToken are required")
            return
        }
        guard let serverURL = URL(string: serverBaseUrl) else {
            call.reject("INVALID_SERVER_URL", "serverBaseUrl must be a valid URL")
            return
        }
        guard let appAccountToken = UUID(uuidString: appAccountTokenStr) else {
            call.reject("INVALID_APP_ACCOUNT_TOKEN", "appAccountToken must be a UUID string")
            return
        }

        Task {
            await store.configure(serverBaseUrl: serverURL, bearerToken: bearerToken, appAccountToken: appAccountToken)
            call.resolve()
        }
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        guard let productIds = call.getArray("productIds", String.self) else {
            call.reject("MISSING_ARGUMENTS", "productIds is required")
            return
        }

        Task {
            do {
                let products = try await store.loadProducts(productIds: productIds)
                call.resolve(["products": products])
            } catch {
                call.reject("LOAD_PRODUCTS_FAILED", error.localizedDescription)
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId") else {
            call.reject("MISSING_ARGUMENTS", "productId is required")
            return
        }

        Task {
            do {
                let outcome = try await store.purchase(productId: productId)
                call.resolve(outcome)
            } catch let error as AppleIapError {
                call.reject(error.code, error.message)
            } catch {
                call.reject("PURCHASE_FAILED", error.localizedDescription)
            }
        }
    }
}
