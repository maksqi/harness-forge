// The context guard (P9-0b stub, C26-T5): a piece that changes nothing until W9.1.
import type { RunSession } from '../pipeline.ts'
import { describe, expect, it } from 'vitest'
import { COMPACT_TRIGGER_RATIO, createContextGuard } from './guard.ts'

describe('createContextGuard (stub until W9.1)', () => {
  it('is a piece that changes nothing', async () => {
    const piece = createContextGuard({ session: {} as RunSession, model: {} as never, keptUser: async () => null })
    expect(await piece({ stepNumber: 0, messages: [{ role: 'user', content: 'hi' }], instructions: undefined, steps: [] })).toBeUndefined()
    expect(COMPACT_TRIGGER_RATIO).toBe(0.8)
  })
})
