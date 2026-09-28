// File tree of a plugin directory (`GET /plugins/:id/files`, API.md 5.18): recursive, directories first then files,
// each sorted by path; skips `node_modules`, `.git` and the temporary files of atomic writes; symbolic links are not
// listed (they cannot be opened) and not followed; at most 2000 entries. A file is `editable` when the plugin is
// editable, its path is addressable by the files API, it is not hidden (no segment starting with ".") and it is UTF-8
// text of at most 1 MB.
import type { PluginFileEntry } from '@harness-forge/shared'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginFilePathSchema } from '@harness-forge/shared'
import { BLOCKED_SEGMENTS, isHiddenPath, looksLikeText, PLUGIN_FILE_MAX_BYTES, readPrefix, TEMP_FILE_PREFIX } from './paths.ts'

/** Maximum number of entries of a listing. */
export const FILE_TREE_MAX_ENTRIES = 2000
/** Deepest folder level listed (paths of the files API have at most 8 segments). */
const MAX_DEPTH = 8

function byPath(a: PluginFileEntry, b: PluginFileEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

async function isEditableText(absolute: string, size: number): Promise<boolean> {
  if (size > PLUGIN_FILE_MAX_BYTES)
    return false
  try {
    return looksLikeText(await readPrefix(absolute))
  }
  catch {
    return false
  }
}

/** Lists `root` (a realpath). `editable`: the plugin's files may be written (`PluginDetail.editable`). */
export async function listPluginFiles(root: string, editable: boolean): Promise<PluginFileEntry[]> {
  const dirs: PluginFileEntry[] = []
  const files: PluginFileEntry[] = []
  const count = (): number => dirs.length + files.length

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (count() >= FILE_TREE_MAX_ENTRIES)
        return
      if (BLOCKED_SEGMENTS.has(entry.name) || entry.name.startsWith(TEMP_FILE_PREFIX) || entry.isSymbolicLink())
        continue
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = join(dir, entry.name)
      const addressable = pluginFilePathSchema.safeParse(path).success
      if (entry.isDirectory()) {
        const info = await stat(absolute).catch(() => null)
        if (info === null)
          continue
        dirs.push({ path, type: 'dir', size: 0, mtime: Math.floor(info.mtimeMs), editable: false })
        if (addressable && depth + 1 < MAX_DEPTH)
          await walk(absolute, path, depth + 1)
      }
      else if (entry.isFile()) {
        const info = await stat(absolute).catch(() => null)
        if (info === null)
          continue
        files.push({
          path,
          type: 'file',
          size: info.size,
          mtime: Math.floor(info.mtimeMs),
          editable: editable && addressable && !isHiddenPath(path) && await isEditableText(absolute, info.size),
        })
      }
    }
  }

  await walk(root, '', 0)
  return [...dirs.sort(byPath), ...files.sort(byPath)]
}
