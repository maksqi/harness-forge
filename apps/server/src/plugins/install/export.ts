// Plugin export (`GET /plugins/:id/export`, PLUGINS.md 12 "Uninstall and export"): a zip of the plugin directory
// inside a top-level `<id>/` folder, installable again with `POST /plugins/install`. `node_modules` and `.git` are left
// out (build output lives in `data/cache`, outside the plugin directory, and settings, storage and secrets are never
// part of the directory), and so are local credential files a developer may keep next to the code (`.env`, `.env.*`,
// `.npmrc`), so a shared export never carries them (SEC-D5). Links are not followed and not exported; names the
// installer would refuse, more than 2000 entries or more than 100 MB make the export fail instead of producing an
// archive that cannot be installed again.
import type { Zippable } from 'fflate'
import type { InstallLimits } from './errors.ts'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { invalid, megabytes, quoteName, tooLarge } from './errors.ts'
import { SKIPPED_FOLDERS } from './folder.ts'
import { checkEntryPath } from './paths.ts'

/** Zip timestamps must lie in 1980-2099 (DOS dates). */
const ZIP_MIN_TIME = Date.UTC(1980, 0, 2)
const ZIP_MAX_TIME = Date.UTC(2099, 11, 31)
/** Unix regular file, mode 0644, in the upper 16 bits of the external attributes (host 3 = Unix). */
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0
const UNIX_HOST = 3

/** Local credential files never exported: `.env`, `.env.<anything>` and `.npmrc` (any case). */
export function isCredentialFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === '.env' || lower.startsWith('.env.') || lower === '.npmrc'
}

export interface PluginExport {
  fileName: string
  data: Uint8Array
}

/** `<id>-<version>.zip` with the version reduced to file-name-safe characters. */
export function exportFileName(id: string, version: string): string {
  const safeVersion = version.replace(/[^\w.+-]/g, '_').slice(0, 64)
  return `${id}-${safeVersion || '0.0.0'}.zip`
}

/** Zips `dir` (the realpath of the plugin directory) below `<id>/`. */
export async function exportPluginDirectory(id: string, version: string, dir: string, limits: Pick<InstallLimits, 'entries' | 'expandedBytes'>): Promise<PluginExport> {
  const files: Zippable = {}
  let entries = 0
  let bytes = 0
  const walk = async (current: string, relative: string): Promise<void> => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name)
      const shown = relative === '' ? name : `${relative}/${name}`
      const info = await lstat(path)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        continue
      if (info.isDirectory() && SKIPPED_FOLDERS.has(name))
        continue
      if (info.isFile() && isCredentialFile(name))
        continue
      const checked = checkEntryPath(shown)
      if (!checked.ok)
        throw invalid(`The plugin cannot be exported: ${checked.reason}`)
      if (++entries > limits.entries)
        throw invalid(`The plugin has more than ${limits.entries} files and folders, so it cannot be exported.`)
      if (info.isDirectory()) {
        await walk(path, shown)
        continue
      }
      bytes += info.size
      if (bytes > limits.expandedBytes)
        throw tooLarge(`The plugin is larger than ${megabytes(limits.expandedBytes)}, so it cannot be exported.`, limits.expandedBytes)
      const data = await readFile(path)
      const mtime = new Date(Math.min(ZIP_MAX_TIME, Math.max(ZIP_MIN_TIME, info.mtimeMs)))
      files[`${id}/${checked.path}`] = [new Uint8Array(data), { mtime, os: UNIX_HOST, attrs: FILE_ATTRIBUTES }]
    }
  }
  await walk(dir, '')
  if (!Object.keys(files).includes(`${id}/plugin.json`))
    throw invalid(`The plugin directory has no ${quoteName('plugin.json')}, so it cannot be exported.`)
  return { fileName: exportFileName(id, version), data: zipSync(files, { level: 6 }) }
}
