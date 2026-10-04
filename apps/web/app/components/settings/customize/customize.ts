// Pure helpers of Settings -> Customize (docs/UI.md 9.12, 11.7; ADR-044, ADR-045): the source sections of a kind, the
// state badge and the meta line of a row, the editor's structured draft (from a personal definition, a catalog entry or
// an imported file) and the editor copy per kind. Definition files are parsed and formatted only by the shared
// `parseDefinition` / `formatDefinition`. No Vue, no stores.
// Signatures frozen from Gate P10-0b (C33); W10.8 owns the copy and the details in P10-A.
import type {
  Customization,
  CustomizationEntry,
  CustomizationKind,
  CustomizationList,
  CustomizationSource,
  ParsedDefinition,
} from '@harness-forge/shared'
import { parseDefinition } from '@harness-forge/shared'

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

/** The `?tab=` value of each kind. */
export const CUSTOMIZE_TABS: Readonly<Record<CustomizationKind, 'agents' | 'commands' | 'skills'>> = {
  agent: 'agents',
  command: 'commands',
  skill: 'skills',
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

/**
 * The muted second line of a row, item by item: the source badge, the project path, the namespace, the model ("Same as
 * the chat" for `inherit`), the tools ("{n} tools" / "All tools" for agents, "Tools limited to {n}" for commands) and
 * the argument hint.
 */
export function rowMeta(entry: CustomizationEntry, pluginName: (id: string) => string): string[] {
  const items = [sourceLabel(entry, pluginName)]
  if (entry.path)
    items.push(entry.path)
  if (entry.namespace)
    items.push(entry.namespace)
  if (entry.modelRef)
    items.push(entry.modelRef === 'inherit' ? 'Same as the chat' : entry.modelRef)
  if (entry.kind === 'agent')
    items.push(entry.tools ? `${entry.tools.length} tool${entry.tools.length === 1 ? '' : 's'}` : 'All tools')
  else if (entry.kind === 'command' && entry.tools)
    items.push(`Tools limited to ${entry.tools.length}`)
  if (entry.argumentHint)
    items.push(entry.argumentHint)
  return items
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

/**
 * Reads an imported `.md` file (UTF-8, BOM and CRLF accepted) as a draft of `kind`, with one note per diagnostic of
 * the parser. W10.8 adds the size check, the notes' wording and the "Imported from {file}" line.
 */
export async function importDraft(file: File, kind: CustomizationKind): Promise<{ draft: CustomizationDraft, notes: string[] }> {
  const text = (await file.text()).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const stem = file.name.replace(/\.md$/i, '')
  const parsed = parseDefinition(kind, text, { fileName: file.name, folderName: stem })
  const notes = parsed.diagnostics.map(diagnostic => diagnostic.message)
  const draft = parsed.definition ? draftFromDefinition(parsed.definition) : { ...emptyDraft(kind), body: text }
  return { draft, notes }
}

/** The editor copy per kind (docs/UI.md 9.12). */
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
}
