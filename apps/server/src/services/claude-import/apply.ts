// Apply of the home-folder import (ADR-055; W12.3-T4): `POST /claude-import/apply` (fresh auth, checked by the service
// before anything else). The body is checked against the plan the browser saw (`checkApplyBody`: 400 for an unknown
// key, an action the item does not offer, an invalid rename, variables of an unknown server); then the kept files are
// planned again against a fresh baseline and every picked item is re-checked (an item whose status changed meanwhile
// fails with a sentence, never silently does something else) and applied in one pass:
//
// - definitions: one `customizations.importDefinitions` batch (create / overwrite keeping `enabled` / rename through
//   `setDefinitionName`; a command with `` !`cmd` `` spans arrives turned off unless the item says `enable`);
// - hooks: one `hooks.importPersonal` batch (command hooks off unless `enable`; prompt hooks on);
// - MCP servers: the MCP manager's `create` / `update` with the request's fresh-auth options; `${VAR}` /
//   `${VAR:-default}` resolve from the body's `variables` of the item, then the imported `settings.json` `env`, then the
//   default, **never `process.env`** (an unresolved reference fails the item: `needs-variables`); a stdio server arrives
//   turned off unless `enable`, a per-project server of `.claude.json` always turned off;
// - shell rules: global rules through `ShellRuleService.create` (an existing prefix is `unchanged`);
// - tool denies: the tool override `deny` through `ToolService.update`;
// - `CLAUDE.md`: appended to the global instructions after a blank line, or replacing them (at most 20 000 characters,
//   else the item fails); `outputStyle`: the setting (the style must exist or be imported in the same apply); both in
//   one `settings.update`.
//
// Exactly one `customization.changed {}` and one `hooks.changed { projectId: null }` follow every apply (the services
// emit them for their batch; when a batch changed nothing, or there was none, the apply emits the event itself). Never
// throws for an item; messages and warnings name kinds, names and variable NAMES only (never a content, a command, a
// prompt or a value). What arrived turned off is not repeated in `warnings`: the browser knows it from the plan
// (`executable`, the `project-server` warning) and the `enable` it sent; `warnings` holds only what it cannot derive.
// Logs: counts and the duration at `info`.
import type {
  ClaudeHomeFile,
  ClaudeImportAction,
  ClaudeImportApplyBody,
  ClaudeImportApplyResult,
  ClaudeImportBaseline,
  ClaudeImportOutcome,
  ClaudeImportPayload,
  ClaudeImportPlan,
  ClaudeImportPlanItem,
  HookCreate,
  HookEvent,
  McpServerUpdate,
  McpTransportInput,
  SettingsUpdate,
} from '@harness-forge/shared'
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import type { CustomizationImportItem } from '../customizations/types.ts'
import {
  AGENT_NAME_PATTERN,
  CLAUDE_IMPORT_INSTRUCTIONS_MAX_CHARS,
  COMMAND_NAME_PATTERN,
  expandVariables,
  HarnessError,
  isAllowedMcpUrl,
  isHarnessError,
  MCP_SERVER_ID_PATTERN,
  mcpServerInputSchema,
  parseMcpJson,
  planClaudeImport,
} from '@harness-forge/shared'
import { buildClaudeImportBaseline } from './baseline.ts'

/** The answer of one picked item. */
interface ItemResult {
  readonly key: string
  readonly outcome: ClaudeImportOutcome
  readonly id?: string
  readonly message?: string
}

type DefinitionKind = 'agent' | 'command' | 'skill' | 'style'

const DEFINITION_KINDS: ReadonlySet<string> = new Set(['agent', 'command', 'skill', 'style'])

/** The statuses a definition or MCP server may be renamed from. */
const RENAMABLE_STATUSES: ReadonlySet<string> = new Set(['new', 'update', 'conflict'])

const CHANGED = 'The item changed since the folder was read. Read the folder again.'
const MESSAGE_MAX_CHARS = 500
const WARNING_MAX_CHARS = 300

function invalid(message: string, path: Array<string | number>): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

