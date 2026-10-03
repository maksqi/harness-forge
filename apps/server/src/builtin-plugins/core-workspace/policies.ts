// Policy functions of the `core-workspace` file tools (Phase 7, ADR-032, ARCHITECTURE.md 6.13 / 10.9):
//
// - `read_file`: `ask` for a secret-looking path (`.env`, `*.pem`, `id_rsa*`, ...), else `safe`;
// - `write_file` / `edit_file`: `always` for a hidden (`.github/…`, `.husky/…`, `.vscode/…`) or secret-looking path,
//   else `ask` (which the Accept edits mode runs without asking).
//
// The host evaluates a policy before the call runs, with the raw (not yet validated) input, under a 3 s guard where a
// throw counts as `always`. Both the path as written (relative to the project folder) and, when the call carries its
// workspace (`c.workspace`), the path it resolves to through the frozen guard are checked, so a link named
// `notes.txt` that points at `.env` asks as well. A path the guard refuses is judged by its spelling only: the call
// fails anyway.
import type { ToolCallContext, ToolPolicy } from '@harness-forge/plugin-sdk'
import { posix, resolve } from 'node:path'
import { isWithin } from '../../plugins/scaffold/paths.ts'
import { resolveWorkspacePath, toWorkspaceRel } from '../../workspace/paths.ts'
import { isHiddenWorkspacePath, isSecretLookingPath } from '../../workspace/sensitive.ts'

/** The `path` of a raw tool input, or null. */
function inputPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null)
    return null
  const path = (input as { path?: unknown }).path
  return typeof path === 'string' && path !== '' ? path : null
}

/**
 * The project-relative spellings of a path to check: as written, and as resolved through the path guard when the call
 * has a workspace. Empty for a path outside the project folder (the call fails).
 */
export async function policyPaths(input: unknown, c: Pick<ToolCallContext, 'workspace'>): Promise<string[]> {
  const path = inputPath(input)
  if (path === null)
    return []
  const root = c.workspace?.root
  if (root === undefined)
    return [posix.normalize(path.replaceAll('\\', '/'))]
  const lexical = resolve(root, path)
  if (!isWithin(root, lexical))
    return []
  const paths = [toWorkspaceRel(root, lexical)]
  try {
    const resolved = await resolveWorkspacePath(root, path, { allowMissing: true })
    if (resolved.rel !== paths[0])
      paths.push(resolved.rel)
  }
  catch {}
  return paths
}

/** Policy of `read_file`: `ask` for a secret-looking path, else `safe`. */
export async function readFilePolicy(input: unknown, c: Pick<ToolCallContext, 'workspace'>): Promise<ToolPolicy> {
  const paths = await policyPaths(input, c)
  return paths.some(isSecretLookingPath) ? 'ask' : 'safe'
}

/** Policy of `write_file` and `edit_file`: `always` for a hidden or secret-looking path, else `ask`. */
export async function writeFilePolicy(input: unknown, c: Pick<ToolCallContext, 'workspace'>): Promise<ToolPolicy> {
  const paths = await policyPaths(input, c)
  return paths.some(path => isHiddenWorkspacePath(path) || isSecretLookingPath(path)) ? 'always' : 'ask'
}
