// Pure helpers of the Import from Claude Code dialog (Phase 12, ADR-055; docs/UI.md 9.14, 11.9): the browser-side filter
// of a picked `.claude` folder (`pickClaudeFiles`, over the shared allowlist `isClaudeHomeImportPath` and the caps of
// `CLAUDE_HOME_LIMITS`: it guards the upload, so it is complete from P12-0b), the preview groups, the default selection,
// the tri-state of a group's Select all, which password prompt the apply needs, the apply body, the result lines and the
// status words. The plan is built on the server; nothing here parses a file or a zip. No Vue, no stores.
// W12.10 adds the item notes (`KIND_TEXT`, `WARNING_TEXT`, `turnedOffNote`, `canEnable`), the `CLAUDE.md` mode sync
// (`syncInstructions`), the footer and result helpers (`executableCount`, `turnedOffLines`, `resultTab`,
// `importedServers`) and the error copy (`importErrorText`). W12.17: the server sends no per-item "imported turned off"
// sentence (`ClaudeImportApplyResult.warnings` never says it), so the result shows every server warning as it is.
// Signatures frozen from Gate P12-0b (C46); W12.10 owns the bodies other than `pickClaudeFiles` (P12-A).
import type {
  ClaudeImportAction,
  ClaudeImportApplyBody,
  ClaudeImportApplyResult,
  ClaudeImportKind,
  ClaudeImportPlan,
  ClaudeImportStatus,
  ClaudeImportWarning,
  HarnessError,
} from '@harness-forge/shared'
import type { CustomizeTab } from '~/components/settings/customize/customize'
import { classifyClaudeHomePath, CLAUDE_HOME_LIMITS, normalizeClaudeHomePath } from '@harness-forge/shared'
import { CUSTOMIZE_TAB_VALUES } from '~/components/settings/customize/customize'

/** What the user picked for one plan item (an item without a choice is not imported). */
export interface ClaudeImportChoice {
  action: ClaudeImportAction
  /** `rename`: the new name. */
  renameTo?: string
  /** Executable items (command hooks, `!` commands, stdio MCP servers): import them turned on. */
  enable?: boolean
  /** `${VAR}` values of an MCP server (sent only with the apply). */
  variables?: Record<string, string>
}

/** The picked items by plan item key and the `CLAUDE.md` mode. */
export interface ClaudeImportSelection {
  items: Record<string, ClaudeImportChoice>
  instructions: 'append' | 'replace' | 'skip'
}

/** One group of the preview (docs/UI.md 9.14): a kind, or `unsupported` for the unsupported and invalid items. */
export interface ClaudeImportGroupView {
  kind: ClaudeImportKind | 'unsupported'
  title: string
  items: ClaudeImportPlan['items']
  /** It holds items that run commands on this server. */
  executable: boolean
}

type PlanItem = ClaudeImportPlan['items'][number]

/** The status words of the preview (never color alone). */
export const STATUS_TEXT: Readonly<Record<ClaudeImportStatus, string>> = {
  new: 'New',
  update: 'Replaces yours',
  unchanged: 'Unchanged',
  conflict: 'Conflict',
  unsupported: 'Unsupported',
  invalid: 'Invalid',
}

/** The selectable groups in preview order, with their titles; `unsupported` comes last. */
export const GROUP_TITLES: Readonly<Partial<Record<ClaudeImportKind | 'unsupported', string>>> = {
  'agent': 'Agents',
  'command': 'Commands',
  'skill': 'Skills',
  'style': 'Output styles',
  'hook': 'Hooks',
  'mcp-server': 'MCP servers',
  'shell-rule': 'Allowed shell commands',
  'tool-deny': 'Denied tools',
  'instructions': 'Instructions',
  'setting': 'Settings',
  'unsupported': 'Unsupported',
}

const GROUP_ORDER: readonly (ClaudeImportKind | 'unsupported')[] = [
  'agent',
  'command',
  'skill',
  'style',
  'hook',
  'mcp-server',
  'shell-rule',
  'tool-deny',
  'instructions',
  'setting',
  'unsupported',
]

