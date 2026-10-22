// Mermaid stand-in registration (markdown-workers.ts): once, only for a streaming mermaid fence. The contract part runs
// the installed markstream client.
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ setMermaidWorker: vi.fn() }))

vi.mock('markstream-vue', () => ({ setMermaidWorker: mocks.setMermaidWorker }))

const STREAMING_FENCE = 'A diagram:\n\n```mermaid\ngraph TD\n  A --> B'

/** A fresh copy of the module: the registration flag lives at module level. */
async function freshModule(): Promise<typeof import('./markdown-workers')> {
  vi.resetModules()
  return import('./markdown-workers')
}

afterEach(() => {
  mocks.setMermaidWorker.mockReset()
})

describe('ensureMermaidWorker', () => {
  it('registers nothing for final content or content without a mermaid fence', async () => {
    const { ensureMermaidWorker } = await freshModule()
    ensureMermaidWorker(STREAMING_FENCE, true)
    ensureMermaidWorker('```ts\nconst mermaid = 1', false)
    ensureMermaidWorker('Mermaid diagrams are supported.', false)
    expect(mocks.setMermaidWorker).not.toHaveBeenCalled()
  })

  it('registers the stand-in once for a streaming fence, however many renderers ask', async () => {
    const { ensureMermaidWorker } = await freshModule()
    ensureMermaidWorker(STREAMING_FENCE, false)
    ensureMermaidWorker(`${STREAMING_FENCE}\n  B --> C`, false)
    ensureMermaidWorker('~~~ Mermaid\nsequenceDiagram', false)
    expect(mocks.setMermaidWorker).toHaveBeenCalledTimes(1)
    const standIn = mocks.setMermaidWorker.mock.calls[0]![0] as Worker
    expect(typeof standIn.postMessage).toBe('function')
    expect(() => standIn.terminate()).not.toThrow()
  })

  it('recognizes fences inside quotes and lists and with longer markers', async () => {
    for (const content of ['> ```mermaid\n> graph LR', '- item\n\n    ````MERMAID\n    pie', '~~~mermaid']) {
      const { ensureMermaidWorker } = await freshModule()
      mocks.setMermaidWorker.mockClear()
      ensureMermaidWorker(content, false)
      expect(mocks.setMermaidWorker, content).toHaveBeenCalledTimes(1)
    }
  })
})

describe('mermaid worker client contract (installed markstream-vue)', () => {
  it('fails without a worker with WORKER_INIT_ERROR and with a plain error behind the stand-in', async () => {
    const { mainThreadStandIn } = await freshModule()
    const client = await import('markstream-vue/workers/mermaidWorkerClient')
    const code = 'graph TD\n  A --> B'

    // The error code the streaming Mermaid block turns into "Failed to render diagram" (the bug this module fixes).
    client.clearMermaidWorker()
    await expect(client.canParseOffthread(code, 'dark')).rejects.toMatchObject({ code: 'WORKER_INIT_ERROR' })

    // Behind the stand-in every check fails fast without a worker error code: the block parses on the main thread.
    client.setMermaidWorker(mainThreadStandIn())
    const parseError: unknown = await client.canParseOffthread(code, 'dark').catch((error: unknown) => error)
    const prefixError: unknown = await client.findPrefixOffthread(`${code}\n  B -->`, 'light').catch((error: unknown) => error)
    for (const error of [parseError, prefixError]) {
      expect(error).toBeInstanceOf(Error)
      expect((error as { code?: unknown }).code).toBeUndefined()
      expect((error as Error).message).toBe('Off-thread Mermaid parsing is unavailable')
    }
    expect(client.getMermaidWorkerLoad().inFlight).toBe(0)
    client.clearMermaidWorker()
  })
})
