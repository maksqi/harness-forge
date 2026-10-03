// Instruction markers (Phase 9, C26-T2): stable, distinct, never a substring of each other (the mock models match them
// with `includes`).
import { describe, expect, it } from 'vitest'
import { COMPACT_INSTRUCTIONS_MARKER, SUBAGENT_INSTRUCTIONS_MARKER } from './markers.ts'

describe('instruction markers', () => {
  it('are the frozen strings', () => {
    expect(COMPACT_INSTRUCTIONS_MARKER).toBe('[[hf:compact-summarizer:v1]]')
    expect(SUBAGENT_INSTRUCTIONS_MARKER).toBe('[[hf:subagent:v1]]')
  })

  it('are distinct and do not contain each other', () => {
    expect(COMPACT_INSTRUCTIONS_MARKER).not.toBe(SUBAGENT_INSTRUCTIONS_MARKER)
    expect(COMPACT_INSTRUCTIONS_MARKER.includes(SUBAGENT_INSTRUCTIONS_MARKER)).toBe(false)
    expect(SUBAGENT_INSTRUCTIONS_MARKER.includes(COMPACT_INSTRUCTIONS_MARKER)).toBe(false)
    for (const marker of [COMPACT_INSTRUCTIONS_MARKER, SUBAGENT_INSTRUCTIONS_MARKER])
      expect(marker.trim()).toBe(marker)
  })
})
