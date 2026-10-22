// The e2e fake remote of Phase 14 (ADR-063; C53-T5, FROZEN after Gate P14-0b; phase doc "Mock and fixture contract"):
// the Brave Search, Tavily and Exa APIs behind `HF_TEST_REMOTE_URL`, so the builtin `search_web` tool of `core-search`
// (and "Test search") never leaves loopback in the e2e specs and the gate probes. A standalone Node script: no
// TypeScript, no import from the repository, Node built-ins only; loopback only; no file writes.
//
// Run: `node e2e/fixtures/fake-remote.mjs [--port <n>] [--host 127.0.0.1]`. The port comes from `--port`, else the
// environment variable `E2E_FAKE_REMOTE_PORT`, else 0 (a free port; probes pass `--port 0`). The first stdout line is
// `{"url":"http://127.0.0.1:<port>"}`; SIGTERM / SIGINT stop it (exit 0). `GET /` answers 200 (the readiness URL of
// Playwright's `webServer`). Imported: `startFakeSearchRemote({ port?, host? })` → `{ url, port, log(), reset(), stop() }`.
//
// Layout (what the test-only `HF_TEST_REMOTE_URL` routing of `createPluginSourceFetch` requests: `https://<host>/<path>`
// becomes `<url>/<host>/<path>`):
// - `GET /api.search.brave.com/res/v1/web/search?q=…&count=…` (key: header `X-Subscription-Token`) → `{ type: 'search',
//   query: { original }, web: { type: 'search', results: [{ title, url, description, page_age, age }] } }`;
// - `POST /api.tavily.com/search` with a JSON body `{ query, max_results, … }` (key: `Authorization: Bearer <key>`, or a
//   body `api_key`) → `{ query, answer: null, images: [], follow_up_questions: null, results: [{ title, url, content,
//   score, raw_content: null, published_date }], response_time }`;
// - `POST /api.exa.ai/search` with a JSON body `{ query, numResults, … }` (key: header `x-api-key`, or `Authorization:
//   Bearer <key>`) → `{ requestId, resolvedSearchType, results: [{ id, title, url, publishedDate, author, highlights,
//   highlightScores }] }`;
// another method on these paths answers 405, any other path 404. Results are deterministic: `Result one`
// `https://example.com/a`, `Result two` `https://example.org/b`, `Result three` `https://example.com/c`, … (snippet
// `Snippet <n> of the fake search.`, published `2026-10-20` counting down), the requested count honored (Brave `count`,
// Tavily `max_results`, Exa `numResults`; 1 … 20; without one the vendor default: Brave 20, Tavily 5, Exa 10); the same
// list as `createFakeSearchFetch` (`apps/server/src/testing/fake-search.ts`). Keys: a missing key or the key `invalid-key`
// answers 401, the key `rate-limited` 429 (with `retry-after: 1`), in each vendor's error shape (never echoing the key).
//
// Test routes: `GET /__log` answers the request log, an array of `{ method, host, path, status, body? }` (the path with
// its query; `body` = the parsed JSON body of a POST, a body `api_key` replaced by `<redacted>`); key headers are never
// logged. `POST /__reset` clears the log.
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const BRAVE_HOST = 'api.search.brave.com'
export const TAVILY_HOST = 'api.tavily.com'
export const EXA_HOST = 'api.exa.ai'
export const INVALID_KEY = 'invalid-key'
export const RATE_LIMITED_KEY = 'rate-limited'
export const REDACTED = '<redacted>'
export const RESULTS_MAX = 20
export const DEFAULT_COUNTS = Object.freeze({ brave: 20, tavily: 5, exa: 10 })

const COUNT_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']

/** The deterministic results (20; see the module comment). */
export const RESULTS = Object.freeze(COUNT_WORDS.map((word, index) => Object.freeze({
  title: `Result ${word}`,
  url: `https://example.${index % 2 === 0 ? 'com' : 'org'}/${String.fromCharCode(97 + index)}`,
  snippet: `Snippet ${word} of the fake search.`,
  published: `2026-10-${String(20 - index).padStart(2, '0')}`,
})))

const ROUTES = [
  { backend: 'brave', host: BRAVE_HOST, path: '/res/v1/web/search', method: 'GET' },
  { backend: 'tavily', host: TAVILY_HOST, path: '/search', method: 'POST' },
  { backend: 'exa', host: EXA_HOST, path: '/search', method: 'POST' },
]

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const BODY_MAX_BYTES = 64 * 1024
const BEARER = /^bearer\s+(\S.*)$/i
const ERROR_TEXT = { 401: 'The API key is missing or invalid.', 429: 'Too many requests: the rate limit was exceeded.' }

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(value))
}

function vendorError(backend, status) {
  const text = ERROR_TEXT[status] ?? 'Error.'
  if (backend === 'brave')
    return { type: 'ErrorResponse', error: { id: 'fake-error', status, code: status === 401 ? 'SUBSCRIPTION_TOKEN_INVALID' : 'RATE_LIMITED', detail: text }, time: 0 }
  if (backend === 'tavily')
    return { detail: { error: text } }
  return { requestId: 'fake-error', error: text }
}

