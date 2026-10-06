// Pure helpers of Settings -> Customize (docs/UI.md 9.12, 11.7, 15; ADR-044, ADR-045): the source sections of a kind
// (with the built-in command rows), the state badge, the shadowed tooltip and the meta line of a row, the editor's
// structured draft (from a personal definition, a catalog entry or an imported file) and its content, the field rules
// and their copy, the import notes, free names for Duplicate, and the copy per kind. Definition files are parsed and
// formatted only by the shared `parseDefinition` / `formatDefinition`. No Vue, no stores.
// Signatures frozen from Gate P10-0b (C33); W10.8 owns the copy and the details in P10-A.
import type {
  CommandSummary,
  Customization,
  CustomizationEntry,
  CustomizationKind,
  CustomizationList,
  CustomizationSource,
  DefinitionDiagnostic,
  ParsedDefinition,
} from '@harness-forge/shared'
import {
  AGENT_NAME_PATTERN,
  CLIENT_COMMANDS,
  COMMAND_NAME_PATTERN,
  DEFINITION_LIMITS,
  formatDefinition,
  isBuiltinOutputStyle,
  isClientCommand,
  isHarnessCommand,
  isReservedAgentName,
  parseDefinition,
} from '@harness-forge/shared'
import { CLIENT_COMMAND_DESCRIPTIONS } from '~/components/chat/composer/slash-commands'

/** The actions of a row's menu (docs/UI.md 9.12). */
export type CustomizationAction = 'edit' | 'view' | 'duplicate' | 'export' | 'toggle' | 'delete' | 'open-plugin'

/** The editor's structured fields; `formatDefinition` turns them into the content that is saved. */
export interface CustomizationDraft {
  kind: CustomizationKind
  name: string
  description: string
  /** Agents: tools; commands: allowed-tools; null = no restriction. */
  tools: string[] | null
  /** A model ref, 'inherit' (agents) or null. */
  model: string | null
  /** Commands. */
  argumentHint: string | null
  /** Instructions / prompt / skill content. */
  body: string
}

/** The `?tab=` value of each kind (Phase 11: output styles, ADR-051). */
export const CUSTOMIZE_TABS: Readonly<Record<CustomizationKind, 'agents' | 'commands' | 'skills' | 'output-styles'>> = {
  agent: 'agents',
  command: 'commands',
  skill: 'skills',
  style: 'output-styles',
}

/** The kind of a `?tab=` value: `agents` when it is missing or unknown. */
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
  if (entry.argumentHint)
    items.push({ text: entry.argumentHint, mono: true })
  if (entry.source === 'builtin' && entry.kind === 'command')
    items.push({ text: RESERVED_COMMAND_NOTE })
  return items
}

/** The texts of `rowMetaItems` (paths in full, models as their refs). */
export function rowMeta(entry: CustomizationEntry, pluginName: (id: string) => string): string[] {
  return rowMetaItems(entry, pluginName).map(item => item.title ?? item.text)
}

/** An empty draft of a kind. */
export function emptyDraft(kind: CustomizationKind): CustomizationDraft {
  return { kind, name: '', description: '', tools: null, model: null, argumentHint: null, body: '' }
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
      }
    }
    case 'skill': {
      const fields = definition.fields
      return { kind: 'skill', name: fields.name, description: fields.description, tools: null, model: null, argumentHint: null, body: fields.content }
    }
    case 'style': {
      const fields = definition.fields
      return { kind: 'style', name: fields.name, description: fields.description, tools: null, model: null, argumentHint: null, body: fields.content }
    }
  }
}

/** The draft of a personal definition, from its parsed fields (the stored content when they are missing). */
export function draftFromUser(customization: Customization): CustomizationDraft {
  if (customization.fields)
    return draftFromDefinition({ kind: customization.kind, fields: customization.fields } as ParsedDefinition)
  return draftFromEntry({ kind: customization.kind, name: customization.name, description: customization.description } as CustomizationEntry, customization.content)
}

/** The draft of a catalog entry from its file (`parseDefinition` inside); unparsable content keeps the entry's fields. */
export function draftFromEntry(entry: CustomizationEntry, content: string): CustomizationDraft {
  const parsed = parseDefinition(entry.kind, content, { fileName: `${entry.name}.md`, folderName: entry.name })
  if (parsed.definition)
    return draftFromDefinition(parsed.definition)
  return { ...emptyDraft(entry.kind), name: entry.name, description: entry.description, body: content }
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

/** The definition the editor saves (`formatDefinition` turns it into the content). Names and texts are trimmed. */
export function draftDefinition(draft: CustomizationDraft): ParsedDefinition {
  const name = draft.name.trim()
  const description = draft.description.trim()
  switch (draft.kind) {
    case 'agent':
      return { kind: 'agent', fields: { name, description, tools: draft.tools, model: draft.model, instructions: draft.body } }
    case 'command':
      return {
        kind: 'command',
        fields: {
          name,
          description,
          argumentHint: draft.argumentHint?.trim() || null,
          model: draft.model === 'inherit' ? null : draft.model,
          allowedTools: draft.tools,
          body: draft.body,
        },
      }
    case 'skill':
      return { kind: 'skill', fields: { name, description, content: draft.body } }
    case 'style':
      return { kind: 'style', fields: { name, label: name, description, keepCodingInstructions: false, content: draft.body } }
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
        ? 'Chats that used it keep their messages and use the default style from now on.'
        : 'Chats that used it keep their messages. The agent can\'t load it anymore.'
  return { title: `Delete ${name}?`, description, confirm: `Delete ${KIND_LABEL[kind]}`, toast: `Deleted ${name}` }
}

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
    bodyHelp: '$ARGUMENTS is the text after the command; $1 to $9 are single words (quotes group words); {{input}} works too. Without a placeholder the text is added at the end.',
    save: 'Save command',
  },
  skill: {
    title: 'skill',
    body: 'Instructions',
    bodyHelp: 'A personal skill is one file. Put scripts and reference files in a project skill folder.',
    save: 'Save skill',
  },
  style: {
    title: 'output style',
    body: 'Instructions',
    bodyHelp: 'How the agent should write its replies. They go first in its instructions.',
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
  skill: {
    descriptionHelp: 'When the agent should load it. It reads this to decide.',
    toolsLabel: 'Tools',
    toolsAll: 'All tools the chat allows',
    modelNone: 'Default sub-agent model',
    saved: 'Skill saved',
  },
  style: {
    descriptionHelp: 'Shown in the output style menu.',
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
  style: 'No personal output styles yet. An output style changes how the agent writes its replies.',
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
