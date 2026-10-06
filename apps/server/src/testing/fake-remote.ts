// The fake remote of the Phase 12 tests, gate probes and e2e specs (ADR-054, ARCHITECTURE.md 6.34; C45-T2, FROZEN after
// Gate P12-0b; phase doc "Mock and fixture contract"): GitHub (`api.github.com`, `raw.githubusercontent.com`,
// `codeload.github.com`), archive hosts and the npm registry, served from memory. Nothing here touches the network.
//
// One in-memory model (`createFakeRemoteRoutes`) has two front ends:
// - `startFakeRemote()`: a loopback HTTP server on 127.0.0.1, port 0, serving `<url>/<host>/<path>` (the layout the
//   test-only `HF_TEST_REMOTE_URL` routing of `security/ssrf.ts` rewrites every `https://<host>/<path>` to); started by
//   tests and probes, stopped with `close()`;
// - `createFakeSafeFetch(routes)`: a `SafeFetch` for unit tests that maps `https://<host>/<path>` to the same model,
//   records every call and refuses every host the model does not serve (like the SSRF guard refuses a private one).
// Both append each answered request to `routes.requests` (`{ method, host, path, status }`, path with its query), so a
// probe can assert that this log is the only network.
//
// What the model serves (paths below the host):
// - `api.github.com` `GET /repos/{owner}/{repo}/commits/{ref}`: with `Accept: application/vnd.github.sha` the 40-hex
//   sha as text, otherwise a small JSON commit (`{ sha, … }`); `{ref}` is a branch, a tag, `HEAD` (the default branch),
//   `refs/heads/…` / `refs/tags/…` or a sha (or a unique prefix of 7+ hex). An unknown repository answers 404, an
//   unknown ref 422 (`No commit found for SHA: …`, as GitHub does). The rate-limit switch (`setRateLimited(true)`)
//   answers every API request with 403 and `x-ratelimit-remaining: 0` (`x-ratelimit-reset` = epoch seconds); raw and
//   codeload are not rate-limited (the codeload fallback keeps working).
// - `raw.githubusercontent.com` `GET /{owner}/{repo}/{sha | ref | refs/heads/{ref}}/{path}`: the file at that commit
//   (`404: Not Found` otherwise).
// - `codeload.github.com` `GET /{owner}/{repo}/zip/{sha | ref}` and `/zip/refs/heads/{ref}` (also `refs/tags/{tag}`):
//   the commit's zip from `githubZipOf`: every entry below one top folder `<repo>-<name>/` (`<name>` = the requested
//   sha, or the ref with `/` turned into `-` for a ref request, as codeload names them), folder entries included, Unix
//   modes (0644, 0755 for executable files), the zip comment = the commit sha. Never a redirect.
// - archive hosts and hosted files: whatever `serve(url, …)` registered (bytes, text, or a full response such as a
//   redirect); a served URL wins over the built-in routes.
// - `registry.npmjs.org`: `GET /{name}` (`@scope/name` or `@scope%2Fname`) the packument of a registered package and
//   `GET /{name}/-/{file}.tgz` its tarballs (`package/…` entries, `dist.integrity` = sha512). The tarball URLs of a
//   packument point at the same origin the packument was served from (`<url>/registry.npmjs.org/…` behind the HTTP
//   server), as the npm pipeline requires.
// Repositories are registered with `commit(repo, files, options)`: each commit has its own files and sha, the default
// branch moves to every new commit (unless `refs` says otherwise) and `moveRef` moves any branch or tag later. Archive
// variants of a commit (`variant`): `oversize` (a body of `LIMITS.repoArchiveBytes + 1` zero bytes with that
// `content-length`), `traversal` (an extra `<top>/../../evil.txt` entry), `link` (an extra symbolic link entry
// `<top>/link` → `/etc/passwd`), `wrong-comment` (another 40-hex sha as the zip comment), `wrong-top-folder` (the top
// folder `<repo>-wrong/`). Every other request answers 404; methods other than GET and HEAD answer 405.
//
// Light on purpose (Node built-ins, `fflate`, the shared package): probes and e2e specs import it directly.
import type { AddressInfo } from 'node:net'
import type { SafeFetch, SafeFetchOptions, SafeFetchResult } from '../security/types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { zipSync } from 'fflate'

