// useMoveChat skeleton (docs/UI.md 11.4; C15, P7-0b): the frozen signature; the move itself is W7.9's.
import { describe, expect, it } from 'vitest'
import { chatId, projectId } from '~/utils/testing/fixtures'
import { useMoveChat } from './move-chat'

describe('useMoveChat', () => {
  it('returns a move action that resolves (it never rejects)', async () => {
    const move = useMoveChat()
    expect(typeof move).toBe('function')
    await expect(move(chatId(1), projectId(1))).resolves.toBeUndefined()
    await expect(move(chatId(1), null)).resolves.toBeUndefined()
  })
})
