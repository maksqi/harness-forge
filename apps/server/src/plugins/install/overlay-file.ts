// The marketplace entry overlay in an export (v1.8.1, CCR-1; ADR-054). A Claude Code plugin installed from a
// marketplace entry keeps the entry overlay in `plugins.origin`, not in its files, and the overlay is part of its
// whole-tree trust hash (`hf-claude-plugin/v1`: the files, then `O\0` + `canonicalJson(overlay)`). So the export
// (`export.ts`) writes it as one extra file at the plugin root, `.hf-entry-overlay.json` (`{ "format":
// "hf-entry-overlay/v1", "entry": { name, strict, version?, description?, overlay } }`), and a zip upload or URL archive
// of a Claude Code plugin that holds that file gets it back (`index.ts`, `materialize`):
// - the file is read strictly (`readEntryOverlayFile`): at most `CLAUDE_PLUGIN_LIMITS.manifestBytes`, UTF-8 JSON with
//   exactly these keys; the entry goes through the marketplace parser (`parseMarketplaceJson`, as the only entry of a
//   synthetic `marketplace.json`) and `entryOverlay`, and the result must be the file's entry exactly
//   (`canonicalJson`): only an overlay a marketplace could have stored is accepted; anything else is a 400
//   `validation_error`;
// - it is removed from the staged tree (it is never a plugin file), applied like the overlay of a marketplace entry (so
//   the inspection and the tree hash are the exported plugin's: an unchanged re-import keeps an existing pin) and kept
//   as the server-only origin `{ kind: 'overlay', overlay }` (the DTO origin stays null, the source stays the archive's);
// - it grants nothing by itself: its fields are `plugin.json` fields the archive could carry in its own `plugin.json`,
//   merged by `mergeEntryOverlay`, shown in the review and hashed; an install of a plugin that runs anything still needs
//   the trust approval (and fresh auth) of any install, and an update without `trust` keeps the old pin.
// Other sources (npm, folders, GitHub, marketplace entries, links) never read it: there it is an ordinary file. A Claude
// Code plugin whose tree holds a file or folder of that name at its root cannot be exported (its re-import would read it).
import type { HarnessError } from '@harness-forge/shared'
import type { ClaudeEntryOverlay } from '../types.ts'
import type { IssuePath } from './errors.ts'
import { canonicalJson, CLAUDE_PLUGIN_LIMITS, parseMarketplaceJson } from '@harness-forge/shared'
import { entryOverlay } from '../marketplaces/sources.ts'
import { invalid, quoteName } from './errors.ts'

/** The reserved file name at the root of an exported Claude Code plugin. */
export const OVERLAY_FILE_NAME = '.hf-entry-overlay.json'
/** The `format` the file must name. */
export const OVERLAY_FILE_FORMAT = 'hf-entry-overlay/v1'
/** At most the bytes of a `plugin.json` (the overlay holds `plugin.json` fields). */
export const OVERLAY_FILE_MAX_BYTES = CLAUDE_PLUGIN_LIMITS.manifestBytes
/** The inspection warning of an archive whose overlay file was applied. */
export const OVERLAY_FILE_NOTE = `The archive carries the marketplace entry fields of an exported plugin (${OVERLAY_FILE_NAME}): they are applied like plugin.json fields and are part of the plugin's hash.`

const FILE_KEYS: ReadonlySet<string> = new Set(['format', 'entry'])
const ENTRY_KEYS: ReadonlySet<string> = new Set(['name', 'strict', 'version', 'description', 'overlay'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

/** The bytes of the overlay file of `overlay` (indented JSON and a final newline). */
export function entryOverlayFile(overlay: ClaudeEntryOverlay): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({ format: OVERLAY_FILE_FORMAT, entry: overlay }, null, 2)}\n`)
}

/** Reads an archive's overlay file (see the module comment); throws `validation_error` at `issuePath` otherwise. */
export function readEntryOverlayFile(data: Uint8Array, issuePath: IssuePath = []): ClaudeEntryOverlay {
  const fail = (why: string): HarnessError => invalid(`The file ${quoteName(OVERLAY_FILE_NAME)} of the archive ${why}`, issuePath)
  if (data.byteLength > OVERLAY_FILE_MAX_BYTES)
    throw fail(`is larger than ${Math.round(OVERLAY_FILE_MAX_BYTES / 1024)} KB.`)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
  }
  catch {
    throw fail('is not valid JSON.')
  }
  if (!isRecord(value) || !onlyKeys(value, FILE_KEYS) || value.format !== OVERLAY_FILE_FORMAT || !isRecord(value.entry))
    throw fail(`is not a marketplace entry overlay (format ${OVERLAY_FILE_FORMAT}).`)
  const entry = value.entry
  const typed = typeof entry.name === 'string'
    && typeof entry.strict === 'boolean'
    && isRecord(entry.overlay)
    && (entry.version === undefined || typeof entry.version === 'string')
    && (entry.description === undefined || typeof entry.description === 'string')
  if (!onlyKeys(entry, ENTRY_KEYS) || !typed)
    throw fail('is not a marketplace entry overlay: the entry needs a name, strict and overlay.')
  // The marketplace parser decides what an entry may hold; the file must be exactly what it stores for this entry.
  const marketplace = JSON.stringify({
    name: 'exported-plugin',
    owner: { name: 'harness-forge' },
    plugins: [{ ...(entry.overlay as Record<string, unknown>), name: entry.name, strict: entry.strict, source: './plugin' }],
  })
  const parsed = parseMarketplaceJson(marketplace).marketplace
  const read = parsed !== null && parsed.plugins.length === 1 ? parsed.plugins[0] : undefined
  if (read === undefined)
    throw fail('names no valid marketplace entry.')
  const overlay = entryOverlay(read)
  if (canonicalJson(overlay) !== canonicalJson(entry))
    throw fail('holds fields a marketplace entry does not keep.')
  return overlay
}