// ---------- hosts and shapes ----------

export const GITHUB_API_HOST = 'api.github.com'
export const GITHUB_RAW_HOST = 'raw.githubusercontent.com'
export const GITHUB_CODELOAD_HOST = 'codeload.github.com'
export const NPM_REGISTRY_HOST = 'registry.npmjs.org'

/** The default branch of a repository registered without one. */
export const FAKE_DEFAULT_BRANCH = 'main'
/** `x-ratelimit-limit` of the rate-limited API (GitHub's unauthenticated limit). */
export const FAKE_RATE_LIMIT = 60

/** A file of a commit, a fixture or an npm package: text or bytes, optionally with a Unix permission mode (default 0644). */
export type FakeFile = string | Uint8Array | { readonly content: string | Uint8Array, readonly mode?: number }
/** Files by POSIX path relative to the repository (or package) root. */
export type FakeFiles = Readonly<Record<string, FakeFile>>

export const FAKE_ARCHIVE_VARIANTS = ['oversize', 'traversal', 'link', 'wrong-comment', 'wrong-top-folder'] as const
export type FakeArchiveVariant = (typeof FAKE_ARCHIVE_VARIANTS)[number]

export interface FakeCommitOptions {
  /** The commit sha (40 hex, lowercased); default: a deterministic sha1 of the repository, a counter and the files. */
  readonly sha?: string
  /** Branches or tags moved to this commit (default: the default branch; `[]` adds a commit no ref points at). */
  readonly refs?: readonly string[]
  /** How codeload serves this commit's zip (default: a correct archive). */
  readonly variant?: FakeArchiveVariant
}

/** A registered response (`serve`): status 200 and no headers by default. */
export interface FakeServedResponse {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
}

/** A body the front ends stream as zero bytes without allocating it (the `oversize` variant). */
export interface FakeZeroBody {
  readonly zeros: number
}

export interface FakeResponse {
  readonly status: number
  /** Lowercase header names. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array | FakeZeroBody
}

/** One answered request (the log of both front ends). */
export interface FakeRemoteRequest {
  readonly method: string
  readonly host: string
  /** The path below the host, with its query string. */
  readonly path: string
  readonly status: number
}

export interface FakeRequest {
  readonly method: string
  readonly host: string
  /** The path below the host (starting with `/`), with its query string. */
  readonly path: string
  /** Lowercase names. */
  readonly headers?: Readonly<Record<string, string | undefined>>
}

export interface FakeNpmVersion {
  readonly files?: FakeFiles
  /** A raw `.tgz` (overrides `files`). */
  readonly tarball?: Uint8Array
  /** The published `dist.integrity` (default: the sha512 of the tarball; null publishes none). */
  readonly integrity?: string | null
  readonly deprecated?: string
}

export interface FakeRemoteRoutes {
  /** Every answered request, in order. */
  readonly requests: FakeRemoteRequest[]
  /** Registers `owner/repo` (idempotent; `defaultBranch` applies to a new repository only). */
  readonly repo: (repo: string, options?: { readonly defaultBranch?: string }) => void
  /** Adds a commit with its files (registers the repository when needed) and returns its sha. */
  readonly commit: (repo: string, files: FakeFiles, options?: FakeCommitOptions) => string
  /** Moves a branch or tag (`main`, `v1`, `refs/heads/main`) to a registered commit. */
  readonly moveRef: (repo: string, ref: string, sha: string) => void
  /** The commit a ref, `HEAD` or a sha (or a unique prefix of 7+ hex) names; null when unknown. */
  readonly resolve: (repo: string, ref: string) => string | null
  /** The GitHub API answers 403 with `x-ratelimit-remaining: 0` while limited. */
  readonly setRateLimited: (limited: boolean, options?: { readonly resetAt?: number }) => void
  /** Serves `response` (bytes, text or a full response) at an absolute https URL (archive hosts, hosted files). */
  readonly serve: (url: string, response: string | Uint8Array | FakeServedResponse) => void
  /** Registers an npm package on `registry.npmjs.org` (`tags` default: `latest` = the last version). */
  readonly npmPackage: (name: string, versions: Readonly<Record<string, FakeNpmVersion>>, tags?: Readonly<Record<string, string>>) => void
  /**
   * Answers one request and logs it; null (not logged) when no route serves the host. `origin` is where the request
   * came in (`https://registry.npmjs.org` by default; `<url>/registry.npmjs.org` behind the HTTP server), for the
   * tarball URLs of packuments.
   */
  readonly handle: (request: FakeRequest, context?: { readonly npmOrigin?: string }) => FakeResponse | null
}

// ---------- archives ----------

const encoder = new TextEncoder()
const ZIP_MTIME = new Date(Date.UTC(2024, 0, 1))
const MODE_FILE = 0o100000
const MODE_DIR = 0o040000
const MODE_LINK = 0o120000
const SHA_PATTERN = /^[\da-f]{40}$/
const SHA_PREFIX_PATTERN = /^[\da-f]{7,40}$/
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? encoder.encode(content) : content
}

