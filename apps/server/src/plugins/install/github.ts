// GitHub archive sources (Phase 12, ADR-054; API.md 5.16, ARCHITECTURE.md 6.34). Owner: W12.2.
//
// `{ source: 'github', repo, ref?, path? }` and the GitHub-backed marketplace entries are installed from the zip of one
// resolved commit, downloaded over HTTPS (never git):
//   1. the ref resolves to a commit (`marketplaces/github.ts`: `GET api.github.com/repos/{o}/{r}/commits/{ref|HEAD}`; a
//      full sha needs no request);
//   2. `GET codeload.github.com/{o}/{r}/zip/{sha}` through `safeFetch` without redirects, at most
//      `LIMITS.repoArchiveBytes` (50 MB) compressed; the zip comment must equal the sha and every entry must sit in the
//      top folder `<repo>-<sha>/`;
//   3. when the API answers `rate_limited`, the fallback downloads `codeload …/zip/refs/heads/{ref}` (`zip/HEAD` for the
//      default branch) and reads the sha from the zip comment (the top folder is then `<repo>-<ref>/`);
//   4. only the chosen subtree (`path`, else the whole repository) is read (`EntryCollector` `select`): entries outside
//      are never admitted, written or counted and a link there is ignored; inside it every archive guard applies (names,
//      links, devices, the 100 MB / 2,000 entries caps, duplicates).
// The result is the archive entries plus the commit; the installer finds the plugin layout below `subtree`.
import type { SafeFetch } from '../../security/types.ts'
import type { GithubBases } from '../marketplaces/github.ts'
import type { ArchiveEntry, EntrySelector } from './archive.ts'
import type { InstallLimits, IssuePath } from './errors.ts'
import { COMMIT_SHA_PATTERN, HarnessError, isHarnessError, LIMITS } from '@harness-forge/shared'
import { encodePath, githubAnswerError, githubRequest, isCommitSha, resolveGithubCommit, shortSha, splitRepo } from '../marketplaces/github.ts'
import { EntryCollector } from './archive.ts'
import { invalid, megabytes, quoteName, tooLarge } from './errors.ts'
import { looksLikeZip, readZip, readZipComment } from './zip.ts'

/** Timeout of a repository zip download. */
const ARCHIVE_TIMEOUT_MS = 120_000

/** A GitHub repository folder to install (`path` absent = the repository root). */
export interface GithubArchiveRequest {
  readonly repo: string
  /** A branch, tag or commit (absent = the default branch). */
  readonly ref?: string
  /** A known commit (a marketplace's stored commit, an entry's `sha`): no API request. */
  readonly sha?: string
  /** The plugin folder inside the repository (`repoSubpathSchema`). */
  readonly path?: string
}

export interface GithubArchiveContext {
  readonly safeFetch: SafeFetch
  readonly bases: GithubBases
  readonly limits: Pick<InstallLimits, 'entries' | 'expandedBytes'>
  /** Compressed bytes of the zip (default `LIMITS.repoArchiveBytes`). */
  readonly archiveBytes?: number
  readonly issuePath?: IssuePath
  readonly signal?: AbortSignal
}

/** A downloaded repository folder. */
export interface GithubArchive {
  /** The commit the files come from (40 lowercase hex). */
  readonly sha: string
  /** The admitted entries of the chosen subtree (archive paths, below `subtree`). */
  readonly entries: ArchiveEntry[]
  /** The archive prefix of the chosen folder (`<repo>-<sha>/` or `<repo>-<sha>/<path>/`). */
  readonly subtree: string
  /** The rate-limit fallback was used (the sha came from the zip comment). */
  readonly fallback: boolean
}

/** `owner/repo@<sha12>[/path]`: the source ref of a GitHub install (inspection, record, logs). */
export function githubSourceRef(repo: string, sha: string, path?: string | null): string {
  return `${repo}@${shortSha(sha)}${path === undefined || path === null || path === '' ? '' : `/${path}`}`
}

/** The label codeload gives a ref in the top folder (`feature/x` → `feature-x`). */
function refLabel(ref: string): string {
  return ref.replaceAll('/', '-')
}

/**
 * The selector of a GitHub zip: every entry must sit in one top folder named like `expected` (case-insensitive, as
 * GitHub may use the repository's canonical case); only entries below `<top>/<path>/` are read.
 */
