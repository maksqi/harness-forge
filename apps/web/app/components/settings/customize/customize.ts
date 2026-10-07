// Pure helpers of Settings -> Customize (docs/UI.md 9.12, 11.7, 15; ADR-044, ADR-045): the source sections of a kind
// (with the built-in command rows), the state badge, the shadowed tooltip and the meta line of a row, the editor's
// structured draft (from a personal definition, a catalog entry or an imported file) and its content, the field rules
// and their copy, the import notes, free names for Duplicate, and the copy per kind. Definition files are parsed and
// formatted only by the shared `parseDefinition` / `formatDefinition`. No Vue, no stores.
// Signatures frozen from Gate P10-0b (C33); W10.8 owns the copy and the details in P10-A.
// Phase 11 (ADR-048, ADR-051, ADR-052; C39 declares, W11.8 implements; frozen from Gate P11-0b): the tabs are the four
// kinds plus the hooks (`CustomizeTab`, `tabOf`, `?tab=agents|commands|skills|output-styles|hooks`; the styles tab's
// value is its folder name, so `kindFolders` keeps matching); the draft gains the style's `keepCodingInstructions` and
// the skill's `userInvocable` / `modelInvocable` (the skill reuses `argumentHint`); the row menu gains `review` (a
// project command whose `!` lines wait for approval) and `set-default` (Use by default, a style). W11.8 (P11-A): the style
// rows (label, coding-instructions meta, default badges), the skill meta (`/name`, "Only when you run it"), the style's
// label kept on save (`CustomizationDraft.label`, CCR) and the Phase 11 copy.
// Phase 12 (ADR-056, ADR-058; C46 declares, W12.11 implements; frozen from Gate P12-0b): the project file editor's target
// (`ProjectFileTarget`, `newProjectFilePath`), the draft's Claude Code keys (`disallowedTools`, `maxTurns`, `color`,
// `skills`, `whenToUse`, `fork`, `forkAgent`; `formatDefinition` writes a key only when set) and `edit` / `delete` on
// project rows (they open the project file editor and delete the file). W12.11 (P12-A): the draft maps those keys both
// ways (skills also get `allowed-tools` and `model`), keeps `arguments` and a Claude model name it does not show (CCR:
// `CustomizationDraft.arguments` / `modelAlias`), drafts a qualified plugin entry under its bare name (`bareName`), adds
// "Runs in a sub-agent" to the row meta, the field rules (`maxTurnsError`, `skillsError`, `whenToUseError`), the color
// names, and the project file helpers (`isEditableProjectEntry`, `checkProjectFile` with the shared parsers,
// `mcpServersText` / `mcpServersOf`, `newProjectFileContent`, the title, toast and delete copy).
import type {
  AgentColor,
  CommandSummary,
  Customization,
  CustomizationEntry,
  CustomizationKind,
  CustomizationList,
  CustomizationSource,
  DefinitionDiagnostic,
  ParsedDefinition,
  ProjectTrustList,
  TrustItem,
} from '@harness-forge/shared'
import {
  AGENT_NAME_PATTERN,
  CLIENT_COMMANDS,
  COMMAND_NAME_PATTERN,
  CUSTOMIZATION_KINDS,
  DEFINITION_LIMITS,
  formatDefinition,
  isBuiltinOutputStyle,
  isClientCommand,
  isHarnessCommand,
  isReservedAgentName,
  parseDefinition,
  parseMcpJson,
  projectDefinitionPathKind,
  setDefinitionName,
  skillInvocation,
  splitQualifiedName,
  styleNameFromLabel,
} from '@harness-forge/shared'
import { CLIENT_COMMAND_DESCRIPTIONS } from '~/components/chat/composer/slash-commands'

/**
 * The actions of a row's menu (docs/UI.md 9.12); + Phase 11 (9.13): `review` (Review…, a project command whose `!` lines
 * wait for approval) and `set-default` (Use by default, an output style); + Phase 12 (9.14): `edit` and `delete` on
 * project rows (the project file editor, deleting the file).
 */
export type CustomizationAction = 'edit' | 'view' | 'duplicate' | 'export' | 'toggle' | 'delete' | 'open-plugin' | 'review' | 'set-default'

/** The editor's structured fields; `formatDefinition` turns them into the content that is saved. */
export interface CustomizationDraft {
  kind: CustomizationKind
  name: string
  description: string
  /** Agents: tools; commands: allowed-tools; null = no restriction. */
  tools: string[] | null
  /** A model ref, 'inherit' (agents) or null. */
  model: string | null
  /** Commands; + Phase 11: user-invocable skills too. */
  argumentHint: string | null
  /** Instructions / prompt / skill content. */
  body: string
  /** + Phase 11 (styles, ADR-051): `keep-coding-instructions`; absent = off. */
  keepCodingInstructions?: boolean
  /** + Phase 11 (skills, ADR-052): `user-invocable` ("Show in the slash menu"); absent = on. */
  userInvocable?: boolean
  /** + Phase 11 (skills, ADR-052): not `disable-model-invocation` (off = "Only when you run it"); absent = on. */
  modelInvocable?: boolean
  /**
   * + Phase 11 (styles, W11.8 CCR): the style's name as written (`name: My Style`); kept on save while the slug in `name`
   * still matches it. Absent = the slug.
   */
  label?: string
  /** + Phase 12 (agents `disallowedTools`, commands and skills `disallowed-tools`, ADR-058): tools never offered. */
  disallowedTools?: string[] | null
  /** + Phase 12 (agents): `maxTurns`, 1 … 200; null = no limit of its own. */
  maxTurns?: number | null
  /** + Phase 12 (agents): `color` in the chat; null = none. */
  color?: AgentColor | null
  /** + Phase 12 (agents): `skills` preloaded into the sub-agent (at most 5 names). */
  skills?: string[] | null
  /** + Phase 12 (commands and skills): `when_to_use`. */
  whenToUse?: string | null
  /** + Phase 12 (commands and skills): `context: fork` ("Run in a sub-agent"). */
  fork?: boolean
  /** + Phase 12 (with `fork`): the sub-agent type (`agent`); null = `general`. */
  forkAgent?: string | null
  /**
   * + Phase 12 (W12.11 CCR, commands and skills): the `arguments` names (`$name`). Not edited by the form; kept so a save
   * never drops them.
   */
  arguments?: string[] | null
  /**
   * + Phase 12 (W12.11 CCR): a Claude model name (`model: sonnet`), written as `model` while `model` is null; kept so a save
   * never drops it.
   */
  modelAlias?: string | null
}

/**
 * What the project file editor opens (Phase 12, ADR-056; docs/UI.md 9.14): a project-relative path, its kind (`mcp` =
 * `.mcp.json`), the definition's name (null for `.mcp.json`) and whether the file is created.
 */
export interface ProjectFileTarget {
  path: string
  kind: 'agent' | 'command' | 'skill' | 'style' | 'mcp'
  name: string | null
  create: boolean
}

