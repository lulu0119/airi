import { Environment } from '@apple/app-store-server-library'
import { describe, expect, it } from 'vitest'

import { appleIapEnvironmentToStoreKitEnvironment } from './verifier'

describe('appleIapEnvironmentToStoreKitEnvironment', () => {
  it('maps xcode to the StoreKit local Xcode verifier environment', () => {
    expect(appleIapEnvironmentToStoreKitEnvironment('xcode')).toBe(Environment.XCODE)
  })
})
