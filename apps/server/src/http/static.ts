// Production SPA serving (ARCHITECTURE.md 11 "Production", 10.2 CSP). Owner: W1.1 (W1.1-T9).
//
// Serves the output of `nuxt generate` from `HF_WEB_DIR`, else `apps/web/.output/public` (`webPublicDir()`), when that
// directory exists (a build made after boot is picked up):
// - existing files for GET / HEAD (`createStaticRoutes`, mounted at `/` AFTER the `/api` sub-app, so `/api/*` never
//   reaches it): `/_nuxt/*` with `Cache-Control: public, max-age=31536000, immutable` (hashed assets; except the
//   `/_nuxt/builds/latest.json` manifest), everything else `no-cache` with an `ETag` (`If-None-Match` -> 304);
// - HTML documents (`index.html`, `200.html`, ...) with `Cache-Control: no-cache` and the SPA CSP, whose `script-src`
//   lists the sha256 hashes of the document's own inline scripts (color-mode, import map, Nuxt config), recomputed
//   when the file changes;
// - `200.html` (else `index.html`) for a GET / HEAD that matched nothing else and wants HTML (an `Accept` with
//   `text/html`, or no specific `Accept` and no file extension), so deep links such as `/chat/<id>` load the SPA. This
//   fallback is answered by the app's not-found handler (`staticSiteFor(deps).fallback`), after every route; unknown
//   `/api/*` paths never get it (they stay `404 not_found` JSON envelopes);
// - never: directory listings, dot files, missing `/_nuxt/*` assets (404, not HTML), or a path that leaves the root
//   (segments are decoded one by one, `..`, separators, NUL and control characters are refused, and the realpath of
//   the file, symlinks resolved, must stay inside the realpath of the root).
import type { Stats } from 'node:fs'
import type { AppDeps } from '../types.ts'
import type { AppEnv } from './types.ts'
import { existsSync } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { getMimeType } from 'hono/utils/mime'
import { webPublicDir } from '../paths.ts'
import { inlineScriptHashes, spaCsp } from '../security/headers.ts'
import { apiRelativePath } from './route-match.ts'

/** SPA fallback document written by `nuxt generate`. */
export const SPA_FALLBACK_FILE = '200.html'
export const INDEX_FILE = 'index.html'
/** Directory of the hashed build assets. */
export const ASSETS_DIR = '_nuxt'

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const REVALIDATE_CACHE_CONTROL = 'no-cache'
/** CSP of SVG files opened as documents (images embedded with `<img>` are not affected). */
export const SVG_CSP = 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox'

/** Build manifests that change with every deployment although they live under `/_nuxt/`. */
const MUTABLE_ASSETS: ReadonlySet<string> = new Set(['/_nuxt/builds/latest.json'])
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here.
const UNSAFE_SEGMENT = /[/\\\u0000-\u001F\u007F]/

interface StaticFile {
  /** Real path (symlinks resolved), inside the root. */
  path: string
  stats: Stats
}

interface HtmlDocument {
  mtimeMs: number
  size: number
  body: Uint8Array
  csp: string
}

export interface StaticSite {
  /** The configured root directory. */
  readonly root: string
  /** An existing file for a GET / HEAD request, or null. */
  readonly file: (request: Request) => Promise<Response | null>
  /** The SPA document for a GET / HEAD navigation that matched nothing (see the module comment), or null. */
  readonly fallback: (request: Request) => Promise<Response | null>
}

/**
 * The decoded segments of a URL path, or null when one of them is unsafe: malformed percent-encoding, `.`, `..`, any
 * dot file or dot directory, an encoded separator (`%2F`, `%5C`), NUL or another control character.
 */
export function safePathSegments(pathname: string): string[] | null {
  const segments: string[] = []
  for (const raw of pathname.split('/')) {
    if (raw === '')
      continue
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    }
    catch {
      return null
    }
    if (segment.startsWith('.') || UNSAFE_SEGMENT.test(segment))
      return null
    segments.push(segment)
  }
  return segments
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  }
  catch {
    return null
  }
}

/** `W/"<size>-<mtime>"`: changes whenever the file is rewritten. */
function weakEtag(stats: Stats): string {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
}

