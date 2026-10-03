import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { projectFileEntry, projectId } from '~/utils/testing/fixtures'
import { useFileMentions } from './useFileMentions'

describe('useFileMentions (P9-0b signature)', () => {
  it('follows the token under the caret but never opens until W9.8', () => {
    const text = ref('Fix @src/pa')
    const caret = ref(text.value.length)
    const mentions = useFileMentions({ projectId: ref<string | null>(projectId(1)), text, caret })
    expect(mentions.token.value).toEqual({ start: 4, end: 11, query: 'src/pa' })
    expect(mentions.open.value).toBe(false)
    expect(mentions.items.value).toEqual([])
    expect(mentions.state.value).toBe('ready')
    expect(mentions.error.value).toBeNull()
    expect(mentions.truncated.value).toBe(false)
    text.value = 'a@b'
    caret.value = 3
    expect(mentions.token.value).toBeNull()
    mentions.dismiss()
    expect(mentions.apply(projectFileEntry())).toEqual({ text: 'a@b', caret: 3, keepOpen: false })
  })
})
