// Hook scripts of the tests and the gate probes (Phase 11, ADR-048; PROVIDERS.md 8 "Hook mocks (Phase 11)"; C38-T6,
// FROZEN after Gate P11-0b). Each script is a POSIX `sh` file written into a temporary project (default folder
// `.harness/hooks`, so the trust hash of a project hook covers it through `extractCommandFileRefs`) and invoked as
// `sh <relative path>` from the project folder: never an inline `sh -c` string. The scripts are busybox / dash
// compatible (`$(cat)`, `printf`, `grep -q`, `sed -n 's/…/\1/p'`, `${VAR:-.}`; no `jq`, no bash syntax) and each one
// reads its stdin (the JSON payload) first.
//
//   deny          PreToolUse `permissionDecision: deny` with `HOOK_SCRIPT_TEXT.deny` as the reason
//   ask           PreToolUse `permissionDecision: ask` with `HOOK_SCRIPT_TEXT.ask`
//   allow         PreToolUse `permissionDecision: allow` with `HOOK_SCRIPT_TEXT.allow`
//   rewrite       PreToolUse `updatedInput` `{"command":"echo rewritten"}` (no decision)
//   context       `hookSpecificOutput.additionalContext` = `HOOK_SCRIPT_TEXT.context` (`lint ok`), with the payload's
//                 `hook_event_name` as `hookEventName` (PostToolUse, UserPromptSubmit and SessionStart read it)
//   exit2         stderr `nope`, exit 2 (a block where the event can block)
//   error         stderr `hook failed`, exit 1 (a non-blocking error)
//   sleep         starts `sleep <seconds>` in the background, appends "<script pid> <sleep pid>" to
//                 `$HARNESS_PROJECT_DIR/.hook-sleep-pids`, then waits: outlives any short timeout, and the test can
//                 prove that both pids are gone after the kill
//   record        appends the payload (one JSON line) to `$HARNESS_PROJECT_DIR/.hook-log`
//   env           writes `env` to `$HARNESS_PROJECT_DIR/.hook-env`
//   stop-once     exit 0 when the payload holds `"stop_hook_active":true`, else prints
//                 `{"decision":"block","reason":"run the tests"}`
//   prompt-block  stderr `Prompt blocked by hook.`, exit 2 (a UserPromptSubmit block)
//
// Files go to `$HARNESS_PROJECT_DIR` (`.` when it is unset: the hook's working folder). `text` replaces the fixed text
// of a script (the reason, the context, the stderr line, the rewritten command), `seconds` the sleep of `sleep`, `dir`
// / `file` the location (`<dir>/<file>.sh`), so two variants of one script can live side by side.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HOOK_SCRIPT_NAMES = [
  'deny',
  'ask',
  'allow',
  'rewrite',
  'context',
  'exit2',
  'error',
  'sleep',
  'record',
  'env',
  'stop-once',
  'prompt-block',
] as const
export type HookScriptName = (typeof HOOK_SCRIPT_NAMES)[number]

/** The folder of the scripts, relative to the project (default of `HookScriptOptions.dir`). */
export const HOOK_SCRIPT_DIR = '.harness/hooks'
/** `record` appends one payload per line here (in `$HARNESS_PROJECT_DIR`). */
export const HOOK_LOG_FILE = '.hook-log'
/** `env` writes the environment here (in `$HARNESS_PROJECT_DIR`). */
export const HOOK_ENV_FILE = '.hook-env'
/** `sleep` appends "<script pid> <sleep pid>" here (in `$HARNESS_PROJECT_DIR`). */
export const HOOK_SLEEP_PIDS_FILE = '.hook-sleep-pids'
/** Seconds `sleep` sleeps by default (far beyond any test timeout). */
export const HOOK_SLEEP_DEFAULT_SECONDS = 30

/** The fixed texts of the scripts (the default of `HookScriptOptions.text`). */
export const HOOK_SCRIPT_TEXT = {
  deny: 'Denied by the deny hook.',
  ask: 'The ask hook wants a confirmation.',
  allow: 'Allowed by the allow hook.',
  rewriteCommand: 'echo rewritten',
  context: 'lint ok',
  exit2: 'nope',
  error: 'hook failed',
  stop: 'run the tests',
  promptBlock: 'Prompt blocked by hook.',
} as const