/** The folder of each definition kind under `.harness/` or `.claude/`. */
const PROJECT_KIND_FOLDERS: Readonly<Record<Exclude<ProjectFileTarget['kind'], 'mcp'>, string>> = {
  agent: 'agents',
  command: 'commands',
  skill: 'skills',
  style: 'output-styles',
}

/**
 * The project-relative path of a new definition file (docs/UI.md 9.14): `<folder>/<kind folder>/<name>.md`, a skill
 * `<folder>/skills/<name>/SKILL.md`, `.mcp.json` for `mcp`.
 */
export function newProjectFilePath(kind: ProjectFileTarget['kind'], folder: '.harness' | '.claude', name: string): string {
  if (kind === 'mcp')
    return '.mcp.json'
  const stem = name.trim()
  return kind === 'skill' ? `${folder}/skills/${stem}/SKILL.md` : `${folder}/${PROJECT_KIND_FOLDERS[kind]}/${stem}.md`
}

/** The `?tab=` value of each kind (Phase 11: output styles, ADR-051). */
export const CUSTOMIZE_TABS: Readonly<Record<CustomizationKind, 'agents' | 'commands' | 'skills' | 'output-styles'>> = {
  agent: 'agents',
  command: 'commands',
  skill: 'skills',
  style: 'output-styles',
}

/** + Phase 11: a tab of the Customize page: a definition kind, or the hooks (docs/UI.md 9.13). */
export type CustomizeTab = CustomizationKind | 'hook'

/** + Phase 11: the tabs in display order (Agents · Commands · Skills · Output styles · Hooks). */
export const CUSTOMIZE_TAB_ORDER: readonly CustomizeTab[] = [...CUSTOMIZATION_KINDS, 'hook']

/** + Phase 11: the `?tab=` value of each tab. */
export const CUSTOMIZE_TAB_VALUES: Readonly<Record<CustomizeTab, string>> = { ...CUSTOMIZE_TABS, hook: 'hooks' }

/** + Phase 11: the tab of a `?tab=` value: `agent` when it is missing or unknown. */
export function tabOf(tab: unknown): CustomizeTab {
  const value = Array.isArray(tab) ? tab[0] : tab
  return CUSTOMIZE_TAB_ORDER.find(item => CUSTOMIZE_TAB_VALUES[item] === value) ?? 'agent'
}

/**
 * W12.19 (docs/UI.md 14.5): the classes of a sheet of this page that make the frozen SheetContent's × Close (a `size-8`
 * button at `top-4 right-4`) a 40 px target on a coarse pointer, around the same center.
 */
export const SHEET_CLOSE_TOUCH_CLASS = 'pointer-coarse:**:data-[slot=sheet-close]:top-3 pointer-coarse:**:data-[slot=sheet-close]:right-3 pointer-coarse:**:data-[slot=sheet-close]:size-10'

/** W11.19: the space kept beside the active tab when the tab row scrolls it into view (px). */
export const TAB_REVEAL_INSET = 16

/**
 * W11.19: how far the tab row must scroll sideways (`scrollLeft += offset`) so the active tab lies inside its visible part
 * with `inset` beside it: negative to the start, positive to the end, 0 when it is visible already. A tab wider than the
 * row keeps its start in view. Boxes are viewport rectangles (`getBoundingClientRect`).
 */
export function tabRevealOffset(row: { left: number, right: number }, tab: { left: number, right: number }, inset = TAB_REVEAL_INSET): number {
  const before = tab.left - (row.left + inset)
  if (before < 0)
    return before
  const after = tab.right - (row.right - inset)
  return after > 0 ? Math.min(after, before) : 0
}

/** The kind of a `?tab=` value: `agents` when it is missing or unknown (the hooks tab included). */
export function kindOfTab(tab: unknown): CustomizationKind {
  const value = Array.isArray(tab) ? tab[0] : tab
  const found = (Object.keys(CUSTOMIZE_TABS) as CustomizationKind[]).find(kind => CUSTOMIZE_TABS[kind] === value)
  return found ?? 'agent'
}

/** The source sections in display order (lowest precedence last). */
export const SECTION_ORDER: readonly CustomizationSource[] = ['user', 'project', 'plugin', 'builtin']

/**
 * The source sections of one kind, in display order: Personal (always), In {project} (only with a project scope), From
 * plugins (hidden when empty), Built-in (agents and commands only).
 */
export function sectionsOf(list: CustomizationList | null, kind: CustomizationKind): { source: CustomizationSource, entries: CustomizationEntry[] }[] {
  const entries = (list?.items ?? []).filter(entry => entry.kind === kind)
  return SECTION_ORDER
    .map(source => ({ source, entries: entries.filter(entry => entry.source === source) }))
    .filter(({ source, entries: rows }) => {
      if (source === 'project')
        return list?.project != null
      if (source === 'plugin')
        return rows.length > 0
      if (source === 'builtin')
        return kind !== 'skill'
      return true
    })
}

function countOf(entry: CustomizationEntry, level: 'warning' | 'info'): number {
  return entry.diagnostics.filter(diagnostic => diagnostic.level === level).length
}

/**
 * The state badge of a row: Shadowed (muted), Invalid (destructive), Off (muted), "{n} warnings" (warning; info
 * diagnostics count only when there is nothing else), else null.
 */
export function stateBadge(entry: CustomizationEntry): { label: string, tone: 'muted' | 'warning' | 'destructive' } | null {
  switch (entry.state) {
    case 'shadowed':
      return { label: 'Shadowed', tone: 'muted' }
    case 'invalid':
      return { label: 'Invalid', tone: 'destructive' }
    case 'off':
      return { label: 'Off', tone: 'muted' }
  }
  const warnings = countOf(entry, 'warning') || countOf(entry, 'info')
  if (warnings === 0)
    return null
  return { label: `${warnings} warning${warnings === 1 ? '' : 's'}`, tone: 'warning' }
}

/** The kind as a word ("agent", "command", "skill", "output style"). */
export const KIND_LABEL: Readonly<Record<CustomizationKind, string>> = { agent: 'agent', command: 'command', skill: 'skill', style: 'output style' }

/** The description of the built-in command rows (docs/UI.md 9.12). */
export const RESERVED_COMMAND_NOTE = 'Reserved: a personal or project command can\'t use this name.'

/**
 * The rows of the Built-in commands section: the harness commands of `GET /commands` (`/compact`) and the client
 * commands of the composer, sorted by name; rows without a menu (docs/UI.md 9.12).
 */
export function builtinCommandEntries(commands: readonly CommandSummary[]): CustomizationEntry[] {
  const rows = new Map<string, string>()
  for (const command of commands) {
    if (command.source === 'harness')
      rows.set(command.name, command.description)
  }
  for (const name of CLIENT_COMMANDS)
    rows.set(name, CLIENT_COMMAND_DESCRIPTIONS[name])
  return [...rows]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, description]) => ({ kind: 'command', name, description, source: 'builtin', enabled: true, state: 'active', diagnostics: [] }))
}

/** True for the rows that have no menu (the built-in commands). */
export function hasRowMenu(entry: CustomizationEntry): boolean {
  return !(entry.source === 'builtin' && entry.kind === 'command')
}