/** The content and the permission bits (default 0644) of a file entry. */
export function fakeFileEntry(file: FakeFile): { content: Uint8Array, mode: number } {
  if (typeof file === 'string' || file instanceof Uint8Array)
    return { content: bytesOf(file), mode: 0o644 }
  return { content: bytesOf(file.content), mode: (file.mode ?? 0o644) & 0o7777 }
}

function checkedPath(path: string): string {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))
    throw new TypeError(`The fake file path ${JSON.stringify(path)} must be a plain relative POSIX path.`)
  return path
}

/** Sets the archive comment of a zip whose end record has none (fflate writes none). */
function withZipComment(zip: Uint8Array, comment: string): Uint8Array {
  const text = encoder.encode(comment)
  const out = new Uint8Array(zip.length + text.length)
  out.set(zip)
  out.set(text, zip.length)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint16(zip.length - 2, text.length, true)
  return out
}

export interface GithubZipOptions {
  /** The top folder without the slash (default `<repo name>-<sha>`). */
  readonly topFolder?: string
  /** The archive comment (default: the sha; null writes none). */
  readonly comment?: string | null
  /** A broken archive (`oversize` is not a zip: the front ends serve it, so it is ignored here). */
  readonly variant?: FakeArchiveVariant
}

/** Another valid sha (the `wrong-comment` variant). */
function otherSha(sha: string): string {
  return createHash('sha1').update(`wrong:${sha}`).digest('hex')
}

/**
 * A zip as `codeload.github.com` serves it: every file below the top folder `<repo name>-<sha>/` (`repo` is `owner/name`
 * or `name`), folder entries first, Unix modes (`0o100644`, the mode bits of `FakeFile` kept: 0755 stays executable),
 * a fixed date, the zip comment = the sha. Re-exported by `plugins/install/testing.ts` next to `zipOf`.
 */
export function githubZipOf(repo: string, sha: string, files: FakeFiles, options: GithubZipOptions = {}): Uint8Array {
  const name = repo.split('/').pop() ?? repo
  const variant = options.variant
  const top = `${variant === 'wrong-top-folder' ? `${name}-wrong` : (options.topFolder ?? `${name}-${sha}`)}/`
  const entries: Record<string, [Uint8Array, { os: number, attrs: number, level: 0 | 6 }]> = {}
  const folders = new Set<string>([top])
  for (const path of Object.keys(files).sort()) {
    const segments = checkedPath(path).split('/')
    for (let index = 1; index < segments.length; index++)
      folders.add(`${top}${segments.slice(0, index).join('/')}/`)
  }
  for (const folder of [...folders].sort())
    entries[folder] = [new Uint8Array(0), { os: 3, attrs: ((MODE_DIR | 0o755) << 16) >>> 0, level: 0 }]
  for (const path of Object.keys(files).sort()) {
    const { content, mode } = fakeFileEntry(files[path]!)
    entries[`${top}${path}`] = [content, { os: 3, attrs: ((MODE_FILE | mode) << 16) >>> 0, level: 6 }]
  }
  if (variant === 'traversal')
    entries[`${top}../../evil.txt`] = [encoder.encode('outside the plugin\n'), { os: 3, attrs: ((MODE_FILE | 0o644) << 16) >>> 0, level: 6 }]
  if (variant === 'link')
    entries[`${top}link`] = [encoder.encode('/etc/passwd'), { os: 3, attrs: ((MODE_LINK | 0o777) << 16) >>> 0, level: 0 }]
  const zip = zipSync(entries, { mtime: ZIP_MTIME })
  const comment = variant === 'wrong-comment' ? otherSha(sha) : options.comment === undefined ? sha : options.comment
  return comment === null ? zip : withZipComment(zip, comment)
}

