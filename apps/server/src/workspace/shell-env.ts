// The environment of a `shell` tool command (ADR-033, ARCHITECTURE.md 6.13 "The shell runner"): an allowlist of the
// server's variables plus a fixed set that keeps tools non-interactive and their output plain. Everything else stays
// out, by construction: `HF_*` (the password, the master key), provider keys (`OPENAI_API_KEY`, ...), `NODE_ENV`,
// cloud credentials. Compare `stdioEnvironment` of the MCP stdio transport (a shorter list, no fixed values).
//
// Phase 8 (ADR-038): `PATH` keeps only absolute entries (an empty entry or `.` means "the current folder", so `pnpm`
// could resolve to a file the agent wrote into the project), and `CDPATH` is never set: with it, `cd sub` could enter a
// folder other than `<current>/sub`, which the shell rules check (`shellPolicy`) assumes it does not.
import process from 'node:process'

/** Variables a shell command inherits from the server process, when they are set. Never `CDPATH`, `ENV`, `BASH_ENV`. */
export const SHELL_ENV_ALLOWLIST = ['HOME', 'LOGNAME', 'USER', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'] as const

/** Variables every shell command gets (plus `SHELL` = the shell binary). */
export const SHELL_ENV_FIXED = {
  TERM: 'dumb',
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
} as const satisfies Record<string, string>

/** `PATH` when the server process has none, or none of its entries is absolute (the usual default of `sh`). */
export const SHELL_DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/**
 * `PATH` without empty and relative entries (`::`, a leading or trailing `:`, `.`, `bin`, `~/bin`), in order; null when
 * no entry is left. An empty or relative entry is searched relative to the current folder, which is in the project.
 */
export function absolutePathEntries(path: string): string | null {
  const entries = path.split(':').filter(entry => entry.startsWith('/'))
  return entries.length === 0 ? null : entries.join(':')
}

/**
 * The environment of a shell command run by `shell` (the binary, e.g. `/bin/bash`): the allowlisted variables of
 * `parentEnv` (values starting with `()`, exported shell functions, are skipped; `PATH` keeps its absolute entries,
 * else `SHELL_DEFAULT_PATH`), then `SHELL` and `SHELL_ENV_FIXED`.
 */
export function shellEnvironment(
  shell: string,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SHELL_ENV_ALLOWLIST) {
    const value = parentEnv[key]
    if (value === undefined || value === '' || value.startsWith('()'))
      continue
    if (key === 'PATH') {
      const path = absolutePathEntries(value)
      if (path !== null)
        env.PATH = path
      continue
    }
    env[key] = value
  }
  env.PATH ??= SHELL_DEFAULT_PATH
  env.SHELL = shell
  Object.assign(env, SHELL_ENV_FIXED)
  return env
}
