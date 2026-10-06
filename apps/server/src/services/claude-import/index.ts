// The home-folder import (Phase 12, ADR-055; API.md 5.35, ARCHITECTURE.md 6.35) behind `ClaudeImportService`
// (./types.ts). C43 stub with the final signature (P12-0b): `home()` is real (one `stat` of `env.claudeHome`, never a
// file read); `scan`, `upload` and `apply` answer `not_implemented`; `stop` is a no-op (no plan is kept). Owner in
// P12-A: W12.3 (`collect-disk`, `collect-upload`, `baseline`, `plans`, `apply`).
import type { ClaudeImportHome } from '@harness-forge/shared'
import type { Env } from '../../env.ts'
import type { AppDeps } from '../../types.ts'
import type { ClaudeImportService } from './types.ts'
import { stat } from 'node:fs/promises'
import { noopAsync, rejectsNotImplemented } from '../../not-implemented.ts'

/** `stat` errors that mean "nothing there" (a missing folder, or a file on the way). */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/**
 * `GET /claude-import/home` (ADR-055): whether the import scan can read `env.claudeHome`. One `stat` of the folder
 * (links followed: a dotfile manager may link `~/.claude`); no file is opened and nothing is listed.
 */
export async function claudeImportHome(env: Pick<Env, 'claudeHome'>): Promise<ClaudeImportHome> {
  const path = env.claudeHome
  if (path === null)
    return { available: false, reason: 'disabled', path: null }
  try {
    const info = await stat(path)
    return info.isDirectory() ? { available: true, path } : { available: false, reason: 'missing', path }
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return { available: false, reason: code !== undefined && MISSING_CODES.has(code) ? 'missing' : 'unreadable', path }
  }
}

export function createClaudeImportService(deps: AppDeps): ClaudeImportService {
  return Object.freeze({
    home: () => claudeImportHome(deps.env),
    scan: rejectsNotImplemented('Scanning a Claude Code folder'),
    upload: rejectsNotImplemented('Importing an uploaded Claude Code folder'),
    apply: rejectsNotImplemented('Applying a Claude Code import'),
    stop: noopAsync,
  })
}