/** The definition folders of one kind among the scanned folders of a project (`.harness/agents`, ...). */
export function kindFolders(folders: readonly string[] | undefined, kind: CustomizationKind): string[] {
  const suffix = `/${CUSTOMIZE_TABS[kind]}`
  return (folders ?? []).filter(folder => folder.endsWith(suffix))
}

/** `text` shortened in the middle to at most `max` characters ("…" in between); paths keep their file name. */
export function middleTruncate(text: string, max = 48): string {
  const chars = [...text]
  if (chars.length <= max)
    return text
  const keep = max - 1
  const tail = Math.ceil(keep / 2)
  return `${chars.slice(0, keep - tail).join('')}…${chars.slice(chars.length - tail).join('')}`
}

/** The tooltip of a Shadowed badge: "Not used: {winner} wins." */
export function shadowedTooltip(entry: CustomizationEntry, pluginName: (id: string) => string): string {
  const by = entry.shadowedBy
  const kind = KIND_LABEL[entry.kind]
  let winner: string
  switch (by?.source) {
    case 'project':
      winner = by.path ? `the project's ${by.path}` : `the project's ${kind}`
      break
    case 'user':
      winner = `your personal ${kind}`
      break
    case 'plugin':
      winner = by.pluginId ? `the ${kind} from ${pluginName(by.pluginId)}` : `the ${kind} from a plugin`
      break
    case 'builtin':
      winner = `the built-in ${kind}`
      break
    default:
      winner = `another ${kind} with this name`
  }
  return `Not used: ${winner} wins.`
}

/** The diagnostics a row lists (errors first, then warnings, then infos). */
export function rowDiagnostics(entry: CustomizationEntry): DefinitionDiagnostic[] {
  const rank = { error: 0, warning: 1, info: 2 } as const
  return [...entry.diagnostics].sort((a, b) => rank[a.level] - rank[b.level])
}

/** The source badge of a row: "Personal", "Project", the plugin name, "Built-in". */
export function sourceLabel(entry: CustomizationEntry, pluginName: (id: string) => string): string {
  switch (entry.source) {
    case 'user':
      return 'Personal'
    case 'project':
      return 'Project'
    case 'plugin':
      return entry.pluginId ? pluginName(entry.pluginId) : 'Plugin'
    case 'builtin':
      return 'Built-in'
  }
}

/** One item of a row's meta line. */
export interface RowMetaItem {
  text: string
  /** Paths, namespaces and argument hints are mono. */
  mono?: boolean
  /** The full text when `text` is shortened (paths). */
  title?: string
}

/**
 * The muted second line of a row, item by item: the source badge, the project path (shortened in the middle), the
 * namespace, the model (its name through `modelName`; "Same as the chat" for `inherit`), the tools ("{n} tools" / "All
 * tools" for agents, "Tools limited to {n}" for commands), the argument hint, and the reserved note of built-in
 * commands.
 */
export function rowMetaItems(
  entry: CustomizationEntry,
  pluginName: (id: string) => string,
  modelName: (ref: string) => string = ref => ref,
): RowMetaItem[] {
  const items: RowMetaItem[] = [{ text: sourceLabel(entry, pluginName) }]
  // + Phase 11: a style shown by its label keeps its slug in the meta line.
  if (entry.kind === 'style' && displayName(entry) !== entry.name)
    items.push({ text: entry.name, mono: true })
  if (entry.path) {
    const short = middleTruncate(entry.path)
    items.push(short === entry.path ? { text: entry.path, mono: true } : { text: short, mono: true, title: entry.path })
  }
  if (entry.namespace)
    items.push({ text: entry.namespace, mono: true })
  if (entry.modelRef)
    items.push({ text: entry.modelRef === 'inherit' ? 'Same as the chat' : modelName(entry.modelRef) })
  if (entry.kind === 'agent')
    items.push({ text: entry.tools ? `${entry.tools.length} tool${entry.tools.length === 1 ? '' : 's'}` : 'All tools' })
  else if (entry.kind === 'command' && entry.tools)
    items.push({ text: `Tools limited to ${entry.tools.length}` })
  // + Phase 11 (ADR-052): a skill in the slash menu shows how to run it; one the agent does not load by itself says so.
  if (entry.kind === 'skill' && entry.userInvocable !== false)
    items.push({ text: `/${entry.name}`, mono: true })
  if (entry.argumentHint)
    items.push({ text: entry.argumentHint, mono: true })
  if (entry.kind === 'skill' && entry.modelInvocable === false)
    items.push({ text: 'Only when you run it' })
  // + Phase 12 (ADR-058): a skill or command with `context: fork`.
  if ((entry.kind === 'skill' || entry.kind === 'command') && entry.context === 'fork')
    items.push({ text: 'Runs in a sub-agent' })
  // + Phase 11 (ADR-051): what a style does with the coding instructions.
  if (entry.kind === 'style')
    items.push({ text: entry.keepCodingInstructions ? 'Keeps coding instructions' : 'Replaces coding instructions' })
  if (entry.source === 'builtin' && entry.kind === 'command')
    items.push({ text: RESERVED_COMMAND_NOTE })
  return items
}

/** + Phase 11: the name a row shows: commands as `/name`, styles by their label, the rest by their name. */
export function displayName(entry: Pick<CustomizationEntry, 'kind' | 'name' | 'label'>): string {
  if (entry.kind === 'command')
    return `/${entry.name}`
  if (entry.kind === 'style')
    return entry.label?.trim() || entry.name
  return entry.name
}

/** + Phase 11: the output style defaults a row is (docs/UI.md 9.13): the global one and the selected project's. */
export interface StyleDefaults {
  /** The setting `outputStyle`. */
  global: string
  /** The selected project's style (null = Same as your default, or no project). */
  project: string | null
  /** The selected project's name, or null without a project. */
  projectName: string | null
}

/** + Phase 11: the default badges of a style row: "Your default" and "Default in {project}". */
export function styleDefaultBadges(entry: Pick<CustomizationEntry, 'kind' | 'name' | 'state'>, defaults: StyleDefaults | null): string[] {
  if (entry.kind !== 'style' || !defaults || entry.state === 'shadowed' || entry.state === 'invalid')
    return []
  const badges: string[] = []
  if (entry.name === defaults.global)
    badges.push('Your default')
  if (defaults.projectName !== null && defaults.project !== null && entry.name === defaults.project)
    badges.push(`Default in ${defaults.projectName}`)
  return badges
}

/** + Phase 11: true when "Use by default" would change nothing (the style is already the default of the scope). */
export function isScopeDefault(entry: Pick<CustomizationEntry, 'name'>, defaults: StyleDefaults | null): boolean {
  if (!defaults)
    return false
  return defaults.projectName !== null ? defaults.project === entry.name : defaults.global === entry.name
}

/**
 * + Phase 11 (ADR-049, ADR-052): the pending trust item of a project command with `` !`cmd` `` lines (the same file in the
 * project's trust list), else null: the row shows "Needs approval" and Review….
 */
