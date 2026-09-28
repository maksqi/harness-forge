// Errors and limits of plugin installs (PLUGINS.md 12 "Archive rules", API.md 5.16). Every user-facing failure is a
// `HarnessError`: guard violations are `validation_error` (with `details.issues`), size limits `payload_too_large`,
// upstream failures (npm registry, install URLs) `not_found` / `provider_unreachable` / `provider_error` with `status`.
import type { HarnessErrorCode } from '@harness-forge/shared'
import { HarnessError, LIMITS } from '@harness-forge/shared'

/** Size and count limits of every install source (ARCHITECTURE.md 10.4). */
export interface InstallLimits {
  /** Zip uploads, URL downloads and npm tarballs (compressed). */
  compressedBytes: number
  /** Sum of the extracted file sizes (enforced while extracting). */
  expandedBytes: number
  /** Files and directories of one archive or folder. */
  entries: number
  /** npm registry metadata document. */
  metadataBytes: number
}

export const INSTALL_LIMITS: Readonly<InstallLimits> = Object.freeze({
  compressedBytes: LIMITS.pluginZipBytes,
  expandedBytes: 100 * 1024 * 1024,
  entries: 2000,
  metadataBytes: 10 * 1024 * 1024,
})

/** Path of a validation issue (`details.issues[].path`), e.g. `['file']`, `['spec']`, `['url']`. */
export type IssuePath = Array<string | number>

/** `validation_error` with one issue. */
export function invalid(message: string, path: IssuePath = []): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
}

/** `payload_too_large` with `details.limitBytes`. */
export function tooLarge(message: string, limitBytes: number): HarnessError {
  return new HarnessError({ code: 'payload_too_large', message, details: { limitBytes } })
}

/** An upstream failure (npm registry, install URL): `not_found`, `provider_unreachable` or `provider_error`. */
export function upstreamError(code: Extract<HarnessErrorCode, 'not_found' | 'provider_unreachable' | 'provider_error'>, message: string, status?: number): HarnessError {
  return new HarnessError({ code, message, ...(status === undefined ? {} : { status }) })
}

/** Megabytes for messages (`20 MB`). */
export function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

/** A name quoted for an error message: JSON escapes (control characters stay visible), at most 120 characters. */
export function quoteName(name: string): string {
  return JSON.stringify(name.length > 120 ? `${name.slice(0, 120)}...` : name)
}
