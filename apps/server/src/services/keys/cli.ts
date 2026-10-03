// Offline master-key rotation: `node apps/server/dist/main.mjs rotate-key [--force]` (root script `pnpm key:rotate`;
// Phase 7, ADR-034, ARCHITECTURE.md 6.14). Owner: W7.7 (W7.7-T5); C16 stub with the final entry point.
//
// `main.ts` dispatches on `argv[2] === ROTATE_KEY_COMMAND` before it loads anything else and exits with the code
// `runRotateKeyCommand` resolves: 0 done, 1 failed, 2 refused (a server runs on the data directory, or the lock names
// another host without `--force`). The CLI writes to stderr only and never prints a key. The stub refuses to run.
import process from 'node:process'

/** `argv[2]` that selects the CLI instead of the server. */
export const ROTATE_KEY_COMMAND = 'rotate-key'

/** Exit codes of the CLI. */
export const CLI_EXIT = Object.freeze({ done: 0, failed: 1, refused: 2 })

export interface RotateKeyCommandIo {
  /** Where the summary and errors go (default `process.stderr`). */
  readonly stderr?: { write: (text: string) => unknown }
  /** Environment variables (default `process.env`). */
  readonly vars?: Readonly<Record<string, string | undefined>>
}

/** True when `argv` (as `process.argv`) selects the rotation CLI. */
export function isRotateKeyCommand(argv: readonly string[]): boolean {
  return argv[2] === ROTATE_KEY_COMMAND
}

/**
 * Runs the CLI with the arguments after `rotate-key` and resolves with the exit code (never rejects; `main.ts` calls
 * `process.exit` with it). Stub: reports that the command is not available yet and resolves 1.
 */
export async function runRotateKeyCommand(_args: readonly string[], io: RotateKeyCommandIo = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr
  stderr.write(`harness-forge ${ROTATE_KEY_COMMAND}: the offline key rotation is not implemented yet.\n`)
  return CLI_EXIT.failed
}