export function pendingCommandTrust(entry: Pick<CustomizationEntry, 'kind' | 'source' | 'path'>, trust: ProjectTrustList | null): TrustItem | null {
  if (entry.kind !== 'command' || entry.source !== 'project' || !entry.path || !trust)
    return null
  return trust.items.find(item => item.kind === 'command' && item.state === 'pending' && item.path === entry.path) ?? null
}

/** The texts of `rowMetaItems` (paths in full, models as their refs). */
export function rowMeta(entry: CustomizationEntry, pluginName: (id: string) => string): string[] {
  return rowMetaItems(entry, pluginName).map(item => item.title ?? item.text)
}

/** An empty draft of a kind. */
export function emptyDraft(kind: CustomizationKind): CustomizationDraft {
  return { kind, name: '', description: '', tools: null, model: null, argumentHint: null, body: '' }
}

/**
 * + Phase 12 (ADR-058): the Claude Code keys of a parsed definition as draft fields, each present only when the file sets
 * it (like the parser's fields): agents `disallowedTools`, `maxTurns`, `color`, `skills`; commands and skills
 * `disallowedTools`, `whenToUse`, `arguments`, `fork` / `forkAgent`; every kind with a model its `modelAlias`.
 */
function claudeDraftFields(fields: {
  readonly disallowedTools?: readonly string[]
  readonly maxTurns?: number
  readonly color?: AgentColor
  readonly skills?: readonly string[]
  readonly whenToUse?: string
  readonly arguments?: readonly string[]
  readonly context?: 'fork'
  readonly agent?: string
  readonly modelAlias?: string
}): Partial<CustomizationDraft> {
  return {
    ...(fields.disallowedTools && fields.disallowedTools.length > 0 ? { disallowedTools: [...fields.disallowedTools] } : {}),
    ...(typeof fields.maxTurns === 'number' ? { maxTurns: fields.maxTurns } : {}),
    ...(fields.color ? { color: fields.color } : {}),
    ...(fields.skills && fields.skills.length > 0 ? { skills: [...fields.skills] } : {}),
    ...(fields.whenToUse ? { whenToUse: fields.whenToUse } : {}),
    ...(fields.arguments && fields.arguments.length > 0 ? { arguments: [...fields.arguments] } : {}),
    ...(fields.context === 'fork' ? { fork: true, ...(fields.agent ? { forkAgent: fields.agent } : {}) } : {}),
    ...(fields.modelAlias ? { modelAlias: fields.modelAlias } : {}),
  }
}

/** The structured draft of a parsed definition. */
export function draftFromDefinition(definition: ParsedDefinition): CustomizationDraft {
  switch (definition.kind) {
    case 'agent': {
      const fields = definition.fields
      return {
        kind: 'agent',
        name: fields.name,
        description: fields.description,
        tools: fields.tools ? [...fields.tools] : null,
        model: fields.model,
        argumentHint: null,
        body: fields.instructions,
        // + Phase 12: the Claude Code keys, only when set.
        ...claudeDraftFields(fields),
      }
    }
    case 'command': {
      const fields = definition.fields
      return {
        kind: 'command',
        name: fields.name,
        description: fields.description,
        tools: fields.allowedTools ? [...fields.allowedTools] : null,
        model: fields.model,
        argumentHint: fields.argumentHint,
        body: fields.body,
        ...claudeDraftFields(fields),
      }
    }
    case 'skill': {
      const fields = definition.fields
      return {
        kind: 'skill',
        name: fields.name,
        description: fields.description,
        // + Phase 12 (ADR-058): a skill's `allowed-tools` and `model` (like a command's).
        tools: fields.allowedTools ? [...fields.allowedTools] : null,
        model: fields.model ?? null,
        argumentHint: fields.argumentHint ?? null,
        body: fields.content,
        // + Phase 11: present only when not the default (like the parsed fields).
        ...(fields.userInvocable === undefined ? {} : { userInvocable: fields.userInvocable }),
        ...(fields.modelInvocable === undefined ? {} : { modelInvocable: fields.modelInvocable }),
        ...claudeDraftFields(fields),
      }
    }
    case 'style': {
      const fields = definition.fields
      return {
        kind: 'style',
        name: fields.name,
        description: fields.description,
        tools: null,
        model: null,
        argumentHint: null,
        body: fields.content,
        keepCodingInstructions: fields.keepCodingInstructions,
        // The name as written; formatDefinition writes it back while the slug matches.
        ...(fields.label && fields.label !== fields.name ? { label: fields.label } : {}),
      }
    }
  }
}

/** The draft of a personal definition, from its parsed fields (the stored content when they are missing). */
export function draftFromUser(customization: Customization): CustomizationDraft {
  if (customization.fields)
    return draftFromDefinition({ kind: customization.kind, fields: customization.fields } as ParsedDefinition)
  return draftFromEntry({ kind: customization.kind, name: customization.name, description: customization.description } as CustomizationEntry, customization.content)
}

/**
 * + Phase 12: the name of an entry without its plugin namespace (`review-kit:db:migrate` → `migrate`): the name a copy
 * to personal or an export starts from. Bare names are returned as they are.
 */
export function bareName(entry: Pick<CustomizationEntry, 'name'>): string {
  return splitQualifiedName(entry.name)?.name ?? entry.name
}

/**
 * The draft of a catalog entry from its file (`parseDefinition` inside); unparsable content keeps the entry's fields.
 * + Phase 12: a qualified plugin entry (`review-kit:review`) is drafted under its bare name (a personal definition
 * has no namespace).
 */
export function draftFromEntry(entry: CustomizationEntry, content: string): CustomizationDraft {
  const bare = bareName(entry)
  const text = bare === entry.name ? content : setDefinitionName(content, bare)
  const parsed = parseDefinition(entry.kind, text, { fileName: `${bare}.md`, folderName: bare })
  if (parsed.definition)
    return draftFromDefinition(parsed.definition)
  return { ...emptyDraft(entry.kind), name: bare, description: entry.description, body: content }
}

/** Files above this size are refused before they are read (docs/UI.md 9.12). */
export const IMPORT_MAX_BYTES = 256 * 1024

/** The toast of a refused import (over 256 KB), else null. */
export function importTooLarge(file: Pick<File, 'name' | 'size'>): { title: string, description: string } | null {
  if (file.size <= IMPORT_MAX_BYTES)
    return null
  return { title: `${file.name} is too large`, description: 'Definition files can be up to 64 KB.' }
}

const IGNORED_KEY_MESSAGE = /The key "(.+)" is ignored/

/**
 * One line per parser diagnostic, as the parser words it; the ignored keys are gathered into one line, "Ignored:
 * color, permissionMode" (docs/UI.md 9.12).
 */
export function importNotes(diagnostics: readonly DefinitionDiagnostic[]): string[] {
  const ignored: string[] = []
  const lines: string[] = []
  for (const diagnostic of diagnostics) {
    const key = diagnostic.code === 'ignored-key' ? diagnostic.message.match(IGNORED_KEY_MESSAGE)?.[1] : undefined
    if (key !== undefined)
      ignored.push(key)
    else
      lines.push(diagnostic.message)
  }
  return ignored.length > 0 ? [`Ignored: ${ignored.join(', ')}`, ...lines] : lines
}

