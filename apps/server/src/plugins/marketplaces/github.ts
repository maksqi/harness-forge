// GitHub over HTTPS, without git (Phase 12, ADR-054; ARCHITECTURE.md 6.34). Owner: W12.2. Shared by the marketplace
// service (the `marketplace.json` of a commit) and the installer (`install/github.ts`: the commit's zip).
//
// - A ref resolves to a commit with `GET {api}/repos/{owner}/{repo}/commits/{ref | HEAD}` and `Accept:
//   application/vnd.github.sha` (the answer is the 40-hex sha); a full 40-hex sha needs no request.
// - A file of a commit is `GET {raw}/{owner}/{repo}/{sha}/{path}`.
// - A commit's zip is `GET {codeload}/{owner}/{repo}/zip/{sha}` (no redirects; `install/github.ts`).
// Every request goes through the injected `SafeFetch` with `protocols: ['https:']`; owner, repository, ref and path are
// validated before a URL is built and every segment is encoded. GitHub answers map to `HarnessError`s: 404 (no such
// repository or file) and 422 (no such ref) → `not_found`; an exhausted rate limit (403 / 429 with
// `x-ratelimit-remaining: 0`, or any 429) → `rate_limited` with `retryAfterMs` when the reset is known; any other status →
// `provider_error`; network failures → `provider_unreachable` (from `safeFetch`). Never logs anything.
import type { SafeFetch, SafeFetchResult } from '../../security/types.ts'
import type { MarketplaceServiceOptions } from './types.ts'
import { COMMIT_SHA_PATTERN, GITHUB_REPO_PATTERN, HarnessError, isGitRef, isHarnessError } from '@harness-forge/shared'
import { GITHUB_API_BASE, GITHUB_CODELOAD_BASE, GITHUB_RAW_BASE } from './types.ts'

/** The three GitHub hosts (constants; tests override them). */
export interface GithubBases {
  readonly api: string
  readonly raw: string
  readonly codeload: string
}

/** The GitHub bases of `options` (the `MarketplaceServiceOptions` / `InstallerOptions` overrides), else the constants. */
export function githubBases(options: Pick<MarketplaceServiceOptions, 'githubApi' | 'githubRaw' | 'githubCodeload'> = {}): GithubBases {
  const trim = (base: string): string => base.replace(/\/+$/, '')
  return {
    api: trim(options.githubApi ?? GITHUB_API_BASE),
    raw: trim(options.githubRaw ?? GITHUB_RAW_BASE),
    codeload: trim(options.githubCodeload ?? GITHUB_CODELOAD_BASE),
  }
}

/** Timeout of an API or raw request (archives have their own, longer one). */
const REQUEST_TIMEOUT_MS = 20_000
/** Redirects allowed for the API and raw files (a renamed repository); every hop is re-checked by `safeFetch`. */
const MAX_REDIRECTS = 3
/** Bytes of a `commits/{ref}` answer with `application/vnd.github.sha` (40 hex; generous). */
const SHA_ANSWER_BYTES = 4096

/** The 12-character sha of logs and source refs. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12)
}

/** True for a full commit sha (40 hex, any case). */
export function isCommitSha(value: string): boolean {
  return COMMIT_SHA_PATTERN.test(value.toLowerCase())
}

/** `owner` and `name` of a validated `owner/repo` (`validation_error` otherwise). */
export function splitRepo(repo: string): { owner: string, name: string } {
  if (!GITHUB_REPO_PATTERN.test(repo))
    throw new HarnessError({ code: 'validation_error', message: 'Expected a GitHub repository "owner/repo".', details: { issues: [{ path: ['repo'], message: 'Expected "owner/repo".', code: 'custom' }] } })
  const [owner, name] = repo.split('/') as [string, string]
  return { owner, name }
}

/** True when `repo` belongs to `owner` (case-insensitive, as GitHub compares owners). */
export function isRepoOfOwner(repo: string, owner: string): boolean {
  return repo.split('/')[0]?.toLowerCase() === owner.toLowerCase()
}

/** Each segment of a ref or path encoded for a URL path (`/` kept between segments). */
export function encodePath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

function checkedRef(ref: string): string {
  if (ref !== 'HEAD' && !isGitRef(ref))
    throw new HarnessError({ code: 'validation_error', message: 'Expected a branch, tag or commit.', details: { issues: [{ path: ['ref'], message: 'Invalid ref.', code: 'custom' }] } })
  return ref
}

function checkedFilePath(path: string): string {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))
    throw new HarnessError({ code: 'validation_error', message: 'Expected a relative file path.' })
  return path
}

function header(result: SafeFetchResult, name: string): string | null {
  try {
    return result.headers.get(name)
  }
  catch {
    return null
  }
}

/** Milliseconds until a rate limit resets (`retry-after` seconds or `x-ratelimit-reset` epoch seconds); undefined when unknown. */
function retryAfterMs(result: SafeFetchResult, now: number): number | undefined {
  const retryAfter = header(result, 'retry-after')
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim()))
    return Number(retryAfter.trim()) * 1000
  const reset = header(result, 'x-ratelimit-reset')
  if (reset !== null && /^\d+$/.test(reset.trim()))
    return Math.max(0, Number(reset.trim()) * 1000 - now)
  return undefined
}