/** Whether `name` may be the new name of an item of `kind` (null when the kind cannot be renamed). */
function validRename(kind: string, name: string): boolean | null {
  if (kind === 'command')
    return COMMAND_NAME_PATTERN.test(name)
  if (kind === 'agent' || kind === 'skill' || kind === 'style')
    return AGENT_NAME_PATTERN.test(name)
  if (kind === 'mcp-server')
    return MCP_SERVER_ID_PATTERN.test(name)
  return null
}

/**
 * The checks against the plan the browser saw: every key is an item of the plan, its action one the item offers, a
 * rename a valid name for the kind, `variables` only for the plan's MCP servers. Throws `validation_error`.
 */
export function checkApplyBody(plan: ClaudeImportPlan, body: ClaudeImportApplyBody): void {
  const items = new Map(plan.items.map(item => [item.key, item]))
  body.items.forEach((picked, index) => {
    const item = items.get(picked.key)
    if (item === undefined)
      throw invalid('The plan has no such item. Read the folder again.', ['items', index, 'key'])
    if (!item.actions.includes(picked.action))
      throw invalid(`The ${item.kind} ${cut(item.name, 64)} cannot be imported with "${picked.action}".`, ['items', index, 'action'])
    if (picked.action === 'rename') {
      const valid = validRename(item.kind, picked.renameTo ?? '')
      if (valid !== true) {
        const rule = item.kind === 'mcp-server'
          ? 'MCP server ids use 1-32 characters of a-z, 0-9 and "-", without a leading or trailing "-".'
          : `Names use lowercase letters, digits and hyphens (a letter first, at most ${item.kind === 'command' ? 32 : 64} characters).`
        throw invalid(rule, ['items', index, 'renameTo'])
      }
    }
  })
  for (const key of Object.keys(body.variables ?? {})) {
    if (items.get(key)?.kind !== 'mcp-server')
      throw invalid('Variables can only be given for the MCP servers of the plan.', ['variables', key])
  }
}

/** What to do with a picked item after the re-check against the fresh plan. */
type Decision
  = | { readonly type: 'do', readonly action: ClaudeImportAction, readonly item: ClaudeImportPlanItem }
    | { readonly type: 'done', readonly outcome: ClaudeImportOutcome, readonly message?: string }

function decide(action: ClaudeImportAction, item: ClaudeImportPlanItem | undefined): Decision {
  if (action === 'skip')
    return { type: 'done', outcome: 'skipped' }
  if (item === undefined)
    return { type: 'done', outcome: 'failed', message: CHANGED }
  if (item.status === 'unsupported' || item.status === 'invalid')
    return { type: 'done', outcome: 'failed', message: item.summary }
  if (item.status === 'unchanged')
    return { type: 'done', outcome: 'unchanged' }
  if (item.actions.includes(action))
    return { type: 'do', action, item }
  if (action === 'rename' && RENAMABLE_STATUSES.has(item.status) && (DEFINITION_KINDS.has(item.kind) || item.kind === 'mcp-server'))
    return { type: 'do', action, item }
  if (action === 'overwrite' && item.status === 'new')
    return { type: 'do', action: 'import', item }
  if (action === 'append' && item.kind === 'instructions')
    return { type: 'done', outcome: 'failed', message: `Appending would make the global instructions longer than ${CLAUDE_IMPORT_INSTRUCTIONS_MAX_CHARS} characters.` }
  return { type: 'done', outcome: 'failed', message: CHANGED }
}