// ---------- the folder picker ----------

/** The per-file byte cap of an allowlisted path kind. */
function fileCap(kind: NonNullable<ReturnType<typeof classifyClaudeHomePath>>): number {
  switch (kind) {
    case 'settings':
      return CLAUDE_HOME_LIMITS.settingsBytes
    case 'instructions':
      return CLAUDE_HOME_LIMITS.claudeMdBytes
    case 'claude-json':
      return CLAUDE_HOME_LIMITS.claudeJsonBytes
    default:
      return CLAUDE_HOME_LIMITS.definitionBytes
  }
}

/**
 * The path of a picked file relative to the picked folder: `webkitRelativePath` without its first segment (the picked
 * folder's own name), else the file name; null when that path is not normalizable.
 */
export function claudeRelativePath(file: Pick<File, 'name'> & { webkitRelativePath?: string }): string | null {
  const relative = file.webkitRelativePath ?? ''
  const path = relative === '' ? file.name : relative.split('/').slice(1).join('/')
  return normalizeClaudeHomePath(path)
}

/**
 * The files of a picked `.claude` folder the browser may send (docs/UI.md 9.14): only allowlisted paths
 * (`isClaudeHomeImportPath`, relative to the picked folder; a `.claude.json` inside the folder is not `~/.claude.json`
 * and is skipped), each within its byte cap (else listed in `tooLarge`), at most `definitionsPerKindMax` definitions per
 * kind, `itemsMax` files and `totalBytes` in total (the rest is counted in `skipped`). Kept files are renamed to their
 * relative path (the upload's part file name) and sorted by it. The files are never read.
 */
export function pickClaudeFiles(files: FileList | readonly File[]): { files: File[], skipped: number, tooLarge: string[] } {
  const candidates: { path: string, file: File, kind: NonNullable<ReturnType<typeof classifyClaudeHomePath>> }[] = []
  let skipped = 0
  for (const file of Array.from(files as ArrayLike<File>)) {
    const path = claudeRelativePath(file)
    const kind = path === null ? null : classifyClaudeHomePath(path)
    if (path === null || kind === null || kind === 'claude-json') {
      skipped += 1
      continue
    }
    candidates.push({ path, file, kind })
  }
  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const kept: File[] = []
  const tooLarge: string[] = []
  const perKind = new Map<string, number>()
  const seen = new Set<string>()
  let total = 0
  for (const { path, file, kind } of candidates) {
    if (seen.has(path)) {
      skipped += 1
      continue
    }
    seen.add(path)
    if (file.size > fileCap(kind)) {
      tooLarge.push(path)
      continue
    }
    const definition = kind === 'agent' || kind === 'command' || kind === 'skill' || kind === 'style'
    const count = perKind.get(kind) ?? 0
    if ((definition && count >= CLAUDE_HOME_LIMITS.definitionsPerKindMax)
      || kept.length >= CLAUDE_HOME_LIMITS.itemsMax
      || total + file.size > CLAUDE_HOME_LIMITS.totalBytes) {
      skipped += 1
      continue
    }
    perKind.set(kind, count + 1)
    total += file.size
    kept.push(file.name === path ? file : new File([file], path, { type: file.type, lastModified: file.lastModified }))
  }
  return { files: kept, skipped, tooLarge }
}

// ---------- preview and selection ----------

function isUnsupported(item: PlanItem): boolean {
  return item.status === 'unsupported' || item.status === 'invalid' || !(item.kind in GROUP_TITLES)
}

/** An item the user can pick (it has actions and is not unchanged, unsupported or invalid). */
export function isSelectable(item: PlanItem): boolean {
  return !isUnsupported(item) && item.status !== 'unchanged' && item.actions.length > 0
}

