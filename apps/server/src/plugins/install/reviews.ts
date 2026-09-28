// What the user reviewed (ADR-017, PLUGINS.md 12 "Flow"): an install installs - and possibly trusts - exactly what the
// inspect preview showed, or nothing.
//
// - The install request carries the reviewed hash (`sha256` of `PluginInstallBody` / `PluginInstallForm`, the
//   `PluginInspection.sha256` the user saw). When it is present it is authoritative: a source that now yields other
//   files (an npm dist-tag or range moved to a new version, a changed folder, another zip) is refused with
//   `409 conflict` (`reason: 'stale'`), whenever the inspection happened and on whichever server process.
// - Fallback for API clients that inspect without passing the hash: the installer remembers the sha256 of recent
//   inspections per npm spec / folder in memory (30 minutes, at most 100 entries) and refuses the same way. Zip uploads
//   and URL installs are pinned by their bytes / SRI hash and need no entry.
import type { PluginInstallInput, PluginInstallOptions } from '../types.ts'
import { HarnessError } from '@harness-forge/shared'

const REVIEW_TTL_MS = 30 * 60 * 1000
const MAX_REVIEWS = 100

/**
 * `PluginInstallOptions` plus the reviewed hash (local adapter until `plugins/types.ts` carries `sha256`, see the W4.1
 * CCR): the route passes the `sha256` of the request body or form.
 */
export interface ReviewedInstallOptions extends PluginInstallOptions {
  /** `PluginInspection.sha256` the user reviewed; the install fails with `conflict` (`stale`) when it differs. */
  sha256?: string
}

/** The reviewed hash of install options (undefined when the client sent none). */
export function reviewedHashOf(options: PluginInstallOptions): string | undefined {
  const sha256 = (options as ReviewedInstallOptions).sha256
  return typeof sha256 === 'string' ? sha256 : undefined
}

/** `409 conflict` (`stale`): the package changed since the user reviewed it. */
export function staleReviewError(): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'The plugin changed since you reviewed it (a new version or changed files): inspect it again before installing.',
    details: { reason: 'stale' },
  })
}

/** Throws `conflict` (`stale`) unless the package hash equals the reviewed one. */
export function checkReviewedHash(reviewed: string, actual: string): void {
  if (reviewed !== actual)
    throw staleReviewError()
}

export interface ReviewLog {
  /** Records the hash an inspection showed for `input`. */
  readonly remember: (input: PluginInstallInput, sha256: string) => void
  /** Throws `conflict` (`stale`) when `input` was inspected recently with a different hash. */
  readonly check: (input: PluginInstallInput, sha256: string) => void
  /** Forgets `input` (after an install). */
  readonly forget: (input: PluginInstallInput) => void
}

/** The key of a source whose content can change between inspect and install; null for byte-pinned sources. */
export function reviewKey(input: PluginInstallInput): string | null {
  switch (input.source) {
    case 'npm':
      return `npm:${input.spec.trim()}`
    case 'path':
      return `path:${input.mode}:${input.path}`
    default:
      return null
  }
}

export function createReviewLog(now: () => number = Date.now): ReviewLog {
  const reviews = new Map<string, { sha256: string, at: number }>()

  const prune = (): void => {
    const oldest = now() - REVIEW_TTL_MS
    for (const [key, review] of reviews) {
      if (review.at < oldest)
        reviews.delete(key)
    }
    while (reviews.size > MAX_REVIEWS) {
      const first = reviews.keys().next()
      if (first.done)
        break
      reviews.delete(first.value)
    }
  }

  return {
    remember: (input, sha256) => {
      const key = reviewKey(input)
      if (key === null)
        return
      reviews.delete(key)
      reviews.set(key, { sha256, at: now() })
      prune()
    },
    check: (input, sha256) => {
      prune()
      const key = reviewKey(input)
      const review = key === null ? undefined : reviews.get(key)
      if (review !== undefined)
        checkReviewedHash(review.sha256, sha256)
    },
    forget: (input) => {
      const key = reviewKey(input)
      if (key !== null)
        reviews.delete(key)
    },
  }
}
