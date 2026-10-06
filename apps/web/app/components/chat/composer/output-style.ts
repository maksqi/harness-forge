// Pure helpers of the composer's output style picker and refusal (Phase 11, ADR-048, ADR-051; docs/UI.md 7.31, 7.32,
// 11.8): the options of OutputStyleMenu from the catalog's style entries (built-ins first, then by source), what
// "Automatic" resolves to (the project's style, else the global default), the `/output-style <query>` lookup, and the
// refusal of a submit that a hook blocked or that runs unapproved shell lines (409 `hook-blocked` / `untrusted`). No
// stores; the only Vue import is the type of `OUTPUT_STYLE_SCOPE`. Signatures frozen from Gate P11-0b (C39); W11.10
// owns the bodies (P11-A) and adds the display helpers below them.
import type { CustomizationEntry, CustomizationSource, HookEvent } from '@harness-forge/shared'
import type { InjectionKey, Ref } from 'vue'
import { BUILTIN_OUTPUT_STYLES, DEFAULT_OUTPUT_STYLE, hookDataSchema, isBuiltinOutputStyle } from '@harness-forge/shared'
import { toHarnessError } from '~/utils/errors'

/** One style of the menu (docs/UI.md 7.32). */
export interface OutputStyleOption {
  /** The style's name (the slug): what the chat stores. */
  name: string
  /** The display name (a style's `label`, else its name). */
  label: string
  description: string
  source: CustomizationSource
  /** False for a chosen style that no longer exists or is not active ("Not available"). */
  available: boolean
}

/** What ComposerRefusal shows (docs/UI.md 7.31). */
export interface ComposerRefusalData {
  code: 'hook-blocked' | 'untrusted'
  /** The error's message (the hook's reason, or the server's text). */
  reason: string
  /** `hook-blocked`: the event of `details.hook`, when the record came with the error. */
  event: HookEvent | null
  /** `hook-blocked`: the source of the record's first hook (`personal` / `project` / `plugin`). */
  source: string | null
  /** `untrusted`: the command name (`/name` without the slash), when the host knows it. */
  command: string | null
}

const SOURCE_ORDER: readonly CustomizationSource[] = ['builtin', 'user', 'project', 'plugin']

/**
 * The options of the menu: the built-ins (Default, Explanatory, Learning) first, then the active personal, project and
 * plugin styles of `entries` (shadowed, invalid and turned-off styles are left out), each group by label.
 */
export function styleOptions(entries: readonly CustomizationEntry[]): OutputStyleOption[] {
  const options: OutputStyleOption[] = BUILTIN_OUTPUT_STYLES.map(style => ({
    name: style.name,
    label: style.label,
    description: style.description,
    source: 'builtin',
    available: true,
  }))
  const seen = new Set(options.map(option => option.name))
  const rest: OutputStyleOption[] = []
  for (const entry of entries) {
    if (entry.kind !== 'style' || entry.state !== 'active' || !entry.enabled || seen.has(entry.name) || isBuiltinOutputStyle(entry.name))
      continue
    // The server resolved the precedence (one active entry per name); a second one is a stale or merged answer.
    seen.add(entry.name)
    rest.push({
      name: entry.name,
      label: entry.label?.trim() || entry.name,
      description: entry.description,
      source: entry.source,
      available: true,
    })
  }
  rest.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.label.localeCompare(b.label, 'en'))
  return [...options, ...rest]
}

/** What "Automatic" resolves to: the project's style, else the global default; null when neither is an option. */
export function automaticStyle(projectStyle: string | null, globalStyle: string, options: readonly OutputStyleOption[]): OutputStyleOption | null {
  const name = projectStyle?.trim() || globalStyle.trim()
  if (!name)
    return null
  return options.find(option => option.name === name) ?? null
}

/**
 * `/output-style <query>`: `auto` / `automatic` → Automatic (`style: null`); a name or a label (case-insensitive) → that
 * style; anything else → the error text of docs/UI.md 7.32.
 */
export function resolveStyleQuery(query: string, options: readonly OutputStyleOption[]): { style: string | null } | { error: string } {
  const value = query.trim()
  const lower = value.toLowerCase()
  if (lower === 'auto' || lower === 'automatic')
    return { style: null }
  const offered = options.filter(option => option.available)
  const found = offered.find(option => option.name.toLowerCase() === lower)
    ?? offered.find(option => option.label.toLowerCase() === lower)
  if (found)
    return { style: found.name }
  return { error: `Unknown output style "${value}". Use auto, default, explanatory, learning or a style from the menu.` }
}

/**
 * The refusal of a submit: a `409 conflict` with `details.reason` `hook-blocked` (the event and the first hook's source
 * from `details.hook`, a `HookData`, when it is valid) or `untrusted`; null for every other error.
 */
