// The compaction prompt (P9-0b stubs, C26-T5): not implemented until W9.1.
import { describe, expect, it } from 'vitest'
import { compactionInstructions, renderTranscript } from './prompt.ts'

describe('compaction prompt (stubs until W9.1)', () => {
  it('throws not_implemented', () => {
    expect(() => compactionInstructions('keep numbers')).toThrow(expect.objectContaining({ code: 'not_implemented' }))
    expect(() => renderTranscript([{ role: 'user', content: 'hi' }], 1000)).toThrow(expect.objectContaining({ code: 'not_implemented' }))
  })
})