/** A name problem of the parser: the rest of the file can still prefill the editor. */
function isNameProblem(diagnostic: DefinitionDiagnostic): boolean {
  return diagnostic.code === 'invalid-name' || (diagnostic.code === 'missing-field' && diagnostic.message.endsWith('Add a name.'))
}

/**
 * Reads an imported `.md` file (UTF-8, BOM and CRLF accepted) as a draft of `kind` with the shared parser: the file
 * stem is the name fallback (not for `SKILL.md`, which needs a `name` key or a name typed in the editor). A file whose
 * only errors concern its name still prefills the other fields (the name stays empty); a file that cannot be parsed at
 * all keeps its text as the body. The notes start with "Imported from {file}. Check the fields, then save." followed by
 * one line per diagnostic (`importNotes`). Throws a RangeError above `IMPORT_MAX_BYTES` (check `importTooLarge` first).
 */
export async function importDraft(file: File, kind: CustomizationKind): Promise<{ draft: CustomizationDraft, notes: string[] }> {
  if (file.size > IMPORT_MAX_BYTES)
    throw new RangeError(`${file.name} is too large`)
  const text = (await file.text()).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const stem = file.name.replace(/\.md$/i, '')
  const folderName = stem.toLowerCase() === 'skill' ? undefined : stem
  const parsed = parseDefinition(kind, text, { fileName: file.name, folderName })
  const notes = [`Imported from ${file.name}. Check the fields, then save.`, ...importNotes(parsed.diagnostics)]
  if (parsed.definition)
    return { draft: draftFromDefinition(parsed.definition), notes }
  const errors = parsed.diagnostics.filter(diagnostic => diagnostic.level === 'error')
  if (errors.length > 0 && errors.every(isNameProblem)) {
    // The name is the only problem: read the rest with a stand-in name and leave the name to the user.
    const retry = parseDefinition(kind, text, { fileName: 'imported.md', folderName: 'imported' })
    if (retry.definition) {
      const draft = draftFromDefinition(retry.definition)
      return { draft: { ...draft, name: draft.name === 'imported' ? '' : draft.name }, notes }
    }
  }
  return { draft: { ...emptyDraft(kind), body: text }, notes }
}

/** A non-empty copy of a list, else undefined (the key is left out). */
function listOrUndefined(value: readonly string[] | null | undefined): string[] | undefined {
  return value && value.length > 0 ? [...value] : undefined
}

/**
 * + Phase 12 (ADR-058): the Claude Code keys of a draft as definition fields, each only when set (`formatDefinition`
 * writes a key only when it is set): commands and skills `whenToUse`, `arguments`, `disallowedTools`, `context: fork` +
 * `agent`; the model alias while no model is chosen.
 */
function claudeCommandFields(draft: CustomizationDraft, model: string | null): {
  whenToUse?: string
  arguments?: string[]
  disallowedTools?: string[]
  context?: 'fork'
  agent?: string
  modelAlias?: string
} {
  const whenToUse = draft.whenToUse?.trim() ?? ''
  const args = listOrUndefined(draft.arguments)
  const disallowed = listOrUndefined(draft.disallowedTools)
  const agent = draft.forkAgent?.trim() ?? ''
  const alias = model === null ? draft.modelAlias?.trim() ?? '' : ''
  return {
    ...(whenToUse === '' ? {} : { whenToUse }),
    ...(args ? { arguments: args } : {}),
    ...(disallowed ? { disallowedTools: disallowed } : {}),
    ...(draft.fork ? { context: 'fork' as const, ...(agent === '' ? {} : { agent }) } : {}),
    ...(alias === '' ? {} : { modelAlias: alias }),
  }
}

/** The definition the editor saves (`formatDefinition` turns it into the content). Names and texts are trimmed. */
export function draftDefinition(draft: CustomizationDraft): ParsedDefinition {
  const name = draft.name.trim()
  const description = draft.description.trim()
  switch (draft.kind) {
    case 'agent': {
      // + Phase 12: the agent's Claude Code keys, only when set.
      const disallowed = listOrUndefined(draft.disallowedTools)
      const skills = listOrUndefined(draft.skills)
      const alias = draft.model === null ? draft.modelAlias?.trim() ?? '' : ''
      return {
        kind: 'agent',
        fields: {
          name,
          description,
          tools: draft.tools,
          model: draft.model,
          instructions: draft.body,
          ...(disallowed ? { disallowedTools: disallowed } : {}),
          ...(typeof draft.maxTurns === 'number' ? { maxTurns: draft.maxTurns } : {}),
          ...(skills ? { skills } : {}),
          ...(draft.color ? { color: draft.color } : {}),
          ...(alias === '' ? {} : { modelAlias: alias }),
        },
      }
    }
    case 'command': {
      const model = draft.model === 'inherit' ? null : draft.model
      return {
        kind: 'command',
        fields: {
          name,
          description,
          argumentHint: draft.argumentHint?.trim() || null,
          model,
          allowedTools: draft.tools,
          body: draft.body,
          ...claudeCommandFields(draft, model),
        },
      }
    }
    case 'skill': {
      // + Phase 11: the skill keys only when they are not the default (like the parser's fields).
      const hint = draft.argumentHint?.trim() ?? ''
      // + Phase 12 (ADR-058): a skill's `allowed-tools` and `model`, like a command's.
      const model = draft.model && draft.model !== 'inherit' ? draft.model : null
      return {
        kind: 'skill',
        fields: {
          name,
          description,
          content: draft.body,
          ...(draft.userInvocable === false ? { userInvocable: false } : {}),
          ...(draft.modelInvocable === false ? { modelInvocable: false } : {}),
          ...(hint === '' ? {} : { argumentHint: hint }),
          ...(draft.tools ? { allowedTools: [...draft.tools] } : {}),
          ...(model ? { model } : {}),
          ...claudeCommandFields(draft, model),
        },
      }
    }
    case 'style': {
      // The label as written survives while the name is still its slug (a renamed style takes the new name).
      const label = draft.label?.trim() && styleNameFromLabel(draft.label) === name ? draft.label.trim() : name
      return { kind: 'style', fields: { name, label, description, keepCodingInstructions: draft.keepCodingInstructions ?? false, content: draft.body } }
    }
  }
}

/** The markdown the editor saves for a draft. */
export function draftContent(draft: CustomizationDraft): string {
  return formatDefinition(draftDefinition(draft))
}

/** True when two drafts would save the same content. */
export function sameDraft(a: CustomizationDraft, b: CustomizationDraft): boolean {
  return draftContent(a) === draftContent(b)
}

// ---------- field rules (docs/UI.md 9.12 "Validation copy") ----------

/** The size limit of a definition file (`DEFINITION_LIMITS.contentBytes`, 64 KB). */
export const CONTENT_MAX_BYTES = DEFINITION_LIMITS.contentBytes

