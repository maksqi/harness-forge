// Types of the e2e fake remote (`fake-remote.mjs`, C53; its module comment is the reference): the Brave Search, Tavily
// and Exa APIs behind `HF_TEST_REMOTE_URL`. The specs import it to start an instance of their own (the screenshot
// server); the shared one runs next to the e2e server (`E2E_FAKE_REMOTE_PORT`, `helpers/web-search.ts`).

export declare const BRAVE_HOST: 'api.search.brave.com'
export declare const TAVILY_HOST: 'api.tavily.com'
export declare const EXA_HOST: 'api.exa.ai'
/** Answers 401. */
export declare const INVALID_KEY: 'invalid-key'
/** Answers 429. */
export declare const RATE_LIMITED_KEY: 'rate-limited'
export declare const REDACTED: '<redacted>'
export declare const RESULTS_MAX: number
export declare const DEFAULT_COUNTS: Readonly<{ brave: number, tavily: number, exa: number }>

export interface FakeSearchResult {
  title: string
  url: string
  snippet: string
  published: string
}

/** `Result one` `https://example.com/a`, `Result two` `https://example.org/b`, … (20). */
export declare const RESULTS: readonly FakeSearchResult[]

/** One request of the log (`GET /__log`): never a key header; a POST's JSON body with `api_key` redacted. */
export interface FakeRemoteLogEntry {
  method: string
  host: string
  /** The path with its query. */
  path: string
  status: number
  body?: unknown
}

export interface FakeSearchRemote {
  /** `http://127.0.0.1:<port>`. */
  url: string
  port: number
  log: () => FakeRemoteLogEntry[]
  reset: () => void
  stop: () => Promise<void>
}

export declare function startFakeSearchRemote(options?: { port?: number, host?: string }): Promise<FakeSearchRemote>
