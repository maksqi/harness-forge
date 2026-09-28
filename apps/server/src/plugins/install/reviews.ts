// What the user reviewed (ADR-017, PLUGINS.md 12 "Flow"): the install request carries no hash, so the installer
// remembers the sha256 of recent inspections per source. When a source is installed after it was inspected and it now
// yields other files (an npm dist-tag or range moved to a new version, a folder changed), the install is refused with
// `409 conflict` (`stale`) instead of installing - and possibly trusting - something the user did not see. Zip uploads
// and URL installs are pinned by their bytes / SRI hash and need no entry. Entries expire after 30 minutes.
import type { PluginInstallInput } from '../types.ts'
import { HarnessError } from '@harness-forge/shared'

const REVIEW_TTL_MS = 30 * 60 * 1000
const MAX_REVIEWS = 100

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
      if (review !== undefined && review.sha256 !== sha256) {
        throw new HarnessError({
          code: 'conflict',
          message: 'The plugin changed since you reviewed it (a new version or changed files): inspect it again before installing.',
          details: { reason: 'stale' },
        })
      }
    },
    forget: (input) => {
      const key = reviewKey(input)
      if (key !== null)
        reviews.delete(key)
    },
  }
}