/** True when GitHub answered that the rate limit is exhausted. */
export function isRateLimitAnswer(result: SafeFetchResult): boolean {
  if (result.status === 429)
    return true
  return result.status === 403 && header(result, 'x-ratelimit-remaining')?.trim() === '0'
}

/** The `HarnessError` of a GitHub answer that is not a success (see the module comment). */
export function githubAnswerError(result: SafeFetchResult, what: { notFound: string, failed: string }, now: number = Date.now()): HarnessError {
  if (isRateLimitAnswer(result)) {
    const wait = retryAfterMs(result, now)
    return new HarnessError({
      code: 'rate_limited',
      message: 'GitHub\'s request limit for this server is used up (60 requests per hour without a token). Try again later.',
      status: result.status,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    })
  }
  if (result.status === 404 || result.status === 422)
    return new HarnessError({ code: 'not_found', message: what.notFound, status: result.status })
  return new HarnessError({ code: 'provider_error', message: `${what.failed} (HTTP ${result.status}).`, status: result.status })
}

/** A `safeFetch` call; anything that is not a `HarnessError` becomes `provider_unreachable`. */
export async function githubRequest(safeFetch: SafeFetch, url: string, options: { maxBytes: number, accept: string, timeoutMs?: number, maxRedirects?: number, signal?: AbortSignal }): Promise<SafeFetchResult> {
  try {
    return await safeFetch(url, {
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      maxRedirects: options.maxRedirects ?? MAX_REDIRECTS,
      protocols: ['https:'],
      method: 'GET',
      headers: { 'accept': options.accept, 'x-github-api-version': '2022-11-28' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }
  catch (error) {
    if (isHarnessError(error))
      throw error
    if (options.signal?.aborted === true)
      throw new HarnessError({ code: 'provider_unreachable', message: 'The request to GitHub was stopped.' })
    throw new HarnessError({ code: 'provider_unreachable', message: 'GitHub cannot be reached: network error.' })
  }
}

export interface GithubContext {
  readonly safeFetch: SafeFetch
  readonly bases: GithubBases
  readonly signal?: AbortSignal
  /** Clock of `retryAfterMs` (tests). */
  readonly now?: () => number
}

/**
 * The commit `ref` names in `repo` (`HEAD` / absent = the default branch); a full 40-hex sha is returned as is
 * (lowercased) without a request. Throws `not_found`, `rate_limited`, `provider_error`, `provider_unreachable`.
 */
export async function resolveGithubCommit(context: GithubContext, repo: string, ref?: string): Promise<string> {
  const { owner, name } = splitRepo(repo)
  if (ref !== undefined && isCommitSha(ref))
    return ref.toLowerCase()
  const wanted = checkedRef(ref ?? 'HEAD')
  const url = `${context.bases.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodePath(wanted)}`
  const result = await githubRequest(context.safeFetch, url, { maxBytes: SHA_ANSWER_BYTES, accept: 'application/vnd.github.sha', ...(context.signal === undefined ? {} : { signal: context.signal }) })
  if (result.status !== 200) {
    throw githubAnswerError(result, {
      notFound: ref === undefined ? `The GitHub repository ${repo} was not found (or is private).` : `The GitHub repository ${repo} or its ref "${ref}" was not found.`,
      failed: `GitHub could not resolve ${repo}${ref === undefined ? '' : `@${ref}`}`,
    }, context.now?.() ?? Date.now())
  }
  const sha = new TextDecoder().decode(result.body).trim().toLowerCase()
  if (!COMMIT_SHA_PATTERN.test(sha))
    throw new HarnessError({ code: 'provider_error', message: `GitHub answered an unexpected commit for ${repo}.` })
  return sha
}

/**
 * The bytes of `path` at the commit `sha` of `repo` (at most `maxBytes`, else `payload_too_large`). Throws `not_found`
 * (no such file), `rate_limited`, `provider_error`, `provider_unreachable`.
 */
export async function fetchGithubFile(context: GithubContext, repo: string, sha: string, path: string, maxBytes: number): Promise<Uint8Array> {
  const { owner, name } = splitRepo(repo)
  if (!isCommitSha(sha))
    throw new HarnessError({ code: 'validation_error', message: 'Expected a 40-character commit sha.' })
  const url = `${context.bases.raw}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${sha.toLowerCase()}/${encodePath(checkedFilePath(path))}`
  const result = await githubRequest(context.safeFetch, url, { maxBytes, accept: 'application/json, text/plain;q=0.9, */*;q=0.5', ...(context.signal === undefined ? {} : { signal: context.signal }) })
  if (result.status !== 200) {
    throw githubAnswerError(result, {
      notFound: `${repo} has no ${path} at ${shortSha(sha)}.`,
      failed: `GitHub could not serve ${path} of ${repo}`,
    }, context.now?.() ?? Date.now())
  }
  return result.body
}