function answer(backend, query, results) {
  if (backend === 'brave') {
    return {
      type: 'search',
      query: { original: query },
      web: { type: 'search', results: results.map(result => ({ title: result.title, url: result.url, description: result.snippet, page_age: `${result.published}T00:00:00`, age: result.published })) },
    }
  }
  if (backend === 'tavily') {
    return {
      query,
      answer: null,
      images: [],
      follow_up_questions: null,
      results: results.map((result, index) => ({ title: result.title, url: result.url, content: result.snippet, score: Math.round((0.95 - index * 0.04) * 100) / 100, raw_content: null, published_date: result.published })),
      response_time: 0.42,
    }
  }
  return {
    requestId: 'fake-request',
    resolvedSearchType: 'neural',
    results: results.map(result => ({ id: result.url, title: result.title, url: result.url, publishedDate: `${result.published}T00:00:00.000Z`, author: null, highlights: [result.snippet], highlightScores: [0.5] })),
  }
}

function requestedCount(backend, url, body) {
  const raw = backend === 'brave' ? url.searchParams.get('count') : body?.[backend === 'tavily' ? 'max_results' : 'numResults']
  const count = Number(raw)
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(count))
    return DEFAULT_COUNTS[backend]
  return Math.min(RESULTS_MAX, Math.max(1, Math.trunc(count)))
}

function requestKey(backend, headers, body) {
  const header = typeof headers.authorization === 'string' ? headers.authorization : ''
  const bearer = header.match(BEARER)?.[1]?.trim() ?? null
  if (backend === 'brave')
    return typeof headers['x-subscription-token'] === 'string' ? headers['x-subscription-token'] : null
  if (backend === 'tavily')
    return bearer ?? (typeof body?.api_key === 'string' ? body.api_key : null)
  return typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : bearer
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        reject(Object.assign(new Error('The request body is too large.'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

/** Starts the fake remote on a loopback port (see the module comment). */
export async function startFakeSearchRemote(options = {}) {
  const host = options.host ?? '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host))
    throw new Error(`The fake remote listens on loopback only (got "${host}").`)
  const log = []

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://fake-remote.invalid')
    if (url.pathname === '/__log' && req.method === 'GET')
      return sendJson(res, 200, log)
    if (url.pathname === '/__reset' && req.method === 'POST') {
      log.length = 0
      return sendJson(res, 200, { ok: true })
    }
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD'))
      return sendJson(res, 200, { ok: true, name: 'fake-remote', hosts: ROUTES.map(route => route.host) })
    const slash = url.pathname.indexOf('/', 1)
    const remoteHost = slash < 0 ? url.pathname.slice(1) : url.pathname.slice(1, slash)
    const remotePath = slash < 0 ? '/' : url.pathname.slice(slash)
    const entry = { method: req.method ?? 'GET', host: remoteHost, path: `${remotePath}${url.search}`, status: 0 }
    log.push(entry)
    const reply = (status, value, headers) => {
      entry.status = status
      sendJson(res, status, value, headers)
    }
    const route = ROUTES.find(candidate => candidate.host === remoteHost && candidate.path === remotePath)
    if (route === undefined)
      return reply(404, { error: 'Not found.' })
    if (req.method !== route.method)
      return reply(405, { error: 'Method not allowed.' }, { allow: route.method })
    let body = null
    if (req.method === 'POST') {
      const text = await readBody(req)
      body = parseJson(text) ?? null
      entry.body = body !== null && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'api_key') ? { ...body, api_key: REDACTED } : (body ?? text)
    }
    const key = requestKey(route.backend, req.headers, body)
    if (key === null || key === '' || key === INVALID_KEY)
      return reply(401, vendorError(route.backend, 401))
    if (key === RATE_LIMITED_KEY)
      return reply(429, vendorError(route.backend, 429), { 'retry-after': '1' })
    const query = route.backend === 'brave' ? (url.searchParams.get('q') ?? '') : (typeof body?.query === 'string' ? body.query : '')
    reply(200, answer(route.backend, query, RESULTS.slice(0, requestedCount(route.backend, url, body))))
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent)
        sendJson(res, error?.status === 413 ? 413 : 500, { error: error instanceof Error ? error.message : String(error) })
      else
        res.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = server.address().port
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    log: () => log.map(entry => ({ ...entry })),
    reset: () => {
      log.length = 0
    },
    stop: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

function parseArgs(argv, env) {
  const options = { port: env.E2E_FAKE_REMOTE_PORT === undefined || env.E2E_FAKE_REMOTE_PORT === '' ? 0 : Number(env.E2E_FAKE_REMOTE_PORT), host: '127.0.0.1' }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = argv[index + 1]
    if ((flag === '--port' || flag === '--host') && value === undefined)
      throw new Error(`${flag} needs a value.`)
    if (flag === '--port')
      options.port = Number(value)
    else if (flag === '--host')
      options.host = value
    else
      throw new Error(`Unknown argument: ${flag}`)
    index++
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
    throw new Error('The port must be 0 … 65535.')
  return options
}

async function main() {
  const remote = await startFakeSearchRemote(parseArgs(process.argv.slice(2), process.env))
  const shutdown = () => {
    remote.stop().then(() => process.exit(0), () => process.exit(1))
  }
  // The handlers exist before the URL line: a caller may stop the script as soon as it has read it.
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  process.stdout.write(`${JSON.stringify({ url: remote.url })}\n`)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    process.stderr.write(`fake-remote: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