/** "1.2 KB / 64 KB": the size of the whole file as saved. */
export function sizeLabel(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB / ${CONTENT_MAX_BYTES / 1024} KB`
}

const encoder = new TextEncoder()

/** The UTF-8 size of a text. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

/** The UTF-8 size of a draft's content. */
export function draftBytes(draft: CustomizationDraft): number {
  return utf8Bytes(draftContent(draft))
}

/** The longest name of a kind (commands 32, agents and skills 64). */
export function nameMaxChars(kind: CustomizationKind): number {
  return kind === 'command' ? 32 : 64
}

function atMost(max: number): string {
  return `Use at most ${max.toLocaleString('en-US')} characters.`
}

/** The name's problem in the editor's words, else null. */
export function nameError(kind: CustomizationKind, value: string): string | null {
  const name = value.trim()
  if (name === '')
    return 'Add a name.'
  if (name.length > nameMaxChars(kind))
    return atMost(nameMaxChars(kind))
  if (!(kind === 'command' ? COMMAND_NAME_PATTERN : AGENT_NAME_PATTERN).test(name))
    return 'Use lowercase letters, digits and hyphens, starting with a letter.'
  const reserved = kind === 'agent'
    ? isReservedAgentName(name)
    : kind === 'command'
      ? isClientCommand(name) || isHarnessCommand(name)
      : kind === 'style' && isBuiltinOutputStyle(name)
  return reserved ? `${name} is a built-in name.` : null
}

/** The description's problem, else null (commands may leave it empty: the first line of the prompt is used). */
export function descriptionError(kind: CustomizationKind, value: string): string | null {
  const description = value.trim()
  if (description === '')
    return kind === 'command' ? null : 'Add a description.'
  return description.length > DEFINITION_LIMITS.descriptionMaxChars ? atMost(DEFINITION_LIMITS.descriptionMaxChars) : null
}

/** The argument hint's problem, else null. */
export function argumentHintError(value: string | null): string | null {
  return (value?.trim().length ?? 0) > DEFINITION_LIMITS.argumentHintMaxChars ? atMost(DEFINITION_LIMITS.argumentHintMaxChars) : null
}

/** The body's problem (the size of the whole file, a command without a prompt), else null. */
export function bodyError(draft: CustomizationDraft): string | null {
  if (draftBytes(draft) > CONTENT_MAX_BYTES)
    return 'The file can be up to 64 KB.'
  if (draft.kind === 'command' && draft.body.trim() === '')
    return 'Add the prompt.'
  return null
}

/** The 409 `exists` message of the name field. */
export function existsError(kind: CustomizationKind, name: string): string {
  return `You already have a${kind === 'agent' || kind === 'style' ? 'n' : ''} ${KIND_LABEL[kind]} named ${name.trim()}.`
}

/** The editor field a parser diagnostic belongs to (warnings of the live parse), else null (form level). */
export type DraftField = 'name' | 'description' | 'tools' | 'model' | 'argumentHint' | 'body'

export function diagnosticField(diagnostic: DefinitionDiagnostic): DraftField | null {
  switch (diagnostic.code) {
    case 'invalid-name':
    case 'reserved-name':
      return 'name'
    case 'unknown-tool':
    case 'tool-pattern':
    case 'limit':
      return 'tools'
    case 'invalid-model':
    case 'model-alias':
      return 'model'
    case 'too-large':
      return 'body'
    case 'missing-field':
    case 'invalid-field': {
      const message = diagnostic.message
      if (/name/i.test(message) && !/description|argument/i.test(message))
        return 'name'
      if (/description/i.test(message))
        return 'description'
      if (/argument hint/i.test(message))
        return 'argumentHint'
      if (/tool/i.test(message))
        return 'tools'
      if (/prompt|instructions/i.test(message))
        return 'body'
      return null
    }
    default:
      return null
  }
}

/**
 * A free name for a copy: `{name}-copy`, then `{name}-copy-2`, … (cut to the kind's length), never one of `taken`.
 */
export function freeName(kind: CustomizationKind, name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const max = nameMaxChars(kind)
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? '-copy' : `-copy-${n}`
    const candidate = `${name.slice(0, Math.max(1, max - suffix.length))}${suffix}`
    if (!used.has(candidate))
      return candidate
  }
  return name
}

// ---------- delete ----------

/** The texts of the delete confirmation and its toast (docs/UI.md 9.12). */
export function deleteCopy(kind: CustomizationKind, name: string): { title: string, description: string, confirm: string, toast: string } {
  const description = kind === 'agent'
    ? 'Chats that used it keep their messages. The agent can\'t start it anymore.'
    : kind === 'command'
      ? `Chats that used it keep their messages. You can't run /${name} anymore.`
      : kind === 'style'
        ? 'Chats that use it fall back to Default.'
        : 'Chats that used it keep their messages. The agent can\'t load it anymore.'
  return { title: `Delete ${name}?`, description, confirm: `Delete ${KIND_LABEL[kind]}`, toast: `Deleted ${name}` }
}

/** + Phase 12 (docs/UI.md 9.14): the body help of commands and skills about Claude Code's argument placeholders. */
// eslint-disable-next-line no-template-curly-in-string -- the placeholder is shown literally.
export const ARGUMENTS_HELP = '$ARGUMENTS[0] or $0 is the first argument when the file uses them or declares arguments; $name reads a named argument; ${CLAUDE_SKILL_DIR} is the skill\'s folder.'

/** The editor copy per kind (docs/UI.md 9.12): `title` is the kind word of "New {kind}" / "Import {kind}". */
export const EDITOR_COPY: Readonly<Record<CustomizationKind, { title: string, body: string, bodyHelp: string, save: string }>> = {
  agent: {
    title: 'agent',
    body: 'Instructions',
    bodyHelp: 'What the sub-agent should do and how. It gets these instead of the main agent\'s conversation.',
    save: 'Save agent',
  },
  command: {
    title: 'command',
    body: 'Prompt',
    bodyHelp: `$ARGUMENTS is the text after the command; $1 to $9 are single words (quotes group words); {{input}} works too. Without a placeholder the text is added at the end. ${ARGUMENTS_HELP}`,
    save: 'Save command',
  },
  skill: {
    title: 'skill',
    body: 'Instructions',
    bodyHelp: `A personal skill is one file. Put scripts and reference files in a project skill folder. ${ARGUMENTS_HELP}`,
    save: 'Save skill',
  },
  style: {
    title: 'output style',
    body: 'Instructions',
    bodyHelp: 'How the agent writes its replies. They go first in the main agent\'s instructions, never in sub-agents\'.',
    save: 'Save output style',
  },
}

