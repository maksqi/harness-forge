// Install-time facts of a staged Claude Code plugin that the host's inspection does not carry (Phase 12, ADR-053;
// open point 16). Owner: W12.2. `plugin.json` is parsed only by the shared `parseClaudePluginManifest` and the entry
// overlay applied only by `mergeEntryOverlay` (`util/claude-plugins.ts`).
import type { ClaudeMarketplaceEntry } from '@harness-forge/shared'
import type { ClaudeEntryOverlay } from '../types.ts'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LIMITS, mergeEntryOverlay, parseClaudePluginManifest } from '@harness-forge/shared'

/** The folder and file of a Claude Code plugin's manifest. */
export const CLAUDE_MANIFEST_FOLDER = '.claude-plugin'
export const CLAUDE_MANIFEST_FILE = 'plugin.json'

/** An overlay as the marketplace entry `mergeEntryOverlay` takes (the source does not matter there). */
function entryOf(overlay: ClaudeEntryOverlay): ClaudeMarketplaceEntry {
  return { ...overlay, source: { kind: 'unknown' }, supported: true, tags: [] }
}

/**
 * `defaultEnabled` of the staged Claude Code plugin in `dir` (its `.claude-plugin/plugin.json` with the marketplace
 * entry `overlay` applied): false installs the plugin turned off unless the request sets `enable`. True when the
 * manifest is missing or unreadable (the host reports those problems).
 */
export async function claudeDefaultEnabled(dir: string, overlay?: ClaudeEntryOverlay): Promise<boolean> {
  let manifest = null
  try {
    const folder = await lstat(join(dir, CLAUDE_MANIFEST_FOLDER))
    const file = join(dir, CLAUDE_MANIFEST_FOLDER, CLAUDE_MANIFEST_FILE)
    const info = folder.isDirectory() ? await lstat(file) : null
    if (info !== null && info.isFile() && info.size <= LIMITS.claudePluginManifestBytes)
      manifest = parseClaudePluginManifest(await readFile(file, 'utf8'), { maxBytes: LIMITS.claudePluginManifestBytes }).manifest
  }
  catch {
    manifest = null
  }
  if (overlay === undefined)
    return manifest?.defaultEnabled ?? true
  return mergeEntryOverlay(manifest, entryOf(overlay)).manifest?.defaultEnabled ?? true
}