/** A gzipped ustar archive of regular files (npm tarballs: pass paths below `package/`). */
export function fakeTgzOf(files: FakeFiles): Uint8Array {
  const blocks: Buffer[] = []
  for (const path of Object.keys(files).sort()) {
    const { content, mode } = fakeFileEntry(files[path]!)
    const header = Buffer.alloc(512)
    header.write(checkedPath(path).slice(0, 100), 0, 100, 'utf8')
    header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('14567342000\0', 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header)
      sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, Buffer.from(content))
    if (content.length % 512 !== 0)
      blocks.push(Buffer.alloc(512 - (content.length % 512)))
  }
  blocks.push(Buffer.alloc(1024))
  return new Uint8Array(gzipSync(Buffer.concat(blocks)))
}

// ---------- the model ----------

interface FakeCommit {
  readonly sha: string
  readonly files: ReadonlyMap<string, { content: Uint8Array, mode: number }>
  readonly source: FakeFiles
  readonly variant?: FakeArchiveVariant
}

interface FakeRepository {
  readonly defaultBranch: string
  readonly commits: Map<string, FakeCommit>
  readonly refs: Map<string, string>
}

interface FakeNpmPackage {
  readonly versions: ReadonlyMap<string, { tarball: Uint8Array, integrity: string | null, deprecated?: string }>
  readonly tags: Readonly<Record<string, string>>
}

const JSON_TYPE = 'application/json; charset=utf-8'
const TEXT_TYPE = 'text/plain; charset=utf-8'

function textResponse(status: number, text: string, type = TEXT_TYPE, headers: Record<string, string> = {}): FakeResponse {
  return { status, headers: { 'content-type': type, ...headers }, body: encoder.encode(text) }
}

function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): FakeResponse {
  return textResponse(status, JSON.stringify(value), JSON_TYPE, headers)
}

const NOT_FOUND = (): FakeResponse => jsonResponse(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' })

function checkedRepo(repo: string): string {
  if (!REPO_PATTERN.test(repo))
    throw new TypeError(`The fake repository ${JSON.stringify(repo)} must be "owner/name".`)
  return repo.toLowerCase()
}

/** `refs/heads/x` and `refs/tags/x` name `x`. */
function bareRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, '')
}

function decodeSegments(path: string): string[] {
  return path.split('/').filter(segment => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment)
    }
    catch {
      return segment
    }
  })
}

function splitQuery(path: string): { pathname: string, query: string } {
  const index = path.indexOf('?')
  return index === -1 ? { pathname: path, query: '' } : { pathname: path.slice(0, index), query: path.slice(index) }
}

