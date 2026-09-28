// The staging area `data/plugins/.staging/` (PLUGINS.md 2, 12; ARCHITECTURE.md 5 "Staging recovery").
//
// Every download or extraction lands in `.staging/<uuid>` (a fresh directory, never reused) and is removed afterwards
// unless it was renamed into `plugins/<id>`. An update moves the installed version to `.staging/<id>.prev-<uuid>`
// (same filesystem, so both renames are atomic) until the new version loaded. At boot `recover()` moves an interrupted
// swap's `.prev` copy back when `plugins/<id>` is missing and deletes every other staging entry.
import type { Logger } from '../../logger.ts'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGIN_ID_PATTERN } from '@harness-forge/shared'
import { isInside } from '../loader.ts'

const PREV_SUFFIX = /^(.+)\.prev-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

export interface StagingArea {
  /** Creates `.staging/<uuid>` (mode 0700 until verified) and returns its path. */
  readonly create: () => Promise<string>
  /** Removes a directory of the staging area (recursively; links are removed, never followed). */
  readonly remove: (path: string) => Promise<void>
  /** A fresh `.staging/<id>.prev-<uuid>` path for the installed version of `id` during a swap. */
  readonly prevPath: (id: string) => string
  /** Boot recovery (see the module comment). */
  readonly recover: () => Promise<void>
}

export interface StagingOptions {
  /** `data/plugins`. */
  pluginsDir: string
  /** `data/plugins/.staging`. */
  stagingDir: string
  logger: Logger
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  }
  catch {
    return false
  }
}

/** The plugin id of a `<id>.prev-<uuid>` staging entry, else null. */
export function prevCopyId(name: string): string | null {
  const id = name.match(PREV_SUFFIX)?.[1]
  return id !== undefined && PLUGIN_ID_PATTERN.test(id) ? id : null
}

export function createStagingArea(options: StagingOptions): StagingArea {
  const { pluginsDir, stagingDir, logger } = options

  const remove = async (path: string): Promise<void> => {
    if (!isInside(stagingDir, path)) {
      logger.error('refusing to delete a path outside the plugin staging area', { path })
      return
    }
    await rm(path, { recursive: true, force: true })
  }

  /** Moves a `.prev` copy back to `plugins/<id>` when that folder is missing; true when it was restored. */
  const restore = async (id: string, path: string): Promise<boolean> => {
    const target = join(pluginsDir, id)
    if (await exists(target))
      return false
    try {
      if (!(await lstat(path)).isDirectory())
        return false
      await rename(path, target)
      logger.warn('restored a plugin from an interrupted update', { pluginId: id })
      return true
    }
    catch (error) {
      logger.error('cannot restore a plugin from an interrupted update', { pluginId: id, err: error })
      return false
    }
  }

  return {
    create: async () => {
      await mkdir(stagingDir, { recursive: true, mode: 0o755 })
      const path = join(stagingDir, randomUUID())
      await mkdir(path, { mode: 0o700 })
      return path
    },

    remove,

    prevPath: id => join(stagingDir, `${id}.prev-${randomUUID()}`),

    recover: async () => {
      let names: string[]
      try {
        names = await readdir(stagingDir)
      }
      catch {
        return
      }
      const restored = new Set<string>()
      // Sorted, so the outcome does not depend on the directory order.
      for (const name of names.sort()) {
        const path = join(stagingDir, name)
        const id = prevCopyId(name)
        if (id !== null && !restored.has(id) && await restore(id, path)) {
          restored.add(id)
          continue
        }
        try {
          await remove(path)
        }
        catch (error) {
          logger.warn('cannot remove a stale staging entry', { name, err: error })
        }
      }
    },
  }
}
