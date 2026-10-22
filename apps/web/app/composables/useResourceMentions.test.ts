// useResourceMentions (Phase 14, ADR-061; docs/UI.md 7.35, 11.10): the C54 skeleton's signature (the shared mention token,
// nothing listed yet); W14.8 implements the listing and `attach` and extends this file.
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { mcpResourceEntry } from '~/utils/testing/fixtures'
import { useResourceMentions } from './useResourceMentions'

describe('useResourceMentions (skeleton)', () => {
  it('reads the `@` token at the caret while enabled, null while disabled', () => {
    const text = ref('see @READ')
    const caret = ref(9)
    const enabled = ref(true)
    const mentions = useResourceMentions({ projectId: null, text, caret, enabled })
    expect(mentions.token.value).toMatchObject({ query: 'READ' })
    enabled.value = false
    expect(mentions.token.value).toBeNull()
    expect(mentions.items.value).toEqual([])
    expect(mentions.state.value).toBe('idle')
    expect(mentions.truncated.value).toBe(false)
    expect(mentions.unavailable.value).toEqual([])
  })

  it('attach refuses until W14.8 implements it; refresh resolves', async () => {
    const mentions = useResourceMentions({ projectId: () => null, text: ref(''), caret: ref(0), enabled: true })
    await expect(mentions.refresh()).resolves.toBeUndefined()
    await expect(mentions.attach(mcpResourceEntry())).rejects.toMatchObject({ code: 'not_implemented' })
  })
})
