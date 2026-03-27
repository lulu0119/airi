import { describe, expect, it } from 'vitest'

import { joinTextParts, normalizeToolResult } from './normalize'

describe('normalizeToolResult', () => {
  it('parses JSON object string with MCP content', () => {
    const raw = JSON.stringify({
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { checkpointId: 'abc' },
      isError: false,
    })
    const n = normalizeToolResult(raw)
    expect(n.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(n.structuredContent).toEqual({ checkpointId: 'abc' })
    expect(n.isError).toBe(false)
  })

  it('treats non-JSON string as single text part', () => {
    const n = normalizeToolResult('plain')
    expect(n.content).toEqual([{ type: 'text', text: 'plain' }])
  })

  it('passes through content array', () => {
    const parts = [{ type: 'text' as const, text: 'x' }]
    const n = normalizeToolResult(parts)
    expect(n.content).toEqual(parts)
  })
})

describe('joinTextParts', () => {
  it('joins text parts with newlines', () => {
    expect(joinTextParts([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'image', url: 'x' },
    ])).toBe('a\nb')
  })
})
