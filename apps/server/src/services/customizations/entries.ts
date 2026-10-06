// Catalog entries of parsed definitions (Phase 10, ADR-044; API.md 4.28). Owner: W10.1. Pure helpers shared by the
// discovery (project files), the user store (personal rows) and the plugin entries:
// - `entryFromParse`: a `CustomizationEntry` of a `parseDefinition` result (`active`, `off` for a turned-off personal
//   row, `invalid` when the parse has an `error`); the declared model, tools and argument hint are listed;
// - `checkEntry`: the catalog checks of the live state: a tool name the tool registry does not know is a warning
//   (`unknown-tool`, never an error; `mcp__*` names are not checked: MCP servers come and go) and a model whose provider
//   is not configured is a warning (`invalid-model`; the run resolves the model again and falls back);
// - `shadowDiagnostic`: the `shadowed` info of an entry another source wins, `duplicate-name` within one folder.
// Diagnostics never quote file contents: only names that passed the name or tool-name patterns, paths and sources.
import type {
  CustomizationEntry,
  CustomizationKind,
  CustomizationShadowedBy,
  CustomizationSource,
  DefinitionDiagnostic,
  ParseDefinitionResult,
} from '@harness-forge/shared'
import { DEFINITION_LIMITS, MCP_TOOL_PREFIX, safeParseModelRef } from '@harness-forge/shared'

/** Diagnostics kept per entry and per catalog (`definitionDiagnosticSchema` lists are capped at 100). */
export const DIAGNOSTICS_MAX = 100
/** Characters of the name of an entry that cannot be read (`customizationEntrySchema`). */
const ENTRY_NAME_MAX = 256
/** `unknown-tool` diagnostics of one entry before they are counted in one more. */
const UNKNOWN_TOOLS_SHOWN_MAX = 10

/** Adds a diagnostic unless the list is full (`DIAGNOSTICS_MAX`). */
export function pushDiagnostic(list: DefinitionDiagnostic[], diagnostic: DefinitionDiagnostic): void {
  if (list.length < DIAGNOSTICS_MAX)
    list.push(diagnostic)
}

/** Where an entry comes from besides its source: the row, the plugin, the file. */
export interface EntryOrigin {
  readonly id?: string
  readonly pluginId?: string
  readonly path?: string
  readonly namespace?: string
  /** Personal rows: the `enabled` flag (default true). */
  readonly enabled?: boolean
  /** The name of an entry whose definition cannot be used (the file stem, the skill folder, the stored name). */
  readonly fallbackName: string
}