export interface HookScriptOptions {
  /** Folder relative to the project (default `HOOK_SCRIPT_DIR`); `.` or '' for the project folder itself. */
  dir?: string
  /** File name without `.sh` (default the script name). */
  file?: string
  /** Replaces the script's fixed text (see the module comment); ignored by `sleep`, `record` and `env`. */
  text?: string
  /** `sleep`: seconds to sleep (default `HOOK_SLEEP_DEFAULT_SECONDS`). */
  seconds?: number
}

const FILE_NAME = /^[\w.-]+$/
const DIR_SEGMENT = /^[\w.-]+$/
const ENV_LINE = /^([A-Z_]\w*)=(.*)$/i

/** `value` as one single-quoted `sh` word. */
function shQuote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/** A line that prints `value` and a newline to stdout (`>&2` for stderr). */
function printLine(value: string, stderr = false): string {
  return `printf '%s\\n' ${shQuote(value)}${stderr ? ' >&2' : ''}`
}

/** The file the scripts write into: `$HARNESS_PROJECT_DIR/<name>`, `./<name>` without the variable. */
function projectFile(name: string): string {
  return `"\${HARNESS_PROJECT_DIR:-.}/${name}"`
}

function checkedText(text: string | undefined, fallback: string): string {
  const value = text ?? fallback
  if (typeof value !== 'string' || value.includes('\0'))
    throw new TypeError('A hook script text must be a string without NUL characters.')
  return value
}

function checkedDir(dir: string | undefined): string {
  const value = dir ?? HOOK_SCRIPT_DIR
  if (value === '' || value === '.')
    return ''
  const segments = value.split('/')
  if (value.startsWith('/') || segments.some(segment => segment === '' || segment === '..' || !DIR_SEGMENT.test(segment)))
    throw new TypeError(`The hook script folder ${JSON.stringify(value)} must be a plain relative path.`)
  return value
}

function checkedFile(name: HookScriptName, file: string | undefined): string {
  const value = file ?? name
  if (!FILE_NAME.test(value) || value === '.' || value === '..')
    throw new TypeError(`The hook script file name ${JSON.stringify(value)} is not valid.`)
  return value
}

function assertName(name: HookScriptName): void {
  if (!(HOOK_SCRIPT_NAMES as readonly string[]).includes(name))
    throw new TypeError(`Unknown hook script ${JSON.stringify(name)}.`)
}

/** The project-relative path of a script: `<dir>/<file>.sh` (`.harness/hooks/deny.sh`). */
export function hookScriptPath(name: HookScriptName, options: HookScriptOptions = {}): string {
  assertName(name)
  const dir = checkedDir(options.dir)
  const file = `${checkedFile(name, options.file)}.sh`
  return dir === '' ? file : `${dir}/${file}`
}

/** The hook command of a script: `sh <relative path>` (run from the project folder). */
export function hookScriptCommand(name: HookScriptName, options: HookScriptOptions = {}): string {
  return `sh ${hookScriptPath(name, options)}`
}

function decision(kind: 'deny' | 'ask' | 'allow', reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: kind, permissionDecisionReason: reason } })
}

