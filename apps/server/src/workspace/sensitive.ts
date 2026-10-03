// Sensitive workspace paths (Phase 7, ADR-032, ARCHITECTURE.md 6.13 / 10.9): the rules behind the policies of the
// `core-workspace` file tools and the skip list of `search_files`.
//
// - **Secret-looking** (the file name, case-insensitive): `.env`, `.env.*` except `.env.example` / `.env.sample` /
//   `.env.template`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`, `.netrc`, `*.p12`, `*.pfx`,
//   `credentials*.json`, `secrets.*`. Reading one asks (`read_file` policy `ask`), writing one always asks, and
//   `search_files` never reads one (even with `include_ignored`).
// - **Hidden**: any path segment that starts with `.` (git hooks, `.husky`, `.vscode`, `.github` workflows, editor
//   tasks). Writing one always asks (policy `always`, also in the Accept edits mode).
//
// Paths are project-relative POSIX paths (`toWorkspaceRel`); `.` and `..` segments are never hidden on their own.

/** `.env.*` files that hold no secrets by convention. */
const ENV_TEMPLATES: ReadonlySet<string> = new Set(['.env.example', '.env.sample', '.env.template'])

/** Exact secret-looking file names (lower case). */
const SECRET_NAMES: ReadonlySet<string> = new Set(['.env', '.npmrc', '.pypirc', '.netrc'])

/** Secret-looking extensions (lower case, with the dot). */
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'] as const

/** Secret-looking name prefixes (lower case). */
const SECRET_PREFIXES = ['id_rsa', 'id_ed25519'] as const

/** The segments of a POSIX path (empty segments and `.` dropped). */
function segmentsOf(path: string): string[] {
  return path.split('/').filter(segment => segment !== '' && segment !== '.')
}

/** The last segment of a POSIX path ('' for the root). */
export function baseNameOf(path: string): string {
  const segments = segmentsOf(path)
  return segments.at(-1) ?? ''
}

/** True for a secret-looking file name (see the module comment). */
export function isSecretLookingName(name: string): boolean {
  const lower = name.toLowerCase()
  if (SECRET_NAMES.has(lower))
    return true
  if (lower.startsWith('.env.'))
    return !ENV_TEMPLATES.has(lower)
  if (SECRET_EXTENSIONS.some(extension => lower.endsWith(extension)))
    return true
  if (SECRET_PREFIXES.some(prefix => lower.startsWith(prefix)))
    return true
  if (lower.startsWith('credentials') && lower.endsWith('.json'))
    return true
  return lower.startsWith('secrets.')
}

/** True when the file name of a project-relative POSIX path is secret-looking. */
export function isSecretLookingPath(path: string): boolean {
  return isSecretLookingName(baseNameOf(path))
}

/** True when a segment of a project-relative POSIX path starts with `.` (`.` and `..` themselves excepted). */
export function isHiddenWorkspacePath(path: string): boolean {
  return segmentsOf(path).some(segment => segment !== '..' && segment.startsWith('.'))
}
