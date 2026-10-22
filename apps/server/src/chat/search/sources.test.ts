// Smoke test of the P14-0b sources transform (C52-T7): a pass-through until W14.5 implements it.
import type { HarnessUIMessageChunk } from '../generated-files.ts'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../../logger.ts'
import { createSourcesTransform } from './sources.ts'

describe('createSourcesTransform (P14-0b stub)', () => {
  it('passes every chunk through unchanged', async () => {
    const chunks: HarnessUIMessageChunk[] = [
      { type: 'start' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'search_web', input: { query: 'cats' } },
      { type: 'tool-output-available', toolCallId: 'c1', output: { query: 'cats', backend: 'brave', results: [] } },
      { type: 'finish' },
    ]
    const source = new ReadableStream<HarnessUIMessageChunk>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(chunk)
        controller.close()
      },
    })
    const out: HarnessUIMessageChunk[] = []
    const reader = source.pipeThrough(createSourcesTransform({ toolOwner: () => 'core-search', continued: null, logger: createSilentLogger() })).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      out.push(value)
    }
    expect(out).toEqual(chunks)
  })
})
