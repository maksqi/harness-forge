// The home-folder import of personal definitions (Phase 12, ADR-055; `CustomizationService.importDefinitions`). Owner:
// W12.7. Pure helpers of one import item; the store (`store.ts`) applies the items in ONE pass of its write queue and the
// service (`index.ts`) drops every cached catalog and emits one `customization.changed {}` when anything changed.
//
// Per item (`CustomizationImportItem`, built by the import planner of `services/claude-import`):
// - `create`: a new personal definition; the kind and name must be free;
// - `overwrite`: replaces the content of the personal definition of that kind and name and keeps its `enabled` (a
//   command that gains `` !`cmd` `` spans is turned off unless the item enables it); created when there is none;
// - `rename`: created under `renameTo`, the `name:` line inserted or replaced with the shared `setDefinitionName` (every
//   other line kept byte for byte); the new name must be free.
// The content is parsed like a create (`parseDefinition`: builtin and reserved names, invalid content are errors); a
// command whose body holds `` !`cmd` `` spans arrives turned off unless `enable` (ADR-052: the user enabled it in the
// plan, apply needed fresh auth); the per-kind cap (`LIMITS.customizationsPerKindMax`) holds. A failed item never stops
// the others; its message names the kind and the name, never the content (≤ 300 characters).
import type { CustomizationKind, ParsedDefinition, ParseDefinitionResult } from '@harness-forge/shared'
import type { CustomizationImportItem } from './types.ts'
import { AGENT_NAME_PATTERN, COMMAND_NAME_PATTERN, CUSTOMIZATION_KINDS, parseDefinition, setDefinitionName } from '@harness-forge/shared'

/** Characters of one item message (`CustomizationImportResult`). */
export const IMPORT_MESSAGE_MAX_CHARS = 300
/** Characters of a name quoted in an item message. */
const QUOTED_NAME_MAX_CHARS = 64
/** Control characters of a name quoted in a message (an imported file is user data). */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu

/** One English sentence about an item that was not imported (the kind and the name, never the content). */
export function importFailure(kind: string, name: string | null, reason: string): string {
  const shown = typeof kind === 'string' && (CUSTOMIZATION_KINDS as readonly string[]).includes(kind) ? kind : 'definition'
  const quoted = name === null || name === '' ? '' : ` "${name.replace(CONTROL_CHARACTERS, '?').slice(0, QUOTED_NAME_MAX_CHARS)}"`
  return `The personal ${shown}${quoted} was not imported: ${reason}`.slice(0, IMPORT_MESSAGE_MAX_CHARS)
}

/** An item that fails before it reaches the table (`message` is the `importFailure` sentence). */
export class ImportItemError extends Error {}

/** True for a kind of the catalog. */
export function isCustomizationKind(kind: unknown): kind is CustomizationKind {
  return typeof kind === 'string' && (CUSTOMIZATION_KINDS as readonly string[]).includes(kind)
}

/** The name pattern of a kind (commands ≤ 32 characters, the other kinds ≤ 64). */
function namePattern(kind: CustomizationKind): RegExp {
  return kind === 'command' ? COMMAND_NAME_PATTERN : AGENT_NAME_PATTERN
}

/** What an item stores: the content (renamed), its usable parse and the name. */
export interface PreparedImportItem {
  readonly kind: CustomizationKind
  readonly content: string
  readonly definition: ParsedDefinition
  readonly result: ParseDefinitionResult
  readonly name: string
  readonly description: string
}

/**
 * Checks and parses one item (the rename applied). Throws `ImportItemError` (its message is the item's answer) for an
 * unknown kind, a missing or invalid `renameTo`, and content that cannot be used (the first `error` diagnostic).
 */
export function prepareImportItem(item: CustomizationImportItem): PreparedImportItem {
  if (typeof item !== 'object' || item === null || !isCustomizationKind(item.kind) || typeof item.content !== 'string')
    throw new ImportItemError(importFailure(String((item as { kind?: unknown } | null)?.kind ?? ''), null, 'it is not a definition.'))
  const kind = item.kind
  let content = item.content
  if (item.action === 'rename') {
    const renameTo = item.renameTo
    if (typeof renameTo !== 'string' || !namePattern(kind).test(renameTo))
      throw new ImportItemError(importFailure(kind, null, 'the new name is not valid.'))
    content = setDefinitionName(content, renameTo)
  }
  const result = parseDefinition(kind, content)
  const definition = result.definition
  if (definition === null || definition.kind !== kind || result.diagnostics.some(entry => entry.level === 'error')) {
    const reason = result.diagnostics.find(entry => entry.level === 'error')?.message ?? 'it is not a valid definition.'
    const name = definition?.fields.name ?? (item.action === 'rename' ? item.renameTo ?? null : null)
    throw new ImportItemError(importFailure(kind, name, reason))
  }
  const { name, description } = definition.fields
  if (item.action === 'rename' && name !== item.renameTo)
    throw new ImportItemError(importFailure(kind, name, 'the new name could not be set.'))
  return { kind, content, definition, result, name, description }
}

/**
 * The `enabled` flag an imported definition is stored with: a command with `` !`cmd` `` spans (`spans`) only when the
 * item enables it; an overwrite keeps the existing row's flag (and never turns a span command on without `enable`).
 */
export function importedEnabled(item: Pick<CustomizationImportItem, 'enable'>, spans: boolean, existing: boolean | null): boolean {
  const allowed = !spans || item.enable === true
  return existing === null ? allowed : existing && allowed
}