function normalizedUrlKey(url: string): string {
  if (!URL.canParse(url))
    throw new TypeError(`The fake URL ${JSON.stringify(url)} is not an absolute URL.`)
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:')
    throw new TypeError(`The fake URL ${JSON.stringify(url)} must be an https URL.`)
  return `${parsed.host}${parsed.pathname}${parsed.search}`
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** The in-memory model both front ends serve (see the module comment). */
export function createFakeRemoteRoutes(): FakeRemoteRoutes {
  const requests: FakeRemoteRequest[] = []
  const repos = new Map<string, FakeRepository>()
  const served = new Map<string, FakeServedResponse>()
  const servedHosts = new Set<string>()
  const npm = new Map<string, FakeNpmPackage>()
  let commits = 0
  let rateLimitedUntil: number | null = null

  function repository(repo: string, options: { defaultBranch?: string } = {}): FakeRepository {
    const key = checkedRepo(repo)
    let entry = repos.get(key)
    if (entry === undefined) {
      entry = { defaultBranch: options.defaultBranch ?? FAKE_DEFAULT_BRANCH, commits: new Map(), refs: new Map() }
      repos.set(key, entry)
    }
    return entry
  }

  function resolveIn(entry: FakeRepository, ref: string): string | null {
    const wanted = ref === 'HEAD' ? entry.defaultBranch : bareRef(ref)
    const named = entry.refs.get(wanted)
    if (named !== undefined)
      return named
    const lower = wanted.toLowerCase()
    if (SHA_PATTERN.test(lower) && entry.commits.has(lower))
      return lower
    if (SHA_PREFIX_PATTERN.test(lower)) {
      const matches = [...entry.commits.keys()].filter(sha => sha.startsWith(lower))
      if (matches.length === 1)
        return matches[0]!
    }
    return null
  }

  const routes: FakeRemoteRoutes = {
    requests,
    repo(repo, options) {
      repository(repo, options)
    },
    commit(repo, files, options = {}) {
      const entry = repository(repo)
      const map = new Map<string, { content: Uint8Array, mode: number }>()
      for (const path of Object.keys(files).sort())
        map.set(checkedPath(path), fakeFileEntry(files[path]!))
      commits++
      let sha = options.sha?.toLowerCase()
      if (sha === undefined) {
        const hash = createHash('sha1').update(`${checkedRepo(repo)}\n${commits}\n`)
        for (const [path, file] of map)
          hash.update(`${path}\n${file.mode}\n`).update(file.content)
        sha = hash.digest('hex')
      }
      if (!SHA_PATTERN.test(sha))
        throw new TypeError(`The fake commit sha ${JSON.stringify(options.sha)} must be 40 hex characters.`)
      entry.commits.set(sha, { sha, files: map, source: files, ...(options.variant === undefined ? {} : { variant: options.variant }) })
      for (const ref of options.refs ?? [entry.defaultBranch])
        entry.refs.set(bareRef(ref), sha)
      return sha
    },
    moveRef(repo, ref, sha) {
      const entry = repository(repo)
      const target = sha.toLowerCase()
      if (!entry.commits.has(target))
        throw new TypeError(`The fake repository ${repo} has no commit ${sha}.`)
      entry.refs.set(bareRef(ref), target)
    },
    resolve(repo, ref) {
      const entry = repos.get(checkedRepo(repo))
      return entry === undefined ? null : resolveIn(entry, ref)
    },
    setRateLimited(limited, options = {}) {
      rateLimitedUntil = limited ? (options.resetAt ?? Math.floor(Date.now() / 1000) + 3600) : null
    },
    serve(url, response) {
      const key = normalizedUrlKey(url)
      served.set(key, typeof response === 'string' || response instanceof Uint8Array ? { body: response } : response)
      servedHosts.add(new URL(url).host)
    },
    npmPackage(name, versions, tags) {
      const map = new Map<string, { tarball: Uint8Array, integrity: string | null, deprecated?: string }>()
      for (const [version, spec] of Object.entries(versions)) {
        const packaged = Object.fromEntries(Object.entries(spec.files ?? {}).map(([path, file]) => [`package/${path}`, file]))
        const tarball = spec.tarball ?? fakeTgzOf(packaged)
        map.set(version, { tarball, integrity: spec.integrity === undefined ? sha512Integrity(tarball) : spec.integrity, ...(spec.deprecated === undefined ? {} : { deprecated: spec.deprecated }) })
      }
      npm.set(name, { versions: map, tags: tags ?? { latest: Object.keys(versions).at(-1) ?? '' } })
    },
    handle(request, context = {}) {
      const response = answer(request, context.npmOrigin ?? `https://${NPM_REGISTRY_HOST}`)
      if (response !== null)
        requests.push({ method: request.method, host: request.host, path: request.path, status: response.status })
      return response
    },
  }

  function answer(request: FakeRequest, npmOrigin: string): FakeResponse | null {
    const host = request.host.toLowerCase()
    const known = host === GITHUB_API_HOST || host === GITHUB_RAW_HOST || host === GITHUB_CODELOAD_HOST || host === NPM_REGISTRY_HOST || servedHosts.has(host)
    if (!known)
      return null
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return textResponse(405, 'Method Not Allowed')
    const registered = served.get(`${host}${request.path}`)
    if (registered !== undefined) {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(registered.headers ?? {}))
        headers[name.toLowerCase()] = value
      return { status: registered.status ?? 200, headers: { 'content-type': 'application/octet-stream', ...headers }, body: bytesOf(registered.body ?? '') }
    }
    const { pathname } = splitQuery(request.path)
    const segments = decodeSegments(pathname)
    switch (host) {
      case GITHUB_API_HOST:
        return githubApi(segments, request.headers ?? {})
      case GITHUB_RAW_HOST:
        return githubRaw(segments)
      case GITHUB_CODELOAD_HOST:
        return codeload(segments)
      case NPM_REGISTRY_HOST:
        return npmRegistry(pathname, npmOrigin)
      default:
        return textResponse(404, 'Not Found')
    }
  }

  function repoOf(owner: string | undefined, name: string | undefined): FakeRepository | null {
    if (owner === undefined || name === undefined || !REPO_PATTERN.test(`${owner}/${name}`))
      return null
    return repos.get(`${owner}/${name}`.toLowerCase()) ?? null
  }

  function githubApi(segments: string[], headers: Readonly<Record<string, string | undefined>>): FakeResponse {
    if (rateLimitedUntil !== null) {
      return jsonResponse(403, { message: 'API rate limit exceeded for 127.0.0.1.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' }, {
        'x-ratelimit-limit': String(FAKE_RATE_LIMIT),
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(rateLimitedUntil),
        'x-ratelimit-used': String(FAKE_RATE_LIMIT),
      })
    }
    const [root, owner, name, what, ...rest] = segments
    if (root !== 'repos' || what !== 'commits' || rest.length === 0)
      return NOT_FOUND()
    const entry = repoOf(owner, name)
    if (entry === null)
      return NOT_FOUND()
    const ref = rest.join('/')
    const sha = resolveIn(entry, ref)
    if (sha === null)
      return jsonResponse(422, { message: `No commit found for SHA: ${ref}`, documentation_url: 'https://docs.github.com/rest/commits/commits#get-a-commit', status: '422' })
    const accept = (headers.accept ?? '').toLowerCase()
    if (accept.includes('application/vnd.github.sha'))
      return textResponse(200, sha, 'application/vnd.github.sha; charset=utf-8')
    return jsonResponse(200, { sha, commit: { message: 'Fake commit' }, html_url: `https://github.com/${owner}/${name}/commit/${sha}` })
  }

  function githubRaw(segments: string[]): FakeResponse {
    const [owner, name, ...rest] = segments
    const entry = repoOf(owner, name)
    if (entry === null)
      return textResponse(404, '404: Not Found')
    const refLength = rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') ? 3 : 1
    const sha = resolveIn(entry, rest.slice(0, refLength).join('/'))
    const file = sha === null ? undefined : entry.commits.get(sha)?.files.get(rest.slice(refLength).join('/'))
    if (file === undefined)
      return textResponse(404, '404: Not Found')
    return { status: 200, headers: { 'content-type': TEXT_TYPE }, body: file.content }
  }

  function codeload(segments: string[]): FakeResponse {
    const [owner, name, kind, ...rest] = segments
    const entry = repoOf(owner, name)
    if (entry === null || kind !== 'zip' || rest.length === 0)
      return textResponse(404, 'Not Found')
    const isRef = rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') && rest.length > 2
    const requested = isRef ? rest.slice(2).join('/') : rest.join('/')
    const sha = resolveIn(entry, requested)
    const commit = sha === null ? undefined : entry.commits.get(sha)
    if (commit === undefined || name === undefined)
      return textResponse(404, 'Not Found')
    if (commit.variant === 'oversize')
      return { status: 200, headers: { 'content-type': 'application/zip', 'content-length': String(LIMITS.repoArchiveBytes + 1) }, body: { zeros: LIMITS.repoArchiveBytes + 1 } }
    const label = !isRef && SHA_PATTERN.test(requested.toLowerCase()) ? commit.sha : requested.replaceAll('/', '-')
    const zip = githubZipOf(name, commit.sha, commit.source, {
      topFolder: `${name}-${label}`,
      ...(commit.variant === undefined ? {} : { variant: commit.variant }),
    })
    return {
      status: 200,
      headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename=${name}-${label}.zip` },
      body: zip,
    }
  }

  function npmRegistry(pathname: string, origin: string): FakeResponse {
    let path = pathname.replace(/^\/+/, '')
    try {
      path = decodeURIComponent(path)
    }
    catch {
      return jsonResponse(404, { error: 'Not found' })
    }
    const tarballAt = path.indexOf('/-/')
    if (tarballAt === -1) {
      const pkg = npm.get(path)
      if (pkg === undefined)
        return jsonResponse(404, { error: 'Not found' })
      const versions: Record<string, unknown> = {}
      for (const [version, spec] of pkg.versions) {
        versions[version] = {
          name: path,
          version,
          dist: { tarball: `${origin}/${path}/-/${path.split('/').pop()}-${version}.tgz`, ...(spec.integrity === null ? {} : { integrity: spec.integrity }) },
          ...(spec.deprecated === undefined ? {} : { deprecated: spec.deprecated }),
        }
      }
      return jsonResponse(200, { 'name': path, 'dist-tags': pkg.tags, versions })
    }
    const name = path.slice(0, tarballAt)
    const file = path.slice(tarballAt + 3)
    const pkg = npm.get(name)
    const base = name.split('/').pop() ?? name
    for (const [version, spec] of pkg?.versions ?? []) {
      if (file === `${base}-${version}.tgz`)
        return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: spec.tarball }
    }
    return jsonResponse(404, { error: 'Not found' })
  }

  return routes
}

// ---------- the HTTP front end ----------

export interface FakeRemote {
  /** `http://127.0.0.1:<port>`: the value of `HF_TEST_REMOTE_URL`. */
  readonly url: string
  readonly port: number
  readonly routes: FakeRemoteRoutes
  /** `routes.requests`: every answered request (unknown hosts are logged with status 502). */
  readonly requests: readonly FakeRemoteRequest[]
  /** Stops the server and drops its connections. */
  readonly close: () => Promise<void>
}

const ZERO_CHUNK = new Uint8Array(64 * 1024)

/** Starts the loopback server (127.0.0.1, port 0) that serves `routes` under `<url>/<host>/<path>`. */
export async function startFakeRemote(options: { readonly routes?: FakeRemoteRoutes } = {}): Promise<FakeRemote> {
  const routes = options.routes ?? createFakeRemoteRoutes()
  let base = ''
  const server = createServer((req, res) => {
    res.on('error', () => {})
    req.socket.on('error', () => {})
    const raw = req.url ?? '/'
    const slash = raw.indexOf('/', 1)
    const host = (slash === -1 ? raw.slice(1) : raw.slice(1, slash)).split('?')[0]!.toLowerCase()
    const path = slash === -1 ? '/' : raw.slice(slash)
    const headers: Record<string, string | undefined> = {}
    for (const [name, value] of Object.entries(req.headers))
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    const method = req.method ?? 'GET'
    const response = routes.handle({ method, host, path, headers }, { npmOrigin: `${base}/${NPM_REGISTRY_HOST}` })
    if (response === null) {
      routes.requests.push({ method, host, path, status: 502 })
      res.writeHead(502, { 'content-type': TEXT_TYPE })
      res.end(`The fake remote does not serve ${host || 'this request'}.`)
      return
    }
    const body = response.body
    const length = body instanceof Uint8Array ? body.length : body.zeros
    res.writeHead(response.status, { 'content-length': String(length), ...response.headers })
    if (method === 'HEAD') {
      res.end()
      return
    }
    if (body instanceof Uint8Array) {
      res.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
      return
    }
    let left = body.zeros
    const pump = (): void => {
      while (left > 0 && !res.destroyed) {
        const size = Math.min(left, ZERO_CHUNK.length)
        left -= size
        if (!res.write(ZERO_CHUNK.subarray(0, size))) {
          res.once('drain', pump)
          return
        }
      }
      if (!res.destroyed)
        res.end()
    }
    pump()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  return {
    url: base,
    port,
    routes,
    requests: routes.requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

// ---------- the SafeFetch front end ----------

export interface FakeSafeFetchCall {
  readonly url: string
  readonly options: SafeFetchOptions
  /** The final status, or null when the call was refused or failed. */
  readonly status: number | null
}

export interface FakeSafeFetch {
  readonly safeFetch: SafeFetch
  /** Every call, refused ones included, in order. */
  readonly calls: FakeSafeFetchCall[]
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

function abortError(reason: unknown): Error {
  if (reason instanceof Error)
    return reason
  const error = new Error('The request was aborted.', { cause: reason })
  error.name = 'AbortError'
  return error
}

/**
 * A `SafeFetch` over `routes` for unit tests (`InstallerOptions` / `MarketplaceServiceOptions` `safeFetch`): the URL
 * checks of `security/ssrf.ts` (absolute URL, the allowed protocols, no credentials), redirects followed up to
 * `maxRedirects` (default 5; a redirect beyond it fails like the guard: "Too many redirects"), `maxBytes` enforced
 * (`payload_too_large`), the abort signal honored. A host the model does not serve is refused (`validation_error`,
 * like a private address), so a test can never reach the network.
 */
export function createFakeSafeFetch(routes: FakeRemoteRoutes): FakeSafeFetch {
  const calls: FakeSafeFetchCall[] = []
  const safeFetch: SafeFetch = async (input, options): Promise<SafeFetchResult> => {
    let status: number | null = null
    try {
      const result = await fetchOnce(input, options)
      status = result.status
      return result
    }
    finally {
      calls.push({ url: input, options, status })
    }
  }

  async function fetchOnce(input: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
    const protocols = options.protocols ?? ['http:', 'https:']
    const method = options.method ?? 'GET'
    const maxRedirects = options.maxRedirects ?? 5
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(options.headers ?? {}))
      headers[name.toLowerCase()] = value
    if (typeof input !== 'string' || !URL.canParse(input))
      throw new HarnessError({ code: 'validation_error', message: 'Invalid URL: expected an absolute http:// or https:// URL.' })
    let url = new URL(input)
    for (let redirects = 0; ; redirects++) {
      if (options.signal?.aborted)
        throw abortError(options.signal.reason)
      if (!(protocols as readonly string[]).includes(url.protocol))
        throw new HarnessError({ code: 'validation_error', message: `Invalid URL: only ${protocols.map(protocol => protocol.slice(0, -1)).join(' and ')} URLs are allowed.` })
      if (url.username !== '' || url.password !== '')
        throw new HarnessError({ code: 'validation_error', message: 'Invalid URL: URLs with credentials are not allowed.' })
      url.hash = ''
      const response = routes.handle({ method, host: url.host, path: `${url.pathname}${url.search}`, headers })
      if (response === null)
        throw new HarnessError({ code: 'validation_error', message: `The host "${url.host}" is not served by the fake remote: only registered hosts can be fetched.` })
      const location = response.headers.location
      if (REDIRECT_STATUSES.has(response.status) && typeof location === 'string' && location.trim() !== '') {
        if (redirects >= maxRedirects)
          throw new HarnessError({ code: 'provider_error', message: `Too many redirects: ${url.host} redirected more than ${maxRedirects} times.` })
        if (!URL.canParse(location, url.href))
          throw new HarnessError({ code: 'provider_error', message: `${url.host} redirected to an invalid URL.` })
        url = new URL(location, url)
        continue
      }
      const size = response.body instanceof Uint8Array ? response.body.length : response.body.zeros
      if (method !== 'HEAD' && size > options.maxBytes)
        throw new HarnessError({ code: 'payload_too_large', message: `The response is larger than the limit of ${options.maxBytes} bytes.`, details: { limitBytes: options.maxBytes } })
      const body = method === 'HEAD' ? new Uint8Array(0) : response.body instanceof Uint8Array ? response.body.slice() : new Uint8Array(size)
      return { url: url.href, status: response.status, headers: new Headers(response.headers), body }
    }
  }

  return { safeFetch, calls }
}
