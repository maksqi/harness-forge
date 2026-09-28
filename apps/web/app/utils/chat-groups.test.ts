import { describe, expect, it } from 'vitest'
import { chatDateLabel, groupChatsByDate, msUntilNextLocalDay } from './chat-groups'

const NOW = new Date(2026, 8, 28, 9, 30).getTime()

function at(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month, day, hour).getTime()
}

describe('chat date groups', () => {
  it('labels calendar days relative to now', () => {
    expect(chatDateLabel(at(2026, 8, 28, 0), NOW)).toBe('Today')
    expect(chatDateLabel(NOW + 60_000, NOW)).toBe('Today')
    expect(chatDateLabel(at(2026, 8, 27, 23), NOW)).toBe('Yesterday')
    expect(chatDateLabel(at(2026, 8, 26, 1), NOW)).toBe('Previous 7 days')
    expect(chatDateLabel(at(2026, 8, 21, 0), NOW)).toBe('Previous 7 days')
    expect(chatDateLabel(at(2026, 8, 20, 23), NOW)).toBe('Previous 30 days')
    expect(chatDateLabel(at(2026, 7, 29, 0), NOW)).toBe('Previous 30 days')
    expect(chatDateLabel(at(2026, 7, 28, 23), NOW)).toBe('August')
    expect(chatDateLabel(at(2025, 11, 31), NOW)).toBe('December 2025')
  })

  it('groups newest first and keeps chats newest first within a group', () => {
    const chats = [
      { id: 'a', updatedAt: at(2026, 7, 1) },
      { id: 'b', updatedAt: at(2026, 8, 28, 8) },
      { id: 'c', updatedAt: at(2026, 8, 28, 9) },
      { id: 'd', updatedAt: at(2025, 6, 4) },
      { id: 'e', updatedAt: at(2026, 7, 2) },
    ]
    expect(groupChatsByDate(chats, NOW).map(group => [group.label, group.chats.map(chat => chat.id)])).toEqual([
      ['Today', ['c', 'b']],
      ['August', ['e', 'a']],
      ['July 2025', ['d']],
    ])
    expect(groupChatsByDate([], NOW)).toEqual([])
  })

  it('waits until the next local midnight', () => {
    expect(msUntilNextLocalDay(new Date(2026, 8, 28, 23, 59, 0).getTime())).toBe(60_000)
    expect(msUntilNextLocalDay(new Date(2026, 8, 28, 23, 59, 59, 900).getTime())).toBe(1000)
  })
})
