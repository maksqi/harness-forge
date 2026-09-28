import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { COMPOSER_DRAFT_KEY_PREFIX, readComposerDraft, useComposerDraft, writeComposerDraft } from './useComposerDraft'

function stored(chatId: string) {
  return sessionStorage.getItem(`${COMPOSER_DRAFT_KEY_PREFIX}${chatId}`)
}

describe('useComposerDraft', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores the draft of a chat and saves edits after a short delay', () => {
    writeComposerDraft('a', 'half-written')
    const scope = effectScope()
    const draft = scope.run(() => useComposerDraft('a'))!
    expect(draft.text.value).toBe('half-written')

    draft.text.value = 'half-written thought'
    expect(stored('a')).toBe('half-written')
    vi.advanceTimersByTime(300)
    expect(stored('a')).toBe('half-written thought')
    scope.stop()
  })

  it('keeps one draft per chat when the chat changes', async () => {
    const chatId = ref('a')
    const scope = effectScope()
    const draft = scope.run(() => useComposerDraft(chatId))!
    draft.text.value = 'for chat a'
    chatId.value = 'b'
    await nextTick()
    expect(stored('a')).toBe('for chat a')
    expect(draft.text.value).toBe('')

    draft.text.value = 'for chat b'
    chatId.value = 'a'
    await nextTick()
    expect(draft.text.value).toBe('for chat a')
    expect(readComposerDraft('b')).toBe('for chat b')
    scope.stop()
  })

  it('forgets the draft once sent and removes blank drafts', () => {
    writeComposerDraft('a', 'send me')
    const scope = effectScope()
    const draft = scope.run(() => useComposerDraft('a'))!
    draft.clear()
    expect(draft.text.value).toBe('')
    expect(stored('a')).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(stored('a')).toBeNull()

    draft.text.value = '   '
    vi.advanceTimersByTime(300)
    expect(stored('a')).toBeNull()
    scope.stop()
  })

  it('writes a pending change when the composer goes away', () => {
    const scope = effectScope()
    const draft = scope.run(() => useComposerDraft('a'))!
    draft.text.value = 'unsaved'
    scope.stop()
    expect(stored('a')).toBe('unsaved')
  })
})
