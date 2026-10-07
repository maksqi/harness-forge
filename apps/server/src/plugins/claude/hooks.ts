// Hooks of a Claude Code plugin (Phase 12, ADR-053 / ADR-057; W12.1-T5; server-plugins.md D14): `hooks/hooks.json` and
// the hook files of `plugin.json` (each with the `{ "hooks": … }` wrapper) and its inline event maps, merged per event
// in that order and read with the shared `readHooksConfig(…, { source: 'plugin', prompts: true })`. Unknown events and
// unsupported handler types (`http`, `mcp_tool`, `agent`) stay diagnostics (the plugin stays active); a shell-form
// handler using `${user_config.*}` is refused by the reader (an error diagnostic: it never runs). More than
// `LIMITS.pluginHooksMax` handlers are trimmed (with a diagnostic) before the registration, whose validation throws
// above that. Every command handler of any event (supported or not) is an executable of the trust consent, so a host
// upgrade can never run a handler nobody reviewed. Commands and prompts are never logged.
import type { HooksConfig } from '@harness-forge/plugin-sdk'
import type { ClaudeDiagnostic, ClaudePluginExecutable, HookDiagnostic } from '@harness-forge/shared'
import type { UnsupportedPart } from './layout.ts'
import type { ClaudeHooksComponent } from './types.ts'
import { HOOK_LIMITS, httpUrlSchema, LIMITS, readHooksConfig } from '@harness-forge/shared'
import { readFailureMessage, readPluginTextFile } from './files.ts'

/** Where the inline hooks of `plugin.json` are reported. */
const MANIFEST_PATH = '.claude-plugin/plugin.json'
/** Handler types Claude Code has that never run here. */
const UNSUPPORTED_TYPES: Readonly<Record<string, string>> = {
  http: 'HTTP hook handlers are not supported; they never run.',
  mcp_tool: 'MCP tool hook handlers are not supported; they never run.',
  agent: 'Agent hook handlers are not supported; they never run.',
}

export interface ClaudeHooksInput {
  /** The plugin folder (canonical realpath). */
  readonly root: string
  /** `hooks/hooks.json` and the `plugin.json` hook files, in merge order. */
  readonly files: readonly string[]
  /** The inline event maps of `plugin.json`, in merge order (after the files). */
  readonly inline: readonly unknown[]
}

export interface ClaudeHooksRead {
  readonly component: ClaudeHooksComponent
  /** Every command handler declared (any event), as written: what the trust consent lists. */
  readonly executables: readonly ClaudePluginExecutable[]
  /** Hosts of `http` handlers (never contacted; listed for the inspection). */
  readonly hosts: readonly string[]
  readonly unsupported: readonly UnsupportedPart[]
  readonly diagnostics: readonly ClaudeDiagnostic[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A hook diagnostic of the reader as a plugin diagnostic. */
export function hookDiagnostic(item: HookDiagnostic, path?: string): ClaudeDiagnostic {
  const file = item.file ?? path
  return {
    level: item.level,
    code: item.code,
    message: item.message,
    component: item.event === undefined ? 'hooks' : `hooks.${item.event}`,
    ...(file === undefined ? {} : { path: file }),
  }
}

/** The handlers of a raw event map, with their event, group matcher and handler object. */
function* handlersOf(config: Record<string, unknown>): Generator<{ event: string, matcher: string | null, handler: unknown }> {
  for (const [event, groups] of Object.entries(config)) {
    if (!Array.isArray(groups))
      continue
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks))
        continue
      const matcher = typeof group.matcher === 'string' && group.matcher.trim() !== '' ? group.matcher.trim() : null
      for (const handler of group.hooks)
        yield { event, matcher, handler }
    }
  }
}

/** The command line of a command handler as written (`command` and its exec-form `args`), or null. */
function commandLine(handler: unknown): string | null {
  if (!isRecord(handler) || handler.type !== 'command' || typeof handler.command !== 'string' || handler.command.trim() === '')
    return null
  const args = Array.isArray(handler.args) ? handler.args.filter((arg): arg is string => typeof arg === 'string') : []
  return [handler.command.trim(), ...args].join(' ').slice(0, 4096)
}