/** `If-None-Match` matches `etag` (weak comparison, `*` included). */
function notModified(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match')
  if (header === null)
    return false
  const strip = (tag: string): string => tag.trim().replace(/^W\//i, '')
  return header.split(',').some(tag => tag.trim() === '*' || strip(tag) === strip(etag))
}

/** True when the request wants an HTML document (a navigation) rather than a missing file. */
function wantsHtml(request: Request, segments: readonly string[]): boolean {
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''
  if (accept.includes('text/html'))
    return true
  const last = segments.at(-1) ?? ''
  if (last.includes('.'))
    return false
  return accept.trim() === '' || /(?:^|,)\s*\*\/\*/.test(accept)
}

function cacheControlFor(urlPath: string, isHtml: boolean): string {
  if (!isHtml && urlPath.startsWith(`/${ASSETS_DIR}/`) && !MUTABLE_ASSETS.has(urlPath))
    return IMMUTABLE_CACHE_CONTROL
  return REVALIDATE_CACHE_CONTROL
}

/** Serves the SPA build in `root` (see the module comment). */
export function createStaticSite(root: string): StaticSite {
  let rootReal: string | null = null
  const htmlCache = new Map<string, HtmlDocument>()

  /** The realpath of the root once it exists (a build made after boot is picked up). */
  async function resolveRoot(): Promise<string | null> {
    if (rootReal !== null)
      return rootReal
    try {
      const real = await realpath(root)
      if ((await stat(real)).isDirectory())
        rootReal = real
    }
    catch {
      // No build yet.
    }
    return rootReal
  }

  async function findFile(base: string, segments: readonly string[]): Promise<StaticFile | null> {
    let candidate = join(base, ...segments)
    if (!isInside(base, candidate))
      return null
    let stats = await statOrNull(candidate)
    if (stats?.isDirectory()) {
      candidate = join(candidate, INDEX_FILE)
      stats = await statOrNull(candidate)
    }
    if (stats === null || !stats.isFile())
      return null
    try {
      const real = await realpath(candidate)
      return isInside(base, real) ? { path: real, stats } : null
    }
    catch {
      return null
    }
  }

  async function htmlDocument(file: StaticFile): Promise<HtmlDocument> {
    const cached = htmlCache.get(file.path)
    if (cached !== undefined && cached.mtimeMs === file.stats.mtimeMs && cached.size === file.stats.size)
      return cached
    const content = await readFile(file.path)
    const document: HtmlDocument = {
      mtimeMs: file.stats.mtimeMs,
      size: file.stats.size,
      body: new Uint8Array(content),
      csp: spaCsp(inlineScriptHashes(content.toString('utf8'))),
    }
    htmlCache.set(file.path, document)
    return document
  }

  async function serve(request: Request, file: StaticFile, urlPath: string): Promise<Response> {
    const isHtml = file.path.toLowerCase().endsWith('.html')
    const etag = weakEtag(file.stats)
    const headers = new Headers({
      'Content-Type': getMimeType(file.path) ?? 'application/octet-stream',
      'Cache-Control': cacheControlFor(urlPath, isHtml),
      'ETag': etag,
      'Last-Modified': file.stats.mtime.toUTCString(),
    })
    const document = isHtml ? await htmlDocument(file) : null
    if (document !== null)
      headers.set('Content-Security-Policy', document.csp)
    else if (file.path.toLowerCase().endsWith('.svg'))
      headers.set('Content-Security-Policy', SVG_CSP)

    if (notModified(request, etag))
      return new Response(null, { status: 304, headers })
    headers.set('Content-Length', String(document?.body.byteLength ?? file.stats.size))
    if (request.method.toUpperCase() === 'HEAD')
      return new Response(null, { status: 200, headers })
    if (document !== null)
      return new Response(document.body, { status: 200, headers })
    const handle = await open(file.path, 'r')
    const stream = Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream<Uint8Array>
    return new Response(stream, { status: 200, headers })
  }

  /** Root realpath, URL path and safe segments of a GET / HEAD request outside `/api`; null otherwise. */
  async function target(request: Request): Promise<{ base: string, urlPath: string, segments: string[] } | null> {
    const method = request.method.toUpperCase()
    if (method !== 'GET' && method !== 'HEAD')
      return null
    const urlPath = new URL(request.url).pathname
    if (apiRelativePath(urlPath) !== null)
      return null
    const base = await resolveRoot()
    const segments = safePathSegments(urlPath)
    return base === null || segments === null ? null : { base, urlPath, segments }
  }

  async function file(request: Request): Promise<Response | null> {
    const found = await target(request)
    const match = found === null ? null : await findFile(found.base, found.segments)
    return found === null || match === null ? null : serve(request, match, found.urlPath)
  }

  async function fallback(request: Request): Promise<Response | null> {
    const found = await target(request)
    if (found === null || found.segments[0] === ASSETS_DIR || !wantsHtml(request, found.segments))
      return null
    const document = await findFile(found.base, [SPA_FALLBACK_FILE]) ?? await findFile(found.base, [INDEX_FILE])
    return document === null ? null : serve(request, document, `/${SPA_FALLBACK_FILE}`)
  }

  return { root, file, fallback }
}

const sites = new WeakMap<AppDeps, StaticSite>()

/** The site of an app (one per `deps`), shared by the static routes and the not-found handler. */
export function staticSiteFor(deps: AppDeps): StaticSite {
  let site = sites.get(deps)
  if (site === undefined) {
    const root = deps.env.webDir ?? webPublicDir()
    site = createStaticSite(root)
    sites.set(deps, site)
    if (existsSync(join(root, SPA_FALLBACK_FILE)) || existsSync(join(root, INDEX_FILE)))
      deps.logger.info('serving the web app', { webDir: root })
    else
      deps.logger.debug('no web app build found; only the API is served', { webDir: root })
  }
  return site
}

/** Existing files of the SPA build; the `200.html` fallback is answered by the not-found handler. */
export function createStaticRoutes(deps: AppDeps): Hono<AppEnv> {
  const site = staticSiteFor(deps)
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    const response = await site.file(c.req.raw)
    if (response === null)
      return next()
    return response
  })
  return app
}