/** The rest of the editor copy per kind (docs/UI.md 9.12). */
export const EDITOR_FIELD_COPY: Readonly<Record<CustomizationKind, {
  descriptionHelp: string
  toolsLabel: string
  toolsAll: string
  modelNone: string
  saved: string
}>> = {
  agent: {
    descriptionHelp: 'When the main agent should use it. It reads this to decide.',
    toolsLabel: 'Tools',
    toolsAll: 'All tools the chat allows',
    modelNone: 'Default sub-agent model',
    saved: 'Agent saved',
  },
  command: {
    descriptionHelp: 'Shown in the slash menu.',
    toolsLabel: 'Allowed tools',
    toolsAll: 'No restriction',
    modelNone: 'The chat\'s model',
    saved: 'Command saved',
  },
  // + Phase 12 (ADR-058): a skill's Allowed tools and Model work as a command's (9.14).
  skill: {
    descriptionHelp: 'When the agent should load it. It reads this to decide.',
    toolsLabel: 'Allowed tools',
    toolsAll: 'No restriction',
    modelNone: 'The chat\'s model',
    saved: 'Skill saved',
  },
  style: {
    descriptionHelp: 'Shown in the composer\'s style menu.',
    toolsLabel: 'Tools',
    toolsAll: 'All tools the chat allows',
    modelNone: 'The chat\'s model',
    saved: 'Output style saved',
  },
}

/** The empty states of the Personal and project sections (docs/UI.md 9.12). */
export const PERSONAL_EMPTY: Readonly<Record<CustomizationKind, string>> = {
  agent: 'No personal agents yet. An agent is a sub-agent with its own instructions and tools that the main agent can start.',
  command: 'No personal commands yet. A command is a saved prompt you run with /name.',
  skill: 'No personal skills yet. A skill is a set of instructions the agent loads when a task needs it.',
  style: 'No personal output styles yet. A style changes how the agent writes its replies.',
}

export function projectEmpty(kind: CustomizationKind, project: string): string {
  switch (kind) {
    case 'agent':
      return `No agents in ${project}. Add Markdown files to .harness/agents/ (or .claude/agents/) in the project folder.`
    case 'command':
      return `No commands in ${project}. Add Markdown files to .harness/commands/ (or .claude/commands/) in the project folder.`
    case 'skill':
      return `No skills in ${project}. Add a folder with a SKILL.md to .harness/skills/ (or .claude/skills/) in the project folder.`
    case 'style':
      return `No output styles in ${project}. Add Markdown files to .harness/output-styles/ (or .claude/output-styles/) in the project folder.`
  }
}

/**
 * The diagnostics of a formatted file that point into its body, with their lines moved to the body as the editor
 * shows it (`body` as typed: leading blank lines count). Frontmatter diagnostics and those without a line are dropped
 * (the fields show them).
 */
export function bodyDiagnostics(content: string, body: string, diagnostics: readonly DefinitionDiagnostic[]): DefinitionDiagnostic[] {
  const lines = content.split('\n')
  const close = lines.indexOf('---', 1)
  if (close < 0)
    return []
  // The formatted body starts after the closing `---` and one blank line; the editor keeps the leading blank lines.
  const firstBodyLine = close + 3
  const leading = body.match(/^(?:[ \t]*\n)*/)?.[0].split('\n').length ?? 1
  const shift = firstBodyLine - leading
  return diagnostics
    .filter(diagnostic => diagnostic.line !== undefined && diagnostic.line >= firstBodyLine)
    .map(diagnostic => ({ ...diagnostic, line: diagnostic.line! - shift }))
}

// ---------- Phase 12: Claude Code frontmatter fields (ADR-058; docs/UI.md 9.14) ----------

/** The color names of the agent Color select and the row meta, in `AGENT_COLORS` order. */
export const AGENT_COLOR_LABELS: Readonly<Record<AgentColor, string>> = {
  red: 'Red',
  blue: 'Blue',
  green: 'Green',
  yellow: 'Yellow',
  purple: 'Purple',
  orange: 'Orange',
  pink: 'Pink',
  cyan: 'Cyan',
}

/** The Max turns input as a number: a whole number from 1 to 200, else null (empty or invalid). */
export function maxTurnsValue(text: string): number | null {
  const value = text.trim()
  if (!/^\d{1,4}$/.test(value))
    return null
  const turns = Number(value)
  return turns >= 1 && turns <= DEFINITION_LIMITS.maxTurnsMax ? turns : null
}

/** The Max turns problem (empty = no limit of its own), else null. */
export function maxTurnsError(text: string): string | null {
  if (text.trim() === '' || maxTurnsValue(text) !== null)
    return null
  return `Enter a whole number from 1 to ${DEFINITION_LIMITS.maxTurnsMax}.`
}

/** The Skills problem of an agent (at most 5 preloaded skills), else null. */
export function skillsError(skills: readonly string[] | null | undefined): string | null {
  return (skills?.length ?? 0) > DEFINITION_LIMITS.agentSkillsMax ? `Choose at most ${DEFINITION_LIMITS.agentSkillsMax} skills.` : null
}

/** The When to use problem (at most 1,024 characters), else null. */
export function whenToUseError(text: string | null | undefined): string | null {
  return (text?.trim().length ?? 0) > DEFINITION_LIMITS.whenToUseMaxChars ? atMost(DEFINITION_LIMITS.whenToUseMaxChars) : null
}

// ---------- Phase 12: project files (ADR-056; docs/UI.md 9.14) ----------

/** The kind words of the project file editor's title ("New {kind} in {project}"). */
export const PROJECT_FILE_KIND_LABEL: Readonly<Record<ProjectFileTarget['kind'], string>> = {
  agent: 'agent',
  command: 'command',
  skill: 'skill',
  style: 'output style',
  mcp: '.mcp.json',
}

/** The note under the project file editor. */
export const PROJECT_FILE_NOTE = 'Saving never approves hooks or shell lines.'

/**
 * True for a project row whose file can be edited and deleted from Customize: a project entry whose `path` is an
 * editable definition file of the entry's kind (`projectDefinitionPathKind`).
 */
export function isEditableProjectEntry(entry: Pick<CustomizationEntry, 'kind' | 'source' | 'path'>): boolean {
  return entry.source === 'project' && !!entry.path && projectDefinitionPathKind(entry.path) === entry.kind
}

/** The file a project path names in titles: its last segment (`reviewer.md`), a skill as `<folder>/SKILL.md`. */
export function projectFileName(path: string): string {
  const segments = path.split('/').filter(segment => segment !== '')
  const file = segments.at(-1) ?? path
  return file === 'SKILL.md' && segments.length > 1 ? `${segments.at(-2)}/${file}` : file
}

/** The editor's title: "Edit {file}", or "New {kind} in {project}" for a new file. */
export function projectFileTitle(target: Pick<ProjectFileTarget, 'kind' | 'path'>, mode: 'edit' | 'new', projectName: string | null): string {
  if (mode === 'new')
    return `New ${PROJECT_FILE_KIND_LABEL[target.kind]} in ${projectName ?? 'this project'}`
  return `Edit ${projectFileName(target.path)}`
}

/** The toast after a save: "Saved {path}." and, with pending approvals, "{n} items need your approval.". */
export function projectSavedText(path: string, pending: number): string {
  if (pending <= 0)
    return `Saved ${path}.`
  return `Saved ${path}. ${pending === 1 ? '1 item needs' : `${pending} items need`} your approval.`
}

