import { describe, expect, it } from 'vitest'
import { isReadonly } from 'vue'
import { useSpeechPlayer } from './useSpeechPlayer'

describe('useSpeechPlayer', () => {
  it('returns one app-wide player: the same object and refs on every call', () => {
    const first = useSpeechPlayer()
    const second = useSpeechPlayer()
    expect(second).toBe(first)
    expect(second.state).toBe(first.state)
    expect(second.activeId).toBe(first.activeId)
  })

  it('starts idle with nothing active, behind read-only refs, with play, stop and toggle', () => {
    const player = useSpeechPlayer()
    expect(Object.keys(player).sort()).toEqual(['activeId', 'play', 'state', 'stop', 'toggle'])
    expect(player.state.value).toBe('idle')
    expect(player.activeId.value).toBeNull()
    expect(isReadonly(player.state)).toBe(true)
    expect(isReadonly(player.activeId)).toBe(true)
    expect([player.play, player.stop, player.toggle].every(method => typeof method === 'function')).toBe(true)
  })
})