/** The preview groups in the order of docs/UI.md 9.14 (empty groups left out). */
export function groupsOf(plan: ClaudeImportPlan): ClaudeImportGroupView[] {
  const byKind = new Map<ClaudeImportKind | 'unsupported', PlanItem[]>()
  for (const item of plan.items) {
    const kind = isUnsupported(item) ? 'unsupported' : item.kind
    const list = byKind.get(kind) ?? []
    list.push(item)
    byKind.set(kind, list)
  }
  return GROUP_ORDER.flatMap((kind) => {
    const items = byKind.get(kind)
    if (!items || items.length === 0)
      return []
    return [{ kind, title: GROUP_TITLES[kind] ?? kind, items, executable: items.some(item => item.executable) }]
  })
}

/** The default choice of an item (its default action), or null when it is not picked by default. */
export function defaultChoice(item: PlanItem): ClaudeImportChoice | null {
  if (!isSelectable(item) || item.defaultAction === 'skip')
    return null
  if (item.status !== 'new' && item.status !== 'update')
    return null
  return item.defaultAction === 'rename' && item.renameTo ? { action: 'rename', renameTo: item.renameTo } : { action: item.defaultAction }
}

/**
 * New items and update items whose default is not skip are picked; the `CLAUDE.md` mode follows the instructions item
 * (its default action, `skip` when it is not picked; `append` when the plan has no selectable instructions item).
 */
export function defaultSelection(plan: ClaudeImportPlan): ClaudeImportSelection {
  const items: Record<string, ClaudeImportChoice> = {}
  for (const item of plan.items) {
    const choice = defaultChoice(item)
    if (choice)
      items[item.key] = choice
  }
  return syncInstructions(plan, { items, instructions: 'append' })
}

/** The selectable `CLAUDE.md` item of a plan, if any. */
export function instructionsItem(plan: ClaudeImportPlan): PlanItem | null {
  return plan.items.find(item => item.kind === 'instructions' && isSelectable(item)) ?? null
}

/**
 * Keeps the `CLAUDE.md` mode in step with the instructions item (docs/UI.md 9.14: its select Append / Replace / Skip is
 * the item's choice): a picked item gives its action, an unpicked one `skip`. A plan without a selectable instructions
 * item leaves the selection as it is.
 */
export function syncInstructions(plan: ClaudeImportPlan, selection: ClaudeImportSelection): ClaudeImportSelection {
  const item = instructionsItem(plan)
  if (!item)
    return selection
  const action = selection.items[item.key]?.action
  const instructions = action === 'append' || action === 'replace' ? action : 'skip'
  return instructions === selection.instructions ? selection : { ...selection, instructions }
}

/** The state of a group's Select all: every selectable item picked, none, or some. */
export function groupState(group: ClaudeImportGroupView, selection: ClaudeImportSelection): boolean | 'indeterminate' {
  const selectable = group.items.filter(isSelectable)
  if (selectable.length === 0)
    return false
  const picked = selectable.filter(item => Object.hasOwn(selection.items, item.key)).length
  return picked === 0 ? false : picked === selectable.length ? true : 'indeterminate'
}

/**
 * Which password prompt the apply needs (docs/UI.md 9.14): `executables` when a picked item runs commands, `import`
 * otherwise, null when nothing is picked (Import is disabled).
 */
export function needsFreshAuth(plan: ClaudeImportPlan, selection: ClaudeImportSelection): 'executables' | 'import' | null {
  const picked = plan.items.filter(item => Object.hasOwn(selection.items, item.key))
  if (picked.length === 0)
    return null
  return picked.some(item => item.executable) ? 'executables' : 'import'
}

/**
 * The body of `POST /claude-import/apply`: the picked items with their actions, rename targets and `enable` flags, the
 * `CLAUDE.md` mode (an instructions item takes the mode's action; `skip` leaves it out) and the variables.
 */
export function applyBody(planId: string, selection: ClaudeImportSelection): ClaudeImportApplyBody {
  const items: ClaudeImportApplyBody['items'] = []
  const variables: Record<string, Record<string, string>> = {}
  for (const [key, choice] of Object.entries(selection.items)) {
    const instructions = choice.action === 'append' || choice.action === 'replace'
    if (instructions && selection.instructions === 'skip')
      continue
    const action: ClaudeImportAction = instructions ? (selection.instructions as 'append' | 'replace') : choice.action
    items.push({
      key,
      action,
      ...(action === 'rename' && choice.renameTo ? { renameTo: choice.renameTo } : {}),
      ...(choice.enable ? { enable: true } : {}),
    })
    const values = Object.entries(choice.variables ?? {}).filter(([, value]) => value !== '')
    if (values.length > 0)
      variables[key] = Object.fromEntries(values)
  }
  return {
    planId,
    items,
    ...(selection.instructions === 'skip' ? {} : { instructions: selection.instructions }),
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
  }
}