/** The body lines of a script after the header (each reads stdin first). */
function body(name: HookScriptName, options: HookScriptOptions): string[] {
  const discard = 'cat > /dev/null'
  switch (name) {
    case 'deny':
      return [discard, printLine(decision('deny', checkedText(options.text, HOOK_SCRIPT_TEXT.deny)))]
    case 'ask':
      return [discard, printLine(decision('ask', checkedText(options.text, HOOK_SCRIPT_TEXT.ask)))]
    case 'allow':
      return [discard, printLine(decision('allow', checkedText(options.text, HOOK_SCRIPT_TEXT.allow)))]
    case 'rewrite': {
      const command = checkedText(options.text, HOOK_SCRIPT_TEXT.rewriteCommand)
      return [discard, printLine(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command } } }))]
    }
    case 'context': {
      const context = JSON.stringify(checkedText(options.text, HOOK_SCRIPT_TEXT.context))
      return [
        'payload=$(cat)',
        // The payload is one JSON line; an escaped `\"hook_event_name\"` inside a string never matches.
        'event=$(printf \'%s\' "$payload" | sed -n \'s/.*"hook_event_name":"\\([A-Za-z]*\\)".*/\\1/p\')',
        `printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":%s}}\\n' "$event" ${shQuote(context)}`,
      ]
    }
    case 'exit2':
      return [discard, printLine(checkedText(options.text, HOOK_SCRIPT_TEXT.exit2), true), 'exit 2']
    case 'error':
      return [discard, printLine(checkedText(options.text, HOOK_SCRIPT_TEXT.error), true), 'exit 1']
    case 'sleep': {
      const seconds = options.seconds ?? HOOK_SLEEP_DEFAULT_SECONDS
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600)
        throw new TypeError('The seconds of the sleep hook script must be an integer from 0 to 3600.')
      return [
        discard,
        `sleep ${seconds} &`,
        `printf '%s %s\\n' "$$" "$!" >> ${projectFile(HOOK_SLEEP_PIDS_FILE)}`,
        'wait',
      ]
    }
    case 'record':
      return ['payload=$(cat)', `printf '%s\\n' "$payload" >> ${projectFile(HOOK_LOG_FILE)}`]
    case 'env':
      return [discard, `env > ${projectFile(HOOK_ENV_FILE)}`]
    case 'stop-once':
      return [
        'payload=$(cat)',
        'if printf \'%s\' "$payload" | grep -q \'"stop_hook_active":true\'; then',
        '  exit 0',
        'fi',
        printLine(JSON.stringify({ decision: 'block', reason: checkedText(options.text, HOOK_SCRIPT_TEXT.stop) })),
      ]
    case 'prompt-block':
      return [discard, printLine(checkedText(options.text, HOOK_SCRIPT_TEXT.promptBlock), true), 'exit 2']
  }
}

/** The text of a script (POSIX `sh`; see the module comment). */
export function hookScriptSource(name: HookScriptName, options: HookScriptOptions = {}): string {
  assertName(name)
  return [
    '#!/bin/sh',
    `# harness-forge test hook "${name}" (apps/server/src/testing/hook-scripts.ts): POSIX sh, reads stdin first.`,
    ...body(name, options),
    '',
  ].join('\n')
}

/** Writes one script into `projectDir` (the folder is created) and returns its command (`sh <relative path>`). */
export async function writeHookScript(projectDir: string, name: HookScriptName, options: HookScriptOptions = {}): Promise<string> {
  const path = hookScriptPath(name, options)
  const source = hookScriptSource(name, options)
  const dir = checkedDir(options.dir)
  if (dir !== '')
    await mkdir(join(projectDir, dir), { recursive: true })
  const target = join(projectDir, path)
  await writeFile(target, source, { encoding: 'utf8', mode: 0o755 })
  await chmod(target, 0o755)
  return hookScriptCommand(name, options)
}

/** Writes several scripts (default: all of them) and returns their commands by name. */
export async function writeHookScripts(
  projectDir: string,
  names: readonly HookScriptName[] = HOOK_SCRIPT_NAMES,
  options: Omit<HookScriptOptions, 'file'> = {},
): Promise<Partial<Record<HookScriptName, string>>> {
  const commands: Partial<Record<HookScriptName, string>> = {}
  for (const name of names)
    commands[name] = await writeHookScript(projectDir, name, options)
  return commands
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return ''
    throw error
  }
}

/** The payloads `record` appended (parsed JSON; a line that is not JSON stays a string); [] without the file. */
export async function readHookLog(projectDir: string): Promise<unknown[]> {
  const text = await readOptional(join(projectDir, HOOK_LOG_FILE))
  return text.split('\n').filter(line => line.trim() !== '').map((line) => {
    try {
      return JSON.parse(line) as unknown
    }
    catch {
      return line
    }
  })
}

/** The environment `env` wrote (`NAME=value` lines; continuation lines of multi-line values are skipped); {} without it. */
export async function readHookEnv(projectDir: string): Promise<Record<string, string>> {
  const text = await readOptional(join(projectDir, HOOK_ENV_FILE))
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = line.match(ENV_LINE)
    if (match !== null)
      env[match[1]!] = match[2]!
  }
  return env
}

/** Every pid `sleep` recorded (the script's and its background `sleep`'s); [] without the file. */
export async function readSleepPids(projectDir: string): Promise<number[]> {
  const text = await readOptional(join(projectDir, HOOK_SLEEP_PIDS_FILE))
  return text.split(/\s+/).map(word => Number.parseInt(word, 10)).filter(pid => Number.isInteger(pid) && pid > 0)
}
