// Pure helpers of the Import from Claude Code dialog (Phase 12, ADR-055; docs/UI.md 9.14, 11.9): the browser-side filter
// of a picked `.claude` folder (`pickClaudeFiles`, over the shared allowlist `isClaudeHomeImportPath` and the caps of
// `CLAUDE_HOME_LIMITS`: it guards the upload, so it is complete from P12-0b), the preview groups, the default selection,
// the tri-state of a group's Select all, which password prompt the apply needs, the apply body, the result lines and the
// status words. The plan is built on the server; nothing here parses a file or a zip. No Vue, no stores.
// Signatures frozen from Gate P12-0b (C46); W12.10 owns the bodies other than `pickClaudeFiles` (P12-A).
import type {
  ClaudeImportAction,
  ClaudeImportApplyBody,
  ClaudeImportApplyResult,
  ClaudeImportKind,
  ClaudeImportPlan,
  ClaudeImportStatus,
} from '@harness-forge/shared'
import { classifyClaudeHomePath, CLAUDE_HOME_LIMITS, normalizeClaudeHomePath } from '@harness-forge/shared'

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

/** New items and update items whose default is not skip are picked; `CLAUDE.md` is appended. */
export function defaultSelection(plan: ClaudeImportPlan): ClaudeImportSelection {
  const items: Record<string, ClaudeImportChoice> = {}
  for (const item of plan.items) {
    const choice = defaultChoice(item)
    if (choice)
      items[item.key] = choice
  }
  return { items, instructions: 'append' }
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
