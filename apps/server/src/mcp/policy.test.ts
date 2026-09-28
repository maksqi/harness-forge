import { describe, expect, it } from 'vitest'
import { DEFAULT_MCP_POLICY, mcpToolPolicy } from './policy.ts'

describe('mcpToolPolicy', () => {
  it.each([
    [{ readOnlyHint: true }, 'ask', 'safe'],
    [{ readOnlyHint: true, destructiveHint: true }, 'always', 'safe'],
    [{ destructiveHint: true }, 'safe', 'always'],
    [{ readOnlyHint: false, destructiveHint: false }, 'safe', 'safe'],
    [{}, 'always', 'always'],
    [undefined, 'ask', 'ask'],
    [null, 'safe', 'safe'],
    [{ readOnlyHint: 'true' }, 'ask', 'ask'],
  ] as const)('%j with server policy %s -> %s', (hints, serverPolicy, expected) => {
    expect(mcpToolPolicy(hints, serverPolicy)).toBe(expected)
  })

  it('defaults to ask', () => {
    expect(DEFAULT_MCP_POLICY).toBe('ask')
    expect(mcpToolPolicy({})).toBe('ask')
  })
})