/**
 * The lines of the result step: "Imported {n} items · {s} skipped · {f} failed" (zero counts after the first left out),
 * the failed items with their messages, then the server's warnings.
 */
export function resultLines(result: ClaudeImportApplyResult): string[] {
  const { counts } = result
  const imported = counts.created + counts.updated
  const parts = [`Imported ${imported} ${imported === 1 ? 'item' : 'items'}`]
  if (counts.skipped > 0)
    parts.push(`${counts.skipped} skipped`)
  if (counts.failed > 0)
    parts.push(`${counts.failed} failed`)
  const lines = [parts.join(' · ')]
  for (const item of result.results) {
    if (item.outcome === 'failed')
      lines.push(item.message ? `${item.key}: ${item.message}` : `${item.key}: failed`)
  }
  lines.push(...result.warnings)
  return lines
}

// ---------- item notes (W12.10) ----------

/** The word of each import kind in an item checkbox's name, "{kind} {name}" (docs/UI.md 14.2). */
export const KIND_TEXT: Readonly<Record<ClaudeImportKind, string>> = {
  'agent': 'Agent',
  'command': 'Command',
  'skill': 'Skill',
  'style': 'Output style',
  'hook': 'Hook',
  'mcp-server': 'MCP server',
  'shell-rule': 'Allowed shell command',
  'tool-deny': 'Denied tool',
  'instructions': 'Instructions',
  'setting': 'Setting',
  'permission': 'Permission',
  'env': 'Environment variable',
  'plugin': 'Plugin',
  'marketplace': 'Marketplace',
}

/**
 * The one-line notes of the warnings that are not shown otherwise (runs-commands, needs-variables, linked and
 * project-server have their own places in the item).
 */
export const WARNING_TEXT: Readonly<Partial<Record<ClaudeImportWarning, string>>> = {
  'prefix-broader': 'Becomes a prefix rule: longer commands that start the same way are allowed too.',
  'imports-kept': 'Its @path lines are kept as text.',
  'model-alias': 'Claude model names use the model aliases of the settings.',
}

/** A hook item that asks a model (a prompt hook: imported turned on; command hooks run commands). */
export function isPromptHook(item: PlanItem): boolean {
  return item.kind === 'hook' && !item.executable && item.status !== 'unsupported' && item.status !== 'invalid'
}

/** A per-project server of `.claude.json`: always imported as a turned-off global server. */
export function isProjectServer(item: PlanItem): boolean {
  return item.kind === 'mcp-server' && item.warnings.includes('project-server')
}

/** The item can be imported turned on (its switch Turn on after import): it runs commands and is not a project server. */
export function canEnable(item: PlanItem): boolean {
  return item.executable && isSelectable(item) && !isProjectServer(item)
}

/**
 * The "imported turned off" note of an item (docs/UI.md 9.14), or null: "Imported turned off: it runs shell lines."
 * (command hooks, commands with `!` lines), "… it starts a program." (stdio MCP servers), "From the project {path}:
 * imported turned off." (per-project servers of `.claude.json`).
 */
export function turnedOffNote(item: PlanItem): string | null {
  if (isProjectServer(item))
    return `From the project ${item.source.project ?? 'of .claude.json'}: imported turned off.`
  if (!item.executable)
    return null
  return item.kind === 'mcp-server' ? 'Imported turned off: it starts a program.' : 'Imported turned off: it runs shell lines.'
}

/** The selected items that run commands on this server (the footer's "Includes {n} items …"). */
export function executableCount(plan: ClaudeImportPlan, selection: ClaudeImportSelection): number {
  return plan.items.filter(item => item.executable && Object.hasOwn(selection.items, item.key)).length
}

