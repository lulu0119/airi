import { describe, expect, it } from 'vitest'

import { parseDevUiOriginEnv, parseEnv } from './env'

function baseEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://example',
    REDIS_URL: 'redis://example',
    BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long',
    AUTH_GOOGLE_CLIENT_ID: 'google-client',
    AUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
    AUTH_GITHUB_CLIENT_ID: 'github-client',
    AUTH_GITHUB_CLIENT_SECRET: 'github-secret',
    GATEWAY_BASE_URL: 'http://localhost:18080',
    DEFAULT_CHAT_MODEL: 'openai/gpt-5-mini',
    DEFAULT_TTS_MODEL: 'microsoft/v1',
  }
}

describe('parseDevUiOriginEnv', () => {
  it('normalizes a single origin', () => {
    expect(parseDevUiOriginEnv('')).toBe('')
    expect(parseDevUiOriginEnv(' https://10.0.0.129:5273/ ')).toBe('https://10.0.0.129:5273')
  })

  it('rejects comma-separated lists', () => {
    expect(() => parseDevUiOriginEnv('https://10.0.0.129:5273,https://198.18.0.1:5273')).toThrow(/single origin/)
  })

  it('throws on invalid URLs', () => {
    expect(() => parseDevUiOriginEnv('not-a-url')).toThrow(/invalid URL origin/)
  })

  it('rejects non-http(s) schemes', () => {
    expect(() => parseDevUiOriginEnv('localhost:5173')).toThrow(/http\(s\)/)
    expect(() => parseDevUiOriginEnv('javascript:alert(1)')).toThrow(/http\(s\)/)
  })
})

describe('parseEnv', () => {
  it('parses the required auth and infrastructure environment variables', () => {
    const env = parseEnv(baseEnv())

    expect(env.DATABASE_URL).toBe('postgres://example')
    expect(env.REDIS_URL).toBe('redis://example')
    expect(env.DEV_UI_ORIGIN).toBe('')
  })

  it('parses DEV_UI_ORIGIN into a normalized origin', () => {
    const env = parseEnv({
      ...baseEnv(),
      DEV_UI_ORIGIN: 'https://10.0.0.129:5273/',
    })

    expect(env.DEV_UI_ORIGIN).toBe('https://10.0.0.129:5273')
  })
})
