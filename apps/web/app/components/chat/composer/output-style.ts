// Pure helpers of the composer's output style picker and refusal (Phase 11, ADR-048, ADR-051; docs/UI.md 7.31, 7.32,
// 11.8): the options of OutputStyleMenu from the catalog's style entries (built-ins first, then by source), what
// "Automatic" resolves to (the project's style, else the global default), the `/output-style <query>` lookup, and the
// refusal of a submit that a hook blocked or that runs unapproved shell lines (409 `hook-blocked` / `untrusted`). No
// Vue, no stores. Signatures frozen from Gate P11-0b (C39); W11.10 owns the bodies in P11-A (P11-0b: `refusalOf`
// complete, the rest plain first versions).
import type { CustomizationEntry, CustomizationSource, HookEvent } from '@harness-forge/shared'
import { BUILTIN_OUTPUT_STYLES, hookDataSchema, isBuiltinOutputStyle } from '@harness-forge/shared'
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
  const rest = entries
    .filter(entry => entry.kind === 'style' && entry.state === 'active' && !seen.has(entry.name) && !isBuiltinOutputStyle(entry.name))
    .map((entry): OutputStyleOption => ({
      name: entry.name,
      label: entry.label ?? entry.name,
      description: entry.description,
      source: entry.source,
      available: true,
    }))
    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.label.localeCompare(b.label))
  return [...options, ...rest]
}

/** What "Automatic" resolves to: the project's style, else the global default; null when neither is an option. */
export function automaticStyle(projectStyle: string | null, globalStyle: string, options: readonly OutputStyleOption[]): OutputStyleOption | null {
  const name = projectStyle?.trim() || globalStyle.trim()
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
  const found = options.find(option => option.name.toLowerCase() === lower || option.label.toLowerCase() === lower)
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
