// Reading a marketplace source (Phase 12, ADR-054; ARCHITECTURE.md 6.34). Owner: W12.2.
//
// - `github`: the ref resolves to a commit, then `raw.githubusercontent.com/{o}/{r}/{sha}/.claude-plugin/marketplace.json`
//   (`github.ts`); the resolved ref is the commit.
// - `url`: the hosted `marketplace.json` through `safeFetch` (https only, every redirect re-checked); the resolved ref is
//   the sha256 of the bytes.
// - `path`: `<folder>/.claude-plugin/marketplace.json` on the server host: the folder is resolved like an install folder
//   (realpath, a directory outside the data directory and not containing it), the `.claude-plugin` folder and the file
//   must not be links, the file must be a regular file of at most `LIMITS.marketplaceJsonBytes`, read without following
//   a final link; no resolved ref (a folder is read again on every refresh).
// Every fetch is capped at `LIMITS.marketplaceJsonBytes` (`payload_too_large` above). The bytes are parsed by
// `catalog.ts`; nothing here logs or parses them.
import type { MarketplaceSource } from '@harness-forge/shared'
import type { SafeFetch, SafeFetchResult } from '../../security/types.ts'
import type { GithubBases } from './github.ts'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessError, isHarnessError, LIMITS } from '@harness-forge/shared'
import { isInside, sha256Hex } from '../loader.ts'
import { MARKETPLACE_JSON_PATH } from './catalog.ts'
import { fetchGithubFile, resolveGithubCommit } from './github.ts'

const URL_TIMEOUT_MS = 20_000
const URL_MAX_REDIRECTS = 3
/** `O_NOFOLLOW` where the platform has it (not on Windows). */
const NO_FOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

/** What a marketplace source yielded. */
export interface FetchedMarketplace {
  readonly bytes: Uint8Array
  /** The commit (github), the sha256 of the JSON (url), null (path). */
  readonly resolvedRef: string | null
}

export interface MarketplaceFetchContext {
  readonly safeFetch: SafeFetch
  readonly bases: GithubBases
  /** The data directory: a marketplace folder may neither lie inside it nor contain it. */
  readonly dataRoot: string
  readonly signal?: AbortSignal
}

function pathIssue(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['source', 'path'], message, code: 'custom' }] } })
}

function tooLarge(): HarnessError {
  return new HarnessError({ code: 'payload_too_large', message: 'The marketplace.json is larger than 1 MiB.', details: { limitBytes: LIMITS.marketplaceJsonBytes } })
}

/**
 * The realpath of a marketplace (or marketplace plugin) folder on the server host: `not_found` when it does not exist,
 * `validation_error` when it is not a directory or lies inside (or contains) the data directory.
 */
export async function resolveHostFolder(path: string, dataRoot: string): Promise<string> {
  let real: string
  try {
    real = await realpath(path)
  }
  catch {
    throw new HarnessError({ code: 'not_found', message: 'The folder does not exist or cannot be read.' })
  }
  const info = await stat(real).catch(() => null)
  if (info === null || !info.isDirectory())
    throw pathIssue('The path is not a folder.')
  const dataReal = await realpath(dataRoot).catch(() => dataRoot)
  if (real === dataReal || isInside(dataReal, real) || isInside(real, dataReal))
    throw pathIssue('Choose a folder outside the harness-forge data directory (and not one that contains it).')
  return real
}

/** Reads `<folder>/.claude-plugin/marketplace.json` (see the module comment). */
export async function readMarketplaceFolder(path: string, dataRoot: string): Promise<Uint8Array> {
  const root = await resolveHostFolder(path, dataRoot)
  const folder = join(root, '.claude-plugin')
  const file = join(folder, 'marketplace.json')
  const missing = new HarnessError({ code: 'not_found', message: `The folder has no ${MARKETPLACE_JSON_PATH}.` })
  const folderInfo = await lstat(folder).catch(() => null)
  if (folderInfo === null)
    throw missing
  if (!folderInfo.isDirectory())
    throw pathIssue(`${MARKETPLACE_JSON_PATH} must be a regular file inside a regular folder (no links).`)
  const fileInfo = await lstat(file).catch(() => null)
  if (fileInfo === null)
    throw missing
  if (!fileInfo.isFile())
    throw pathIssue(`${MARKETPLACE_JSON_PATH} must be a regular file (no links).`)
  if (fileInfo.size > LIMITS.marketplaceJsonBytes)
    throw tooLarge()
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | NO_FOLLOW)
  }
  catch {
    throw pathIssue(`${MARKETPLACE_JSON_PATH} cannot be read.`)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile())
      throw pathIssue(`${MARKETPLACE_JSON_PATH} must be a regular file (no links).`)
    if (info.size > LIMITS.marketplaceJsonBytes)
      throw tooLarge()
    const data = new Uint8Array(info.size)
    let offset = 0
    while (offset < info.size) {
      const { bytesRead } = await handle.read(data, offset, info.size - offset, offset)
      if (bytesRead === 0)
        break
      offset += bytesRead
    }
    return data.subarray(0, offset)
  }
  finally {
    await handle.close()
  }
}

/** The hosted `marketplace.json` of a `url` source. */
async function fetchMarketplaceUrl(url: string, context: MarketplaceFetchContext): Promise<Uint8Array> {
  let result: SafeFetchResult
  try {
    result = await context.safeFetch(url, {
      maxBytes: LIMITS.marketplaceJsonBytes,
      timeoutMs: URL_TIMEOUT_MS,
      maxRedirects: URL_MAX_REDIRECTS,
      protocols: ['https:'],
      method: 'GET',
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
  }
  catch (error) {
    if (isHarnessError(error)) {
      if (error.code === 'payload_too_large')
        throw tooLarge()
      throw error
    }
    throw new HarnessError({ code: 'provider_unreachable', message: 'The marketplace URL cannot be reached: network error.' })
  }
  if (result.status === 404 || result.status === 410)
    throw new HarnessError({ code: 'not_found', message: 'The marketplace URL answered "not found".', status: result.status })
  if (result.status !== 200)
    throw new HarnessError({ code: 'provider_error', message: `The marketplace URL answered HTTP ${result.status}.`, status: result.status })
  return result.body
}

/** Fetches the `marketplace.json` of `source` (see the module comment). */
export async function fetchMarketplaceSource(source: MarketplaceSource, context: MarketplaceFetchContext): Promise<FetchedMarketplace> {
  switch (source.type) {
    case 'github': {
      const github = { safeFetch: context.safeFetch, bases: context.bases, ...(context.signal === undefined ? {} : { signal: context.signal }) }
      const sha = await resolveGithubCommit(github, source.repo, source.ref)
      try {
        return { bytes: await fetchGithubFile(github, source.repo, sha, MARKETPLACE_JSON_PATH, LIMITS.marketplaceJsonBytes), resolvedRef: sha }
      }
      catch (error) {
        if (isHarnessError(error) && error.code === 'payload_too_large')
          throw tooLarge()
        throw error
      }
    }
    case 'url': {
      const bytes = await fetchMarketplaceUrl(source.url, context)
      return { bytes, resolvedRef: sha256Hex(bytes) }
    }
    case 'path':
      return { bytes: await readMarketplaceFolder(source.path, context.dataRoot), resolvedRef: null }
  }
}
