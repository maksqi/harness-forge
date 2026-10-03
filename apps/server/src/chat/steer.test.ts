// Steering seams (Phase 9, C26-T5): `stepInjector` is complete (chunks injected at a step boundary land right before
// that step's `start-step`, in order, also when the consumer falls whole steps behind, and the rest is flushed when the
// stream ends); `createSteerStep` is a no-op piece until W9.2.
import type { HarnessUIMessageChunk } from './generated-files.ts'
import type { RunSession } from './pipeline.ts'
import type { StepInjectionSource } from './steer.ts'
import { describe, expect, it } from 'vitest'
import { createSteerStep, stepInjector } from './steer.ts'

/** The injection queue of `RunSession`, standing alone. */
function injections(): StepInjectionSource & { inject: (chunk: HarnessUIMessageChunk, step: number) => void } {
  let pending: { chunk: HarnessUIMessageChunk, step: number }[] = []
  return {
    inject: (chunk, step) => {
      pending.push({ chunk, step })
    },
    takeInjections: (finishedSteps) => {
      const ready = pending.filter(entry => entry.step <= finishedSteps).map(entry => entry.chunk)
      pending = pending.filter(entry => entry.step > finishedSteps)
      return ready
    },
  }
}

function steerChunk(n: number): HarnessUIMessageChunk {
  return { type: 'data-steer', data: { id: `msg_s00000000000000${n}`, parts: [{ type: 'text', text: `steer ${n}` }], queuedAt: 1, deliveredAt: 2 } }
}

function label(chunk: HarnessUIMessageChunk): string {
  return chunk.type === 'data-steer' ? `steer:${chunk.data.parts[0]?.type === 'text' ? chunk.data.parts[0].text : ''}` : chunk.type
}

async function readAll(stream: ReadableStream<HarnessUIMessageChunk>): Promise<string[]> {
  const labels: string[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      return labels
    labels.push(label(value))
  }
}

/** A source stream the test writes to; nothing reads it until the test does (a slow consumer). */
function controlledSource(): { stream: ReadableStream<HarnessUIMessageChunk>, write: (...chunks: HarnessUIMessageChunk[]) => void, close: () => void } {
  let controller!: ReadableStreamDefaultController<HarnessUIMessageChunk>
  const stream = new ReadableStream<HarnessUIMessageChunk>({
    start(c) {
      controller = c
    },
  })
  return { stream, write: (...chunks) => chunks.forEach(chunk => controller.enqueue(chunk)), close: () => controller.close() }
}

describe('stepInjector', () => {
  it('places the chunks of step N right before the start-step of step N, in order, while the consumer lags whole steps', async () => {
    const queue = injections()
    const source = controlledSource()
    const out = source.stream.pipeThrough(stepInjector(queue))
    // The SDK side runs ahead: step 0, the boundary of step 1, step 1, the boundary of step 2, step 2.
    source.write({ type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't0' }, { type: 'text-end', id: 't0' }, { type: 'finish-step' })
    queue.inject(steerChunk(1), 1)
    source.write({ type: 'start-step' }, { type: 'tool-input-available', toolCallId: 'c1', toolName: 'noop', input: {} }, { type: 'finish-step' })
    queue.inject(steerChunk(2), 2)
    queue.inject(steerChunk(3), 2)
    source.write({ type: 'start-step' }, { type: 'finish-step' }, { type: 'finish' })
    source.close()
    expect(await readAll(out)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-end',
      'finish-step',
      'steer:steer 1',
      'start-step',
      'tool-input-available',
      'finish-step',
      'steer:steer 2',
      'steer:steer 3',
      'start-step',
      'finish-step',
      'finish',
    ])
  })

  it('places step 0 chunks before the first start-step (after the tools an approval continuation runs first)', async () => {
    const queue = injections()
    queue.inject(steerChunk(1), 0)
    const source = controlledSource()
    const out = source.stream.pipeThrough(stepInjector(queue))
    source.write({ type: 'start' }, { type: 'tool-output-available', toolCallId: 'c0', output: 'ok' }, { type: 'start-step' }, { type: 'finish-step' }, { type: 'finish' })
    source.close()
    expect(await readAll(out)).toEqual(['start', 'tool-output-available', 'steer:steer 1', 'start-step', 'finish-step', 'finish'])
  })

  it('emits what is left before the finish chunk, or when the stream closes without one', async () => {
    const queue = injections()
    const source = controlledSource()
    const out = source.stream.pipeThrough(stepInjector(queue))
    source.write({ type: 'start' }, { type: 'start-step' }, { type: 'finish-step' })
    // Step 1 failed before its start-step.
    queue.inject(steerChunk(1), 1)
    source.write({ type: 'error', errorText: 'boom' }, { type: 'finish' })
    source.close()
    expect(await readAll(out)).toEqual(['start', 'start-step', 'finish-step', 'error', 'steer:steer 1', 'finish'])

    const aborted = injections()
    const cut = controlledSource()
    const rest = cut.stream.pipeThrough(stepInjector(aborted))
    cut.write({ type: 'start' }, { type: 'start-step' }, { type: 'finish-step' })
    aborted.inject(steerChunk(2), 1)
    aborted.inject(steerChunk(3), 5)
    cut.close()
    expect(await readAll(rest)).toEqual(['start', 'start-step', 'finish-step', 'steer:steer 2', 'steer:steer 3'])
    expect(aborted.takeInjections(Number.POSITIVE_INFINITY)).toEqual([])
  })

  it('passes a stream without injections through unchanged', async () => {
    const queue = injections()
    const source = controlledSource()
    const out = source.stream.pipeThrough(stepInjector(queue))
    source.write({ type: 'start' }, { type: 'start-step' }, { type: 'finish-step' }, { type: 'start-step' }, { type: 'finish-step' }, { type: 'finish' })
    source.close()
    expect(await readAll(out)).toEqual(['start', 'start-step', 'finish-step', 'start-step', 'finish-step', 'finish'])
  })
})

describe('createSteerStep (stub until W9.2)', () => {
  it('is a piece that changes nothing', async () => {
    const piece = createSteerStep({ session: {} as RunSession, model: {} as never, tools: {} })
    expect(await piece({ stepNumber: 0, messages: [{ role: 'user', content: 'hi' }], instructions: undefined, steps: [] })).toBeUndefined()
  })
})
