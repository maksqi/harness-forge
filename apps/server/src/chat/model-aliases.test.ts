// `resolveClaudeModel` (Phase 12, ADR-058; C44 stub with its final signature, W12.7 implements it): the stub answers
// null for every alias, so every caller keeps its existing fallback; an aborted signal rejects.
import type { ClaudeModelContext } from './model-aliases.ts'
import { describe, expect, it } from 'vitest'
import { resolveClaudeModel } from './model-aliases.ts'

function context(overrides: Partial<ClaudeModelContext> = {}): ClaudeModelContext {
  return {
    modelAliases: { sonnet: 'mock:echo', opus: null, haiku: null, fable: null },
    providers: { resolveModel: async () => Promise.reject(new Error('not used by the stub')) },
    ...overrides,
  }
}

describe('resolveClaudeModel (C44 stub)', () => {
  it('answers null (the caller\'s fallback) for every alias and every full id', async () => {
    for (const alias of ['sonnet', 'opus', 'haiku', 'fable', 'claude-sonnet-4-5'])
      expect(await resolveClaudeModel(alias, context())).toBeNull()
    expect(await resolveClaudeModel('sonnet', context({ modelAliases: null }))).toBeNull()
  })

  it('rejects when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(resolveClaudeModel('sonnet', context({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' })
  })
})