/** `config` with at most `max` handlers (the first ones, in event and group order); the count before trimming. */
function trimHandlers(config: Record<string, unknown[]>, max: number): { config: Record<string, unknown[]>, declared: number } {
  let left = max
  let declared = 0
  const trimmed: Record<string, unknown[]> = {}
  for (const [event, groups] of Object.entries(config)) {
    const kept: unknown[] = []
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        kept.push(group)
        continue
      }
      declared += group.hooks.length
      const take = group.hooks.slice(0, Math.max(0, left))
      left -= take.length
      if (take.length > 0)
        kept.push({ ...group, hooks: take })
    }
    if (kept.length > 0)
      trimmed[event] = kept
  }
  return { config: trimmed, declared }
}

/** Reads and merges the hooks of a Claude Code plugin (see the module comment). Never throws. */
export async function readClaudeHooks(input: ClaudeHooksInput): Promise<ClaudeHooksRead> {
  const diagnostics: ClaudeDiagnostic[] = []
  const hookDiagnostics: HookDiagnostic[] = []
  const merged: Record<string, unknown[]> = {}
  const add = (map: Record<string, unknown>, path: string): void => {
    const read = readHooksConfig(map, { source: 'plugin', prompts: true, file: path })
    hookDiagnostics.push(...read.diagnostics)
    for (const [event, groups] of Object.entries(map)) {
      if (Array.isArray(groups))
        merged[event] = [...(merged[event] ?? []), ...groups]
    }
  }
  for (const file of input.files) {
    const read = await readPluginTextFile(input.root, file, HOOK_LIMITS.configBytes)
    if (!read.ok) {
      diagnostics.push({ level: 'error', code: 'read-failed', message: readFailureMessage(file, read.reason, HOOK_LIMITS.configBytes), component: 'hooks', path: file })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(read.text.startsWith('\uFEFF') ? read.text.slice(1) : read.text)
    }
    catch {
      diagnostics.push({ level: 'error', code: 'invalid-json', message: `${file} is not valid JSON; its hooks are not used.`, component: 'hooks', path: file })
      continue
    }
    if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
      diagnostics.push({ level: 'error', code: 'not-an-object', message: `${file} must hold an object with a "hooks" object; its hooks are not used.`, component: 'hooks', path: file })
      continue
    }
    add(parsed.hooks, file)
  }
  input.inline.forEach((map) => {
    if (isRecord(map))
      add(map, MANIFEST_PATH)
  })

  const executables: ClaudePluginExecutable[] = []
  const hosts: string[] = []
  const unsupported: UnsupportedPart[] = []
  for (const { event, matcher, handler } of handlersOf(merged)) {
    const line = commandLine(handler)
    if (line !== null)
      executables.push({ kind: 'hook', label: `${event} ${matcher ?? '*'}`.slice(0, 200), command: line })
    const type = isRecord(handler) && typeof handler.type === 'string' ? handler.type : null
    if (type !== null && Object.hasOwn(UNSUPPORTED_TYPES, type)) {
      const component = `hooks.${event} (${type})`
      if (!unsupported.some(part => part.component === component))
        unsupported.push({ component, reason: UNSUPPORTED_TYPES[type] as string })
      if (type === 'http' && isRecord(handler) && typeof handler.url === 'string' && httpUrlSchema.safeParse(handler.url).success) {
        const host = new URL(handler.url).hostname
        if (!hosts.includes(host))
          hosts.push(host)
      }
    }
  }

  const { config, declared } = trimHandlers(merged, LIMITS.pluginHooksMax)
  if (declared > LIMITS.pluginHooksMax)
    diagnostics.push({ level: 'warning', code: 'too-many', message: `The plugin declares ${declared} hook handlers; only the first ${LIMITS.pluginHooksMax} are used.`, component: 'hooks' })
  const final = readHooksConfig(config, { source: 'plugin', prompts: true })
  for (const item of hookDiagnostics)
    diagnostics.push(hookDiagnostic(item))
  return {
    component: { config: config as HooksConfig, commands: final.items, prompts: final.prompts, diagnostics: hookDiagnostics },
    executables,
    hosts,
    unsupported,
    diagnostics,
  }
}