export function refusalOf(error: unknown): ComposerRefusalData | null {
  if (error === null || error === undefined)
    return null
  const harness = toHarnessError(error)
  if (harness.code !== 'conflict')
    return null
  const details = harness.details as { reason?: unknown, hook?: unknown } | undefined
  if (details?.reason === 'untrusted')
    return { code: 'untrusted', reason: harness.message, event: null, source: null, command: null }
  if (details?.reason !== 'hook-blocked')
    return null
  const parsed = hookDataSchema.safeParse(details.hook)
  const record = parsed.success ? parsed.data : null
  return {
    code: 'hook-blocked',
    reason: harness.message,
    event: record?.event ?? null,
    source: record?.hooks[0]?.source ?? null,
    command: null,
  }
}

// ---------- display helpers (W11.10, P11-A) ----------

/**
 * What OutputStyleMenu needs beyond its frozen props (provided by ChatComposer): the chat's project, whether that
 * project chose a style (Automatic then reads "set for {project}") and the plugin names of plugin styles.
 */
export interface OutputStyleScope {
  projectId: string | null
  /** The project's display name (null without a project or before the projects store knows it). */
  projectName: string | null
  /** The project's own style (`projects.outputStyle`), trimmed; null = none (the global default applies). */
  projectStyle: string | null
  /** Plugin styles: the contributing plugin's name per style name. */
  pluginNames: Readonly<Record<string, string>>
}

/** ChatComposer provides it, OutputStyleMenu injects it (a local adapter; the menu's props stay as frozen). */
export const OUTPUT_STYLE_SCOPE: InjectionKey<Readonly<Ref<OutputStyleScope>>> = Symbol('hf-output-style-scope')

/** The scope without a project. */
export const NO_OUTPUT_STYLE_SCOPE: OutputStyleScope = Object.freeze({ projectId: null, projectName: null, projectStyle: null, pluginNames: Object.freeze({}) })

/** True for the built-in Default style (the trigger then shows the icon alone, without the dot). */
export function isDefaultStyle(name: string): boolean {
  return name === DEFAULT_OUTPUT_STYLE
}

/** The muted text on the right of a style row: "Built-in", "Personal", "Project" or the plugin's name ("Plugin"). */
export function styleSourceText(option: Pick<OutputStyleOption, 'name' | 'source'>, pluginNames: Readonly<Record<string, string>> = {}): string {
  switch (option.source) {
    case 'builtin':
      return 'Built-in'
    case 'user':
      return 'Personal'
    case 'project':
      return 'Project'
    case 'plugin':
      return pluginNames[option.name] ?? 'Plugin'
  }
}

/**
 * The line under "Automatic": "Uses {name}, set for {project}" while the project chose a style, else "Uses {name},
 * your default in Settings". A style that is not offered reads as Default (the server answers with Default then).
 */
export function automaticStyleLine(automatic: OutputStyleOption | null, scope: Pick<OutputStyleScope, 'projectName' | 'projectStyle'>): string {
  const name = automatic?.label ?? 'Default'
  if (scope.projectStyle)
    return `Uses ${name}, set for ${scope.projectName ?? 'this project'}`
  return `Uses ${name}, your default in Settings`
}

/** The chosen style that no longer exists or is not active, as a "Not available" option; null when it is offered. */
export function missingStyle(chosen: string | null, options: readonly OutputStyleOption[]): OutputStyleOption | null {
  if (chosen === null || options.some(option => option.name === chosen))
    return null
  return { name: chosen, label: chosen, description: '', source: 'user', available: false }
}

/** The trigger's name, tooltip and announcement: "Output style: {name}" plus " (automatic)" without a choice. */
export function styleTriggerName(label: string, automatic: boolean): string {
  return `Output style: ${label}${automatic ? ' (automatic)' : ''}`
}

/** The Customize link of the menu's footer: the Output styles tab, scoped to the chat's project when it has one. */
export function manageStylesHref(projectId: string | null): string {
  return projectId
    ? `/settings/customize?tab=output-styles&project=${encodeURIComponent(projectId)}`
    : '/settings/customize?tab=output-styles'
}

const HOOK_SOURCE_TEXT: Readonly<Record<string, string>> = {
  personal: 'Personal hook',
  project: 'Project hook',
  plugin: 'Plugin hook',
}

/** "{event} · {source}" of a `hook-blocked` refusal ("UserPromptSubmit · Project hook"); null without a record. */
export function refusalSourceLine(refusal: ComposerRefusalData): string | null {
  if (refusal.code !== 'hook-blocked' || refusal.event === null)
    return null
  const source = refusal.source === null ? null : HOOK_SOURCE_TEXT[refusal.source] ?? null
  return source ? `${refusal.event} · ${source}` : refusal.event
}

/** The refusal's first line (docs/UI.md 7.31, 15). */
export function refusalTitle(refusal: ComposerRefusalData): string {
  if (refusal.code === 'hook-blocked')
    return 'A hook blocked this message'
  return refusal.command
    ? `/${refusal.command} runs shell lines you haven't approved.`
    : 'This command runs shell lines you haven\'t approved.'
}
