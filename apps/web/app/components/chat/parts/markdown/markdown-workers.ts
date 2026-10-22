// Off-thread Mermaid checks of `Markdown` (v1.8.1; docs/UI.md 4.4, 10.4). While a mermaid fence streams, markstream-vue
// asks a parser worker whether the partial diagram parses (`canParse`, `findPrefix`); with no worker set its client
// rejects with WORKER_INIT_ERROR, which the streaming block never retries, so when the fence completes the block keeps
// "Failed to render diagram: [mermaidWorkerClient] No worker instance set" until a reload (a reload renders the
// finished block without the worker). The first time a streaming renderer shows a mermaid fence, a main-thread
// stand-in is registered instead of a real worker: it answers every check with a plain error, and markstream then
// parses on the main thread, as it does whenever its worker cannot parse a diagram. The package's own parser worker is
// not used: its chunk is about 5 MB (one iife file), and inside a worker mermaid has no DOM for DOMPurify, so diagrams
// with labels (flowcharts) fail there and are parsed again on the main thread anyway. KaTeX needs nothing here: its
// client renders on the main thread when no KaTeX worker is set.
import { setMermaidWorker } from 'markstream-vue'

/** A fence opener with the `mermaid` language (backticks or tildes, any indentation, inside quotes or lists too). */
const MERMAID_FENCE = /(?:`{3,}|~{3,})[ \t]*mermaid/i

const UNAVAILABLE = 'Off-thread Mermaid parsing is unavailable'

let registered = false

/** The members of a worker the markstream client uses: `postMessage`, `terminate` and the handlers it assigns. */
interface ParserPort {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: unknown
  onmessageerror: unknown
  postMessage: (message: { id?: unknown }) => void
  terminate: () => void
}

/** Answers every request with `{ ok: false }`; the client turns that into a plain error (no worker error code). */
export function mainThreadStandIn(): Worker {
  const port: ParserPort = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      queueMicrotask(() => port.onmessage?.({ data: { id: message?.id, ok: false, error: UNAVAILABLE } }))
    },
    terminate() {},
  }
  return port as unknown as Worker
}

/**
 * Registers the main-thread stand-in the first time a streaming renderer (`final` false) shows a mermaid fence; a
 * final render never consults the worker. Called on every content change of every `Markdown`; idempotent.
 */
export function ensureMermaidWorker(content: string, final: boolean): void {
  if (registered || final || !MERMAID_FENCE.test(content))
    return
  registered = true
  setMermaidWorker(mainThreadStandIn())
}
