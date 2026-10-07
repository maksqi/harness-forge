// `resolveClaudeModel` (Phase 12, ADR-058; W12.7-T8): the setting `modelAliases` first, then `anthropic:<id>` for a full
// `claude-…` id when that model resolves, else null (the caller's fallback and notice); `opusplan` reads as `opus`, `[1m]`
// is dropped; an aborted signal rejects. Mock providers only (no key from the environment is ever read).
import type { ResolvedModel } from '../providers/types.ts'
import type { ClaudeModelContext } from './model-aliases.ts'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { resolveClaudeModel } from './model-aliases.ts'

/** Providers that resolve `known` model refs (chat models) and answer `provider_not_configured` for anything else. */
function providers(known: readonly string[], kind: 'chat' | 'image' = 'chat'): ClaudeModelContext['providers'] & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    resolveModel: async (modelRef) => {
      calls.push(modelRef)
      if (!known.includes(modelRef))
        throw new HarnessError({ code: 'provider_not_configured', message: 'Not configured.', providerId: 'anthropic', action: 'configure-provider' })
      return { modelRef, entry: { kind } } as unknown as ResolvedModel
    },
  }
}

function context(overrides: Partial<ClaudeModelContext> = {}): ClaudeModelContext {
  return {
    modelAliases: { sonnet: 'mock:echo', opus: 'mock:agents', haiku: null, fable: null },
    providers: providers([]),
    ...overrides,
  }
}

describe('resolveClaudeModel (W12.7-T8)', () => {
  it('the table: alias set / unset, a full id with and without an Anthropic key, opusplan, [1m], other names', async () => {
    const withKey = providers(['anthropic:claude-sonnet-4-5'])
    const cases: Array<[alias: string, context: ClaudeModelContext, expected: string | null]> = [
      ['sonnet', context(), 'mock:echo'],
      ['Sonnet', context(), 'mock:echo'],
      ['sonnet[1m]', context(), 'mock:echo'],
      ['opus', context(), 'mock:agents'],
      ['opusplan', context(), 'mock:agents'],
      ['haiku', context(), null],
      ['fable', context(), null],
      ['sonnet', context({ modelAliases: null }), null],
      ['sonnet', context({ modelAliases: undefined }), null],
      ['claude-sonnet-4-5', context({ providers: withKey }), 'anthropic:claude-sonnet-4-5'],
      ['claude-sonnet-4-5[1m]', context({ providers: withKey }), 'anthropic:claude-sonnet-4-5'],
      ['claude-sonnet-4-5', context(), null],
      ['claude-opus-9', context({ providers: withKey }), null],
      ['mock:echo', context(), null],
      ['inherit', context(), null],
      ['gpt-5', context(), null],
      ['', context(), null],
    ]
    for (const [alias, ctx, expected] of cases)
      expect(await resolveClaudeModel(alias, ctx), alias).toBe(expected)
  })

  it('a setting value that is not a model ref is ignored; a short alias never asks the providers', async () => {
    const calls = providers(['anthropic:claude-sonnet-4-5'])
    expect(await resolveClaudeModel('sonnet', context({ modelAliases: { sonnet: 'not a ref' } as never, providers: calls }))).toBeNull()
    expect(calls.calls).toEqual([])
  })

  it('a full id resolves only to a chat model', async () => {
    expect(await resolveClaudeModel('claude-image-1', context({ providers: providers(['anthropic:claude-image-1'], 'image') }))).toBeNull()
  })

  it('rejects when the signal is aborted (before and during the provider check)', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(resolveClaudeModel('sonnet', context({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    const during = new AbortController()
    const slow: ClaudeModelContext['providers'] = {
      resolveModel: async () => {
        during.abort(new DOMException('stopped', 'AbortError'))
        throw new Error('aborted')
      },
    }
    await expect(resolveClaudeModel('claude-sonnet-4-5', context({ providers: slow, signal: during.signal }))).rejects.toThrow()
  })
})
