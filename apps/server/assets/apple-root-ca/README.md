# Apple Root Certificate Authorities

Root certificates required by `@apple/app-store-server-library`'s `SignedDataVerifier` to validate the JWS certificate chain returned by StoreKit 2 and the App Store Server API.

## Files

- `AppleRootCA-G2.cer` — Apple Root CA G2 (RSA 4096). [apple.com/certificateauthority/AppleRootCA-G2.cer](https://www.apple.com/certificateauthority/AppleRootCA-G2.cer)
- `AppleRootCA-G3.cer` — Apple Root CA G3 (ECC P-384). [apple.com/certificateauthority/AppleRootCA-G3.cer](https://www.apple.com/certificateauthority/AppleRootCA-G3.cer)

## Refreshing

Apple rotates root CAs infrequently. If `SignedDataVerifier` starts rejecting previously valid transactions, re-download with:

```bash
curl -fsSL -o AppleRootCA-G2.cer https://www.apple.com/certificateauthority/AppleRootCA-G2.cer
curl -fsSL -o AppleRootCA-G3.cer https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
```

See [Apple PKI](https://www.apple.com/certificateauthority/) for the authoritative list.