/** A trimmed, non-empty string field of a handler. */
function textField(handler: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = handler[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The personal hook create body of an imported handler (null when it has no command or prompt). */
export function hookCreateOf(payload: Extract<ClaudeImportPayload, { kind: 'hook' }>, enable: boolean): HookCreate | null {
  const handler = payload.handler
  const raw = handler.timeout
  const timeout = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(Math.ceil(raw), 600) : undefined
  const condition = textField(handler, 'if')
  const statusMessage = textField(handler, 'statusMessage')
  const common = {
    event: payload.event as HookEvent,
    ...(payload.matcher === null ? {} : { matcher: payload.matcher }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(condition === undefined ? {} : { if: condition }),
    ...(statusMessage === undefined ? {} : { statusMessage }),
  }
  if (handler.type === 'prompt') {
    const prompt = textField(handler, 'prompt')
    if (prompt === undefined)
      return null
    const model = textField(handler, 'model')
    return {
      type: 'prompt',
      ...common,
      prompt,
      ...(model === undefined ? {} : { model }),
      ...(handler.continueOnBlock === true ? { continueOnBlock: true } : {}),
      enabled: true,
    }
  }
  const command = textField(handler, 'command')
  if (command === undefined)
    return null
  const args = Array.isArray(handler.args) && handler.args.every(arg => typeof arg === 'string') ? [...handler.args as string[]] : undefined
  return {
    type: 'command',
    ...common,
    command,
    ...(args === undefined ? {} : { args }),
    ...(handler.async === true || handler.asyncRewake === true ? { async: true } : {}),
    enabled: enable,
  }
}

/** The values of `${VAR}` references: the imported `env`, overridden by the body's `variables` of the item. */
function variableValues(env: Readonly<Record<string, string>>, given: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries([...Object.entries(env), ...Object.entries(given ?? {})])
}

type ServerTransport = { ok: true, transport: McpTransportInput } | { ok: false, message: string }

/** The transport of an imported server with every reference expanded (never from `process.env`). */
function expandedTransport(payload: Extract<ClaudeImportPayload, { kind: 'mcp-server' }>, values: Readonly<Record<string, string>>): ServerTransport {
  let text: string
  try {
    text = JSON.stringify({ mcpServers: { [payload.name]: payload.raw } })
  }
  catch {
    return { ok: false, message: 'The MCP server is not valid.' }
  }
  const server = parseMcpJson(text).servers[0]
  if (server === undefined)
    return { ok: false, message: 'The MCP server is not valid.' }
  const missing = new Set<string>()
  const expand = (template: string): string => {
    const result = expandVariables(template, values)
    if (result.ok)
      return result.value
    for (const name of result.missing)
      missing.add(name)
    return ''
  }
  const record = (source: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(source).map(([name, value]) => [name, expand(value)]))
  const source = server.transport
  let transport: McpTransportInput
  if (source.type === 'stdio') {
    transport = { type: 'stdio', command: expand(source.command), args: source.args.map(expand), env: record(source.env) }
  }
  else {
    transport = { type: source.type, url: expand(source.url), headers: record(source.headers) }
  }
  if (missing.size > 0)
    return { ok: false, message: cut(`Set the variables ${[...missing].join(', ')} to import this server (needs-variables).`, MESSAGE_MAX_CHARS) }
  if (transport.type !== 'stdio' && !isAllowedMcpUrl(transport.url))
    return { ok: false, message: 'The server URL is not an http or https URL once its variables are filled in.' }
  return { ok: true, transport }
}

/** A sentence for a failed MCP write (never the server's values). */
function mcpFailure(error: unknown, id: string): string {
  if (isHarnessError(error)) {
    switch (error.code) {
      case 'conflict':
        return `An MCP server with the id ${id} already exists.`
      case 'forbidden':
        return error.action === 'login' ? 'Confirm your password, then apply again.' : `The MCP server ${id} belongs to a plugin and cannot be changed.`
      case 'not_found':
        return `The MCP server ${id} no longer exists.`
      case 'validation_error':
        return 'The MCP server is not valid.'
      default:
        break
    }
  }
  return 'The MCP server could not be saved.'
}

export interface ApplyClaudeImportInput {
  readonly files: readonly ClaudeHomeFile[]
  readonly body: ClaudeImportApplyBody
  readonly options?: SensitiveOperationOptions
}

/** Applies the picked items (see the module comment). The body was checked with `checkApplyBody`. */
export async function applyClaudeImport(deps: AppDeps, input: ApplyClaudeImportInput): Promise<ClaudeImportApplyResult> {
  const { body, options } = input
  const started = Date.now()
  const baseline: ClaudeImportBaseline = await buildClaudeImportBaseline(deps)
  const draft = planClaudeImport(input.files, baseline)
  const fresh = new Map(draft.items.map(item => [item.key, item]))
  const results = new Map<string, ItemResult>()
  const warnings: string[] = []
  const set = (key: string, outcome: ClaudeImportOutcome, extra: { id?: string, message?: string } = {}): void => {
    results.set(key, { key, outcome, ...(extra.id === undefined ? {} : { id: extra.id }), ...(extra.message === undefined ? {} : { message: cut(extra.message, MESSAGE_MAX_CHARS) }) })
  }

  const definitions: { key: string, item: ClaudeImportPlanItem, request: CustomizationImportItem }[] = []
  const hookItems: { key: string, request: HookCreate }[] = []
  const later: { key: string, action: ClaudeImportAction, item: ClaudeImportPlanItem, picked: ClaudeImportApplyBody['items'][number] }[] = []
  for (const picked of body.items) {
    const decision = decide(picked.action, fresh.get(picked.key))
    if (decision.type === 'done') {
      set(picked.key, decision.outcome, decision.message === undefined ? {} : { message: decision.message })
      continue
    }
    const { item, action } = decision
    const payload = item.payload
    if (payload.kind === 'definition') {
      definitions.push({
        key: picked.key,
        item,
        request: {
          kind: payload.definitionKind,
          content: payload.content,
          action: action === 'overwrite' ? 'overwrite' : action === 'rename' ? 'rename' : 'create',
          ...(action === 'rename' && picked.renameTo !== undefined ? { renameTo: picked.renameTo } : {}),
          ...(picked.enable === true ? { enable: true } : {}),
        },
      })
    }
    else if (payload.kind === 'hook') {
      const request = hookCreateOf(payload, picked.enable === true)
      if (request === null)
        set(picked.key, 'failed', { message: 'The hook has no command or prompt.' })
      else
        hookItems.push({ key: picked.key, request })
    }
    else {
      later.push({ key: picked.key, action, item, picked })
    }
  }

  // Definitions first: an imported output style can be the default style below.
  const importedStyles = new Set<string>()
  let definitionsChanged = false
  if (definitions.length > 0) {
    try {
      const outcomes = await deps.customizations.importDefinitions(definitions.map(entry => entry.request))
      definitions.forEach((entry, index) => {
        const outcome = outcomes[index]
        if (outcome === undefined || !outcome.ok) {
          set(entry.key, 'failed', { message: outcome?.ok === false ? outcome.message : `The ${entry.item.kind} was not imported.` })
          return
        }
        definitionsChanged = true
        set(entry.key, outcome.outcome, { id: outcome.customization.id })
        if ((entry.item.kind as DefinitionKind) === 'style')
          importedStyles.add(outcome.customization.name)
      })
    }
    catch (error) {
      deps.logger.warn('claude import: the definitions could not be imported', { code: isHarnessError(error) ? error.code : 'internal_error' })
      for (const entry of definitions)
        set(entry.key, 'failed', { message: `The ${entry.item.kind} was not imported.` })
    }
  }

  let hooksChanged = false
  if (hookItems.length > 0) {
    try {
      const outcomes = await deps.hooks.importPersonal(hookItems.map(entry => entry.request))
      hookItems.forEach((entry, index) => {
        const outcome = outcomes[index]
        if (outcome === undefined || !outcome.ok) {
          set(entry.key, 'failed', { message: outcome?.ok === false ? outcome.message : 'The hook was not imported.' })
          return
        }
        hooksChanged = true
        set(entry.key, 'created', { id: outcome.hook.id })
      })
    }
    catch (error) {
      deps.logger.warn('claude import: the hooks could not be imported', { code: isHarnessError(error) ? error.code : 'internal_error' })
      for (const entry of hookItems)
        set(entry.key, 'failed', { message: 'The hook was not imported.' })
    }
  }

  const settingsPatch: SettingsUpdate = {}
  const settingsKeys: { key: string, outcome: ClaudeImportOutcome }[] = []
  let instructionsBefore: string | null = null
  for (const { key, action, item, picked } of later) {
    const payload = item.payload
    switch (payload.kind) {
      case 'mcp-server': {
        const expanded = expandedTransport(payload, variableValues(draft.env, body.variables?.[key]))
        if (!expanded.ok) {
          set(key, 'failed', { message: expanded.message })
          break
        }
        const project = payload.project !== undefined
        const stdio = expanded.transport.type === 'stdio'
        const enabled = project ? false : stdio ? picked.enable === true : true
        const id = action === 'rename' && picked.renameTo !== undefined ? picked.renameTo : payload.id
        const parsed = mcpServerInputSchema.safeParse({ id, name: payload.name.trim().slice(0, 64) || id, transport: expanded.transport, enabled })
        if (!parsed.success) {
          const where = parsed.error.issues[0]?.path.filter(part => typeof part === 'string' || typeof part === 'number').join('.') ?? ''
          set(key, 'failed', { message: `The MCP server is not valid${where === '' ? '' : ` (${where})`}.` })
          break
        }
        try {
          if (action === 'overwrite') {
            const patch: McpServerUpdate = { name: parsed.data.name, transport: parsed.data.transport, ...(stdio || project ? { enabled } : {}) }
            const server = await deps.mcp.update(id, patch, options)
            set(key, 'updated', { id: server.id })
          }
          else {
            const server = await deps.mcp.create(parsed.data, options)
            set(key, 'created', { id: server.id })
          }
        }
        catch (error) {
          set(key, 'failed', { message: mcpFailure(error, id) })
        }
        break
      }
      case 'shell-rule': {
        try {
          const rule = await deps.shellRules.create({ projectId: null, prefix: payload.prefix })
          set(key, 'created', { id: rule.id })
        }
        catch (error) {
          if (isHarnessError(error) && error.code === 'conflict' && (error.details as { reason?: unknown } | undefined)?.reason === 'exists')
            set(key, 'unchanged')
          else
            set(key, 'failed', { message: isHarnessError(error) && error.code === 'validation_error' ? error.message : 'The shell rule could not be saved.' })
        }
        break
      }
      case 'tool-deny': {
        const missing: string[] = []
        let failed = false
        for (const tool of payload.tools) {
          try {
            await deps.tools.update(tool, { override: 'deny' })
          }
          catch (error) {
            if (isHarnessError(error) && error.code === 'not_found')
              missing.push(tool)
            else
              failed = true
          }
        }
        if (missing.length > 0)
          set(key, 'failed', { message: `The ${missing.length === 1 ? 'tool' : 'tools'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not available on this server.` })
        else if (failed)
          set(key, 'failed', { message: 'The tool override could not be saved.' })
        else
          set(key, 'created')
        break
      }
      case 'instructions': {
        const mode = action === 'replace' ? 'replace' : action === 'append' ? 'append' : body.instructions ?? 'append'
        instructionsBefore ??= baseline.instructions
        const current = instructionsBefore
        const next = mode === 'replace' || current.trim() === '' ? payload.text : `${current.trimEnd()}\n\n${payload.text}`
        if (next.length > CLAUDE_IMPORT_INSTRUCTIONS_MAX_CHARS) {
          set(key, 'failed', { message: `The global instructions would be longer than ${CLAUDE_IMPORT_INSTRUCTIONS_MAX_CHARS} characters.` })
          break
        }
        settingsPatch.instructions = next
        settingsKeys.push({ key, outcome: current.trim() === '' ? 'created' : 'updated' })
        break
      }
      case 'setting': {
        if (!baseline.styles.includes(payload.value) && !importedStyles.has(payload.value)) {
          set(key, 'failed', { message: `The output style ${payload.value} is not available; import it too.` })
          break
        }
        settingsPatch.outputStyle = payload.value
        settingsKeys.push({ key, outcome: 'updated' })
        break
      }
      default:
        set(key, 'failed', { message: CHANGED })
    }
  }
  if (settingsKeys.length > 0) {
    try {
      await deps.settings.update(settingsPatch)
      for (const entry of settingsKeys)
        set(entry.key, entry.outcome)
    }
    catch (error) {
      deps.logger.warn('claude import: the settings could not be saved', { code: isHarnessError(error) ? error.code : 'internal_error' })
      for (const entry of settingsKeys)
        set(entry.key, 'failed', { message: 'The setting could not be saved.' })
    }
  }

  // Exactly one event of each kind per apply (see the module comment).
  if (!definitionsChanged)
    deps.events.emit('customization.changed', {})
  if (!hooksChanged)
    deps.events.emit('hooks.changed', { projectId: null })

  const ordered = body.items.map(picked => results.get(picked.key) ?? { key: picked.key, outcome: 'failed' as const, message: CHANGED })
  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
  for (const result of ordered)
    counts[result.outcome] += 1
  deps.logger.info('claude import applied', { ...counts, durationMs: Date.now() - started })
  return { results: ordered, counts, warnings: warnings.map(warning => cut(warning, WARNING_MAX_CHARS)) }
}