/** "Includes {n} items that run commands on this server." ("1 item that runs …"). */
export function executablesText(count: number): string {
  return count === 1 ? 'Includes 1 item that runs commands on this server.' : `Includes ${count} items that run commands on this server.`
}

/** "Import {n} items" ("Import 1 item"). */
export function submitText(count: number): string {
  return `Import ${count} ${count === 1 ? 'item' : 'items'}`
}

/** "Found {n} items" ("Found 1 item"). */
export function foundText(count: number): string {
  return `Found ${count} ${count === 1 ? 'item' : 'items'}`
}

// ---------- result (W12.10) ----------

function importedKeys(result: ClaudeImportApplyResult): Set<string> {
  return new Set(result.results.filter(entry => entry.outcome === 'created' || entry.outcome === 'updated').map(entry => entry.key))
}

/**
 * The turned-off lines of the result step (docs/UI.md 9.14): "{t} commands turned off (they run shell lines)" for the
 * imported command hooks and commands with `!` lines the user did not turn on, and "{m} MCP servers turned off" for
 * the imported stdio servers left off and the per-project servers. Zero counts give no line.
 */
export function turnedOffLines(plan: ClaudeImportPlan, selection: ClaudeImportSelection, result: ClaudeImportApplyResult): string[] {
  const imported = importedKeys(result)
  let commands = 0
  let servers = 0
  for (const item of plan.items) {
    if (!imported.has(item.key))
      continue
    const enabled = selection.items[item.key]?.enable === true
    if (item.kind === 'mcp-server') {
      if (isProjectServer(item) || (item.executable && !enabled))
        servers += 1
    }
    else if (item.executable && !enabled) {
      commands += 1
    }
  }
  const lines: string[] = []
  if (commands > 0)
    lines.push(commands === 1 ? '1 command turned off (it runs shell lines)' : `${commands} commands turned off (they run shell lines)`)
  if (servers > 0)
    lines.push(servers === 1 ? '1 MCP server turned off' : `${servers} MCP servers turned off`)
  return lines
}

const TAB_KINDS: readonly CustomizeTab[] = ['agent', 'command', 'skill', 'style', 'hook']

/**
 * The `?tab=` of Open Customize: the tab of the first imported kind in preview order (agents, commands, skills, output
 * styles, hooks), or null when none of these was imported.
 */
export function resultTab(plan: ClaudeImportPlan, result: ClaudeImportApplyResult): string | null {
  const imported = importedKeys(result)
  const kinds = new Set(plan.items.filter(item => imported.has(item.key)).map(item => item.kind))
  const tab = TAB_KINDS.find(kind => kinds.has(kind))
  return tab === undefined ? null : CUSTOMIZE_TAB_VALUES[tab]
}

/** MCP servers were created or updated (the result's MCP servers action). */
export function importedServers(plan: ClaudeImportPlan, result: ClaudeImportApplyResult): boolean {
  const imported = importedKeys(result)
  return plan.items.some(item => item.kind === 'mcp-server' && imported.has(item.key))
}

// ---------- errors (W12.10) ----------

/** The cap of an upload (docs/API.md 5.35), as text. */
export const UPLOAD_LIMIT_TEXT = '32 MiB'

/**
 * The text of a failed step (docs/UI.md 9.14): the fixed copy of 413, a turned-off scan and an expired plan, else the
 * server's message.
 */
export function importErrorText(error: Pick<HarnessError, 'code' | 'message' | 'details'>, step: 'source' | 'preview'): string {
  if (error.code === 'payload_too_large')
    return `The upload is larger than ${UPLOAD_LIMIT_TEXT}.`
  if (error.code === 'conflict' && (error.details as { reason?: unknown } | undefined)?.reason === 'disabled')
    return 'Scanning is turned off on this server (HF_CLAUDE_HOME=0).'
  if (error.code === 'not_found' && step === 'preview')
    return 'This preview expired. Start again.'
  return error.message
}
