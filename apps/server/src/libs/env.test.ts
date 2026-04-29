import { describe, expect, it } from 'vitest'

import { parseEnv } from './env'

function baseEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://example',
    REDIS_URL: 'redis://example',
    BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long',
    AUTH_GOOGLE_CLIENT_ID: 'google-client',
    AUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
    AUTH_GITHUB_CLIENT_ID: 'github-client',
    AUTH_GITHUB_CLIENT_SECRET: 'github-secret',
  }
}

describe('parseEnv', () => {
  it('parses the required auth and infrastructure environment variables', () => {
    const env = parseEnv(baseEnv())

    expect(env.DATABASE_URL).toBe('postgres://example')
    expect(env.REDIS_URL).toBe('redis://example')
  })

  it('accepts xcode for local StoreKit configuration transactions', () => {
    const env = parseEnv({
      ...baseEnv(),
      APPLE_IAP_ENV: 'xcode',
    })

    expect(env.APPLE_IAP_ENV).toBe('xcode')
  })
})
