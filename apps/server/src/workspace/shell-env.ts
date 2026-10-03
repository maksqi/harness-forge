// The environment of a `shell` tool command (ADR-033, ARCHITECTURE.md 6.13 "The shell runner"): an allowlist of the
// server's variables plus a fixed set that keeps tools non-interactive and their output plain. Everything else stays
// out, by construction: `HF_*` (the password, the master key), provider keys (`OPENAI_API_KEY`, ...), `NODE_ENV`,
// cloud credentials. Compare `stdioEnvironment` of the MCP stdio transport (a shorter list, no fixed values).
import process from 'node:process'

/** Variables a shell command inherits from the server process, when they are set. */
export const SHELL_ENV_ALLOWLIST = ['HOME', 'LOGNAME', 'USER', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'] as const

/** Variables every shell command gets (plus `SHELL` = the shell binary). */
export const SHELL_ENV_FIXED = {
  TERM: 'dumb',
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
} as const satisfies Record<string, string>

/** `PATH` when the server process has none (the usual default of `sh`). */
export const SHELL_DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/**
 * The environment of a shell command run by `shell` (the binary, e.g. `/bin/bash`): the allowlisted variables of
 * `parentEnv` (values starting with `()`, exported shell functions, are skipped), then `SHELL` and `SHELL_ENV_FIXED`.
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
    env[key] = value
  }
  env.PATH ??= SHELL_DEFAULT_PATH
  env.SHELL = shell
  Object.assign(env, SHELL_ENV_FIXED)
  return env
}