function githubSelector(expected: readonly string[], path: string | undefined, describe: string, issuePath: IssuePath): { select: EntrySelector, subtree: () => string } {
  const wanted = expected.map(top => top.toLowerCase())
  let top: string | null = null
  const select: EntrySelector = (rawName) => {
    const slash = rawName.indexOf('/')
    const first = slash === -1 ? rawName : rawName.slice(0, slash)
    if (top === null) {
      if (!wanted.includes(first.toLowerCase()))
        throw invalid(`The archive is not ${describe}: its top folder is ${quoteName(first)}, expected ${quoteName(`${expected[0]}/`)}.`, issuePath)
      top = first
    }
    if (first !== top)
      throw invalid(`The archive is not ${describe}: it has more than one top folder.`, issuePath)
    const subtree = path === undefined ? `${top}/` : `${top}/${path}/`
    return rawName === subtree || rawName === subtree.slice(0, -1) || rawName.startsWith(subtree)
  }
  return { select, subtree: () => (top === null ? '' : path === undefined ? `${top}/` : `${top}/${path}/`) }
}

/** Downloads `url` (no redirects) and checks it is a zip of at most `archiveBytes`. */
async function downloadZip(context: GithubArchiveContext, url: string, what: string): Promise<Uint8Array> {
  const limit = context.archiveBytes ?? LIMITS.repoArchiveBytes
  let result
  try {
    result = await githubRequest(context.safeFetch, url, {
      maxBytes: limit,
      accept: 'application/zip, application/octet-stream;q=0.9',
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      maxRedirects: 0,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'payload_too_large')
      throw tooLarge(`The repository archive of ${what} is larger than ${megabytes(limit)}.`, limit)
    throw error
  }
  if (result.status >= 300 && result.status < 400)
    throw new HarnessError({ code: 'provider_error', message: `GitHub answered the archive of ${what} with a redirect (HTTP ${result.status}).`, status: result.status })
  if (result.status !== 200)
    throw githubAnswerError(result, { notFound: `GitHub has no archive of ${what}.`, failed: `GitHub could not serve the archive of ${what}` })
  if (!looksLikeZip(result.body))
    throw invalid(`The archive of ${what} is not a zip file.`, context.issuePath ?? [])
  return result.body
}

/**
 * Downloads the folder `path` of `repo` at its resolved commit (see the module comment). Throws `not_found` (no such
 * repository, ref or folder), `rate_limited` (the API is limited and no fallback applies), `payload_too_large`,
 * `validation_error` (a wrong comment or top folder, a guard violation), `provider_error`, `provider_unreachable`.
 */
export async function downloadGithubArchive(request: GithubArchiveRequest, context: GithubArchiveContext): Promise<GithubArchive> {
  const { owner, name } = splitRepo(request.repo)
  const issuePath = context.issuePath ?? ['repo']
  const github = { safeFetch: context.safeFetch, bases: context.bases, ...(context.signal === undefined ? {} : { signal: context.signal }) }
  const codeload = `${context.bases.codeload}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/zip`

  let sha: string | null = request.sha !== undefined && isCommitSha(request.sha) ? request.sha.toLowerCase() : null
  let fallback = false
  if (sha === null) {
    try {
      sha = await resolveGithubCommit(github, request.repo, request.ref)
    }
    catch (error) {
      // GitHub's API is limited to 60 requests per hour without a token: codeload still serves the ref's zip.
      if (!isHarnessError(error) || error.code !== 'rate_limited')
        throw error
      fallback = true
    }
  }

  let zip: Uint8Array
  let expectedTops: string[]
  if (!fallback && sha !== null) {
    zip = await downloadZip(context, `${codeload}/${sha}`, `${request.repo}@${shortSha(sha)}`)
    if (readZipComment(zip)?.trim().toLowerCase() !== sha)
      throw invalid(`The archive of ${request.repo}@${shortSha(sha)} is not the commit it was asked for (its comment is not the commit sha).`, issuePath)
    expectedTops = [`${name}-${sha}`]
  }
  else {
    const ref = request.ref ?? 'HEAD'
    const url = ref === 'HEAD' ? `${codeload}/HEAD` : `${codeload}/refs/heads/${encodePath(ref)}`
    zip = await downloadZip(context, url, `${request.repo}@${ref}`)
    const comment = readZipComment(zip)?.trim().toLowerCase() ?? ''
    if (!COMMIT_SHA_PATTERN.test(comment))
      throw invalid(`The archive of ${request.repo}@${ref} does not name its commit (no sha in the zip comment).`, issuePath)
    sha = comment
    expectedTops = [`${name}-${refLabel(ref)}`, `${name}-${sha}`]
  }

  const describe = `the GitHub archive of ${request.repo}@${shortSha(sha)}`
  const selector = githubSelector(expectedTops, request.path, describe, issuePath)
  const entries = await readZip(zip, new EntryCollector(context.limits, issuePath, { select: selector.select }))
  const subtree = selector.subtree()
  if (subtree === '' || !entries.some(entry => entry.path.startsWith(subtree)))
    throw new HarnessError({ code: 'not_found', message: request.path === undefined ? `The archive of ${request.repo}@${shortSha(sha)} is empty.` : `${request.repo} has no folder ${quoteName(request.path)} at ${shortSha(sha)}.` })
  return { sha, entries, subtree, fallback }
}