/** The texts of the project file delete confirmation and its toast. */
export function projectDeleteCopy(path: string): { title: string, description: string, confirm: string, toast: string } {
  return {
    title: `Delete ${path}?`,
    description: 'The file is removed from the project folder. It can\'t be undone here.',
    confirm: 'Delete file',
    toast: `Deleted ${path}`,
  }
}

/** The starting content of a new definition file of a kind (the parser asks for the missing description). */
export function newProjectFileContent(kind: Exclude<ProjectFileTarget['kind'], 'mcp'>, name: string): string {
  const stem = name.trim()
  // A command's name is its file name; the other kinds name themselves.
  const nameLine = kind === 'command' || stem === '' ? '' : `name: ${stem}\n`
  return `---\n${nameLine}description: \n---\n\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The text the editor shows for `.mcp.json` (docs/UI.md 9.14: the `mcpServers` object as JSON): the object of the
 * file's `mcpServers` key, pretty-printed; `{}` for a missing file; the raw text when the file is not a JSON object with
 * an `mcpServers` object (so nothing is hidden).
 */
export function mcpServersText(content: string | null): string {
  if (content === null)
    return '{}\n'
  try {
    const parsed: unknown = JSON.parse(content.replace(/^\uFEFF/, ''))
    if (isRecord(parsed) && isRecord(parsed.mcpServers))
      return `${JSON.stringify(parsed.mcpServers, null, 2)}\n`
  }
  catch {
    // Shown as written.
  }
  return content
}

/**
 * The `mcpServers` object of the editor's `.mcp.json` text, with or without the `{ "mcpServers": … }` wrapper; null for
 * an empty text (the key is removed). Throws a SyntaxError for text that is not a JSON object.
 */
export function mcpServersOf(text: string): Record<string, unknown> | null {
  if (text.trim() === '')
    return null
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!isRecord(parsed))
    throw new SyntaxError('Expected a JSON object.')
  return isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
}

/** One problem of a project file as the editor lists it. */
export interface ProjectFileProblem {
  level: 'error' | 'warning' | 'info'
  message: string
}

/** What the project file editor shows beside the raw text: the parsed summary and the shared parsers' diagnostics. */
export interface ProjectFileCheck {
  /** "Agent reviewer", "Not allowed: shell", "Max turns 12", …; for `.mcp.json` "{n} servers". */
  summary: string[]
  /** An agent's color (shown as a dot and its name after the summary). */
  color: AgentColor | null
  /** Every diagnostic, errors first (they block saving). */
  problems: ProjectFileProblem[]
  /** The definition diagnostics with a line (lint markers of the raw editor). */
  markers: DefinitionDiagnostic[]
  /** True when an error diagnostic blocks saving. */
  blocked: boolean
}

function toolsText(label: string, tools: readonly string[] | null | undefined): string | null {
  if (!tools)
    return null
  return `${label}: ${tools.length > 0 ? tools.join(', ') : 'none'}`
}

function sortedProblems(problems: ProjectFileProblem[]): ProjectFileProblem[] {
  const rank = { error: 0, warning: 1, info: 2 } as const
  return [...problems].sort((a, b) => rank[a.level] - rank[b.level])
}

function definitionSummary(definition: ParsedDefinition): { summary: string[], color: AgentColor | null } {
  const items: (string | null)[] = []
  let color: AgentColor | null = null
  switch (definition.kind) {
    case 'agent': {
      const fields = definition.fields
      items.push(`Agent ${fields.name}`, toolsText('Tools', fields.tools), toolsText('Not allowed', fields.disallowedTools))
      if (typeof fields.maxTurns === 'number')
        items.push(`Max turns ${fields.maxTurns}`)
      if (fields.skills && fields.skills.length > 0)
        items.push(`Skills: ${fields.skills.join(', ')}`)
      items.push(fields.model === 'inherit' ? 'Same model as the chat' : fields.model ?? fields.modelAlias ?? null)
      color = fields.color ?? null
      break
    }
    case 'command':
    case 'skill': {
      const fields = definition.fields
      items.push(definition.kind === 'command' ? `Command /${fields.name}` : `Skill ${fields.name}`)
      if (definition.kind === 'skill') {
        const invocation = skillInvocation(definition.fields)
        if (!invocation.userInvocable)
          items.push('Not in the slash menu')
        if (!invocation.modelInvocable)
          items.push('Only when you run it')
      }
      items.push(toolsText('Allowed tools', fields.allowedTools), toolsText('Not allowed', fields.disallowedTools))
      if (fields.arguments && fields.arguments.length > 0)
        items.push(`Arguments: ${fields.arguments.join(', ')}`)
      items.push(fields.model ?? fields.modelAlias ?? null)
      if (fields.context === 'fork')
        items.push(`Runs in a sub-agent (${fields.agent ?? 'general'})`)
      break
    }
    case 'style': {
      const fields = definition.fields
      items.push(`Output style ${fields.label || fields.name}`, fields.keepCodingInstructions ? 'Keeps coding instructions' : 'Replaces coding instructions')
      break
    }
  }
  return { summary: items.filter((item): item is string => item !== null && item !== ''), color }
}

/**
 * Checks the raw text of a project file with the shared parsers (`parseDefinition`, `parseMcpJson`): the parsed summary
 * ("Agent reviewer · Not allowed: shell · Max turns 12" and the color; "{n} servers" for `.mcp.json`), every diagnostic
 * (errors block saving; warnings and info do not) and the lint markers of the raw editor.
 */
export function checkProjectFile(kind: ProjectFileTarget['kind'], path: string, text: string): ProjectFileCheck {
  if (kind === 'mcp') {
    let servers: Record<string, unknown> | null
    try {
      servers = mcpServersOf(text)
    }
    catch {
      return { summary: [], color: null, problems: [{ level: 'error', message: 'This isn\'t valid JSON.' }], markers: [], blocked: true }
    }
    const parsed = parseMcpJson(JSON.stringify({ mcpServers: servers ?? {} }))
    const problems = sortedProblems(parsed.diagnostics.map(diagnostic => ({
      level: diagnostic.level,
      message: diagnostic.server ? `${diagnostic.server}: ${diagnostic.message}` : diagnostic.message,
    })))
    const count = parsed.servers.length
    return {
      summary: [count === 1 ? '1 server' : `${count} servers`],
      color: null,
      problems,
      markers: [],
      blocked: problems.some(problem => problem.level === 'error'),
    }
  }
  const segments = path.split('/')
  const fileName = segments.at(-1) ?? ''
  const folderName = kind === 'skill' ? segments.at(-2) : undefined
  const parsed = parseDefinition(kind, text, { fileName, ...(folderName ? { folderName } : {}) })
  const { summary, color } = parsed.definition ? definitionSummary(parsed.definition) : { summary: [], color: null }
  const problems = sortedProblems(parsed.diagnostics.map(diagnostic => ({ level: diagnostic.level, message: diagnostic.message })))
  return {
    summary,
    color,
    problems,
    markers: parsed.diagnostics.filter(diagnostic => diagnostic.line !== undefined),
    blocked: parsed.definition === null || problems.some(problem => problem.level === 'error'),
  }
}
