import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createRunRegistry, SseReplayBuffer, toActiveRun } from './runs.ts'

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

describe('run registry', () => {
  it('allows one run per chat and answers conflict (run-active) for a second one', () => {
    const registry = createRunRegistry(() => 1000)
    const run = registry.acquire('chat-a', 'mock:echo')
    expect(run).toMatchObject({ chatId: 'chat-a', modelRef: 'mock:echo', phase: 'preparing', messageId: null, acceptedAt: 1000 })
    expect(run.signal.aborted).toBe(false)
    let error: unknown
    try {
      registry.acquire('chat-a', 'mock:echo')
    }
    catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(HarnessError)
    expect((error as HarnessError).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: 'chat-a' } })
    expect(registry.acquire('chat-b', 'mock:echo').chatId).toBe('chat-b')
    expect(registry.list()).toHaveLength(2)
  })

  it('release frees the chat once, resolves settled and never removes a newer run', async () => {
    const registry = createRunRegistry()
    const first = registry.acquire('chat', 'mock:echo')
    expect(registry.release(first)).toBe(true)
    await first.settled
    expect(registry.release(first)).toBe(false)
    const second = registry.acquire('chat', 'mock:echo')
    expect(registry.release(first)).toBe(false)
    expect(registry.get('chat')).toBe(second)
  })

  it('reports only streaming runs as active', () => {
    const registry = createRunRegistry()
    const run = registry.acquire('chat', 'mock:echo')
    expect(toActiveRun(run)).toBeNull()
    run.phase = 'streaming'
    run.messageId = 'msg_0000000000000001'
    expect(toActiveRun(run)).toEqual({ runId: run.runId, chatId: 'chat', messageId: 'msg_0000000000000001', modelRef: 'mock:echo', startedAt: run.startedAt })
    run.phase = 'finishing'
    expect(toActiveRun(run)).toBeNull()
  })
})

describe('sseReplayBuffer', () => {
  it('replays every chunk from the first, then follows live chunks until closed', async () => {
    const buffer = new SseReplayBuffer()
    buffer.append('data: 1\n\n')
    const early = readAll(buffer.replay())
    buffer.append('data: 2\n\n')
    const late = buffer.replay()
    buffer.append('data: [DONE]\n\n')
    buffer.close()
    buffer.append('ignored')
    expect(await early).toBe('data: 1\n\ndata: 2\n\ndata: [DONE]\n\n')
    expect(await readAll(late)).toBe('data: 1\n\ndata: 2\n\ndata: [DONE]\n\n')
    expect(buffer.closed).toBe(true)
    expect(buffer.size).toBe(3)
  })

  it('consumes a stream and closes on its end or error', async () => {
    const buffer = new SseReplayBuffer()
    await buffer.consume(new ReadableStream<string>({
      start(controller) {
        controller.enqueue('a')
        controller.enqueue('b')
        controller.close()
      },
    }))
    expect(await readAll(buffer.replay())).toBe('ab')

    const failing = new SseReplayBuffer()
    const errors: unknown[] = []
    let pulls = 0
    await failing.consume(new ReadableStream<string>({
      pull(controller) {
        pulls += 1
        if (pulls === 1)
          controller.enqueue('x')
        else
          controller.error(new Error('broken'))
      },
    }), error => errors.push(error))
    expect(failing.closed).toBe(true)
    expect(errors).toHaveLength(1)
    expect(await readAll(failing.replay())).toBe('x')
  })

  it('a cancelled replay reader does not affect the buffer', async () => {
    const buffer = new SseReplayBuffer()
    buffer.append('one')
    const reader = buffer.replay().getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('one')
    await reader.cancel()
    buffer.append('two')
    buffer.close()
    expect(await readAll(buffer.replay())).toBe('onetwo')
  })

  it('answers with the UI message stream headers', () => {
    const buffer = new SseReplayBuffer()
    const response = buffer.toResponse()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    buffer.close()
  })
})