function validModelRef(model: string | null): string | undefined {
  if (model === null)
    return undefined
  return model === 'inherit' || safeParseModelRef(model) !== null ? model : undefined
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/**
 * The catalog entry of a parsed definition. Project entries get their path stamped on every diagnostic. The state is
 * `off` for a turned-off personal row, else `invalid` when the parse has an `error`, else `active` (the precedence of
 * the catalog may turn it `shadowed`).
 */
export function entryFromParse(kind: CustomizationKind, source: CustomizationSource, result: ParseDefinitionResult, origin: EntryOrigin): CustomizationEntry {
  const diagnostics: DefinitionDiagnostic[] = []
  for (const item of result.diagnostics)
    pushDiagnostic(diagnostics, origin.path === undefined ? item : { ...item, path: origin.path })
  const enabled = origin.enabled ?? true
  const base = {
    kind,
    source,
    ...(origin.id === undefined ? {} : { id: origin.id }),
    ...(origin.pluginId === undefined ? {} : { pluginId: origin.pluginId }),
    ...(origin.path === undefined ? {} : { path: origin.path }),
    ...(kind === 'command' && origin.namespace !== undefined ? { namespace: origin.namespace } : {}),
    enabled,
    diagnostics,
  }
  const definition = result.definition
  const usable = definition !== null && definition.kind === kind && !result.diagnostics.some(item => item.level === 'error')
  if (!usable || definition === null) {
    const name = cut(origin.fallbackName, ENTRY_NAME_MAX) || kind
    return { ...base, name, description: '', state: enabled ? 'invalid' : 'off' }
  }
  const state = enabled ? 'active' : 'off'
  const description = cut(definition.fields.description, DEFINITION_LIMITS.descriptionMaxChars)
  switch (definition.kind) {
    case 'agent': {
      const { name, tools, model } = definition.fields
      const modelRef = validModelRef(model)
      return { ...base, name, description, ...(modelRef === undefined ? {} : { modelRef }), ...(tools === null ? {} : { tools: [...tools] }), state }
    }
    case 'command': {
      const { name, argumentHint, allowedTools, model } = definition.fields
      const modelRef = validModelRef(model)
      return {
        ...base,
        name,
        description,
        ...(argumentHint === null ? {} : { argumentHint }),
        ...(modelRef === undefined || modelRef === 'inherit' ? {} : { modelRef }),
        ...(allowedTools === null ? {} : { tools: [...allowedTools] }),
        state,
      }
    }
    case 'skill': {
      const { name, userInvocable, modelInvocable, argumentHint } = definition.fields
      return {
        ...base,
        name,
        description,
        ...(argumentHint === undefined ? {} : { argumentHint }),
        ...(userInvocable === undefined ? {} : { userInvocable }),
        ...(modelInvocable === undefined ? {} : { modelInvocable }),
        state,
      }
    }
    case 'style': {
      const { name, label, keepCodingInstructions } = definition.fields
      return { ...base, name, description, label: cut(label, ENTRY_NAME_MAX), keepCodingInstructions, state }
    }
  }
}

// ---------- checks against the live state ----------

/** What the catalog checks entries against (read once per build). */
export interface CatalogCheckContext {
  /** Names of the registered tools (the tool registry). */
  readonly tools: ReadonlySet<string>
  /** Ids of the providers the user configured (enabled, credentials present); null = unknown (no model check). */
  readonly providers: ReadonlySet<string> | null
}

/**
 * The entry with the `unknown-tool` and `invalid-model` warnings of the live state added (an entry without tools or a
 * model is returned as is). Never changes the state: both are warnings.
 */
export function checkEntry(entry: CustomizationEntry, context: CatalogCheckContext): CustomizationEntry {
  const added: DefinitionDiagnostic[] = []
  const unknown = (entry.tools ?? []).filter(tool => !tool.startsWith(MCP_TOOL_PREFIX) && !context.tools.has(tool))
  for (const tool of unknown.slice(0, UNKNOWN_TOOLS_SHOWN_MAX))
    added.push({ level: 'warning', code: 'unknown-tool', message: `Unknown tool: ${tool}; it matches nothing.` })
  if (unknown.length > UNKNOWN_TOOLS_SHOWN_MAX) {
    const more = unknown.length - UNKNOWN_TOOLS_SHOWN_MAX
    added.push({ level: 'warning', code: 'unknown-tool', message: `${more} more unknown ${more === 1 ? 'tool matches' : 'tools match'} nothing.` })
  }
  const modelRef = entry.modelRef
  if (modelRef !== undefined && modelRef !== 'inherit' && context.providers !== null) {
    const providerId = safeParseModelRef(modelRef)?.providerId
    if (providerId !== undefined && !context.providers.has(providerId)) {
      const fallback = entry.kind === 'agent' ? 'the default sub-agent model is used' : 'the chat\'s model is used'
      added.push({ level: 'warning', code: 'invalid-model', message: `The provider "${providerId}" is not configured; ${fallback}.` })
    }
  }
  if (added.length === 0)
    return entry
  const diagnostics = [...entry.diagnostics]
  for (const item of added)
    pushDiagnostic(diagnostics, entry.path === undefined ? item : { ...item, path: entry.path })
  return { ...entry, diagnostics }
}

// ---------- precedence diagnostics ----------

/** The definition folder of a project path (`.harness/commands` of `.harness/commands/a/review.md`). */
function definitionFolderOf(path: string | undefined): string | null {
  if (path === undefined)
    return null
  const segments = path.split('/')
  return segments.length >= 3 ? `${segments[0]}/${segments[1]}` : null
}

function winnerText(kind: CustomizationKind, by: CustomizationShadowedBy): string {
  switch (by.source) {
    case 'project':
      return `the project's ${by.path ?? 'definition'}`
    case 'user':
      return `your personal ${kind}`
    case 'plugin':
      return by.pluginId === undefined ? `a plugin's ${kind}` : `the ${kind} of the plugin ${by.pluginId}`
    case 'builtin':
      return `the built-in ${kind}`
  }
}

/**
 * The precedence diagnostic of a `shadowed` entry: `duplicate-name` (a warning) when the winner is a file of the same
 * project folder (the first sorted path wins), else `shadowed` (an info) naming the winner. Other entries unchanged.
 */
export function withShadowDiagnostic(entry: CustomizationEntry): CustomizationEntry {
  const by = entry.shadowedBy
  if (entry.state !== 'shadowed' || by === undefined)
    return entry
  const folder = definitionFolderOf(entry.path)
  const sameFolder = entry.source === 'project' && by.source === 'project' && folder !== null && folder === definitionFolderOf(by.path)
  const diagnostic: DefinitionDiagnostic = sameFolder
    ? { level: 'warning', code: 'duplicate-name', message: `Not used: ${by.path ?? 'another file'} has the same name and comes first in ${folder}.` }
    : { level: 'info', code: 'shadowed', message: `Not used: ${winnerText(entry.kind, by)} wins.` }
  const diagnostics = [...entry.diagnostics]
  pushDiagnostic(diagnostics, entry.path === undefined ? diagnostic : { ...diagnostic, path: entry.path })
  return { ...entry, diagnostics }
}
