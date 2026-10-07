// File reads of a Claude Code plugin folder (Phase 12, ADR-053; W12.1-T1). Every file the reader opens goes through the
// workspace guards with the plugin's realpath as the root: definition files through `readDefinitionFile` (no link on
// the path, a regular file, at most 64 KiB, the NUL probe, never a secret-looking name), JSON files (`plugin.json`,
// `hooks.json`, `.mcp.json`) through `resolveWorkspacePath` + `openWorkspaceFile` with the same `rel` equality and a byte
// cap checked before anything is parsed. Never throws; file contents are never logged.
import type { DefinitionRead, DefinitionReadFailure } from '../../services/customizations/discover.ts'
import { Buffer } from 'node:buffer'
import { DEFINITION_LIMITS, isHarnessError } from '@harness-forge/shared'
import { readDefinitionFile } from '../../services/customizations/discover.ts'
import { openWorkspaceFile, resolveWorkspacePath } from '../../workspace/paths.ts'
import { isSecretLookingPath } from '../../workspace/sensitive.ts'

/** Why a plugin file was not read. */
export type PluginFileFailure = DefinitionReadFailure

export type PluginTextRead
  = | { readonly ok: true, readonly text: string, readonly bytes: Buffer }
    | { readonly ok: false, readonly reason: PluginFileFailure }

/** Bytes checked for a NUL byte (a binary file). */
const BINARY_PROBE_BYTES = 8192

/** One English sentence for a failed read of `path` (never quotes contents). */
export function readFailureMessage(path: string, reason: PluginFileFailure, maxBytes: number = DEFINITION_LIMITS.contentBytes): string {
  switch (reason) {
    case 'missing':
      return `${path} does not exist.`
    case 'link':
      return `${path} is a symbolic link or goes through one; links are not read.`
    case 'secret':
      return `${path} looks like a secret file; it is not read.`
    case 'too-large':
      return `${path} is larger than ${Math.floor(maxBytes / 1024)} KiB.`
    case 'binary':
      return `${path} is binary.`
    default:
      return `${path} could not be read.`
  }
}

/**
 * A UTF-8 text file of the plugin folder `root` (a canonical realpath): no link anywhere on the path, a regular file of
 * at most `maxBytes`, no NUL byte in its first 8 KiB, never a secret-looking name. The BOM is kept (the parsers strip it).
 */
export async function readPluginTextFile(root: string, rel: string, maxBytes: number): Promise<PluginTextRead> {
  if (isSecretLookingPath(rel))
    return { ok: false, reason: 'secret' }
  let opened
  try {
    const resolved = await resolveWorkspacePath(root, rel)
    if (resolved.rel !== rel)
      return { ok: false, reason: 'link' }
    opened = await openWorkspaceFile(root, rel)
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'not_found')
      return { ok: false, reason: 'missing' }
    return { ok: false, reason: /link/i.test(error instanceof Error ? error.message : '') ? 'link' : 'failed' }
  }
  try {
    if (opened.resolved.rel !== rel)
      return { ok: false, reason: 'link' }
    if (opened.stats.size > maxBytes)
      return { ok: false, reason: 'too-large' }
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0)
        break
      length += bytesRead
    }
    if (length > maxBytes)
      return { ok: false, reason: 'too-large' }
    const bytes = Buffer.from(buffer.subarray(0, length))
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0))
      return { ok: false, reason: 'binary' }
    return { ok: true, text: new TextDecoder('utf-8').decode(bytes), bytes }
  }
  catch {
    return { ok: false, reason: 'failed' }
  }
  finally {
    await opened.handle.close().catch(() => {})
  }
}

/** A definition file of the plugin folder, read whole (at most 64 KiB) through `readDefinitionFile`. */
export async function readPluginDefinitionFile(root: string, rel: string): Promise<DefinitionRead> {
  return readDefinitionFile(root, rel, { maxBytes: DEFINITION_LIMITS.contentBytes })
}
