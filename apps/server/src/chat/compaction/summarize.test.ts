// The compaction summarizer (P9-0b stub, C26-T5): not implemented until W9.1.
import type { RunSession } from '../pipeline.ts'
import { describe, expect, it } from 'vitest'
import { summarizeHistory } from './summarize.ts'

describe('summarizeHistory (stub until W9.1)', () => {
  it('rejects with not_implemented', async () => {
    await expect(summarizeHistory({ session: {} as RunSession, runModel: {} as never, messages: [], focus: null, signal: new AbortController().signal }))
      .rejects
      .toMatchObject({ code: 'not_implemented' })
  })
})
