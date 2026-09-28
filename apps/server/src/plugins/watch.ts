import type { Buffer } from 'node:buffer'
// Hot reload file watching (PLUGINS.md 11 "Hot reload"). Owner: W1.3 (W1.3-T8).
//
// One recursive `fs.watch` per watched plugin directory (linked folders always; plugins in `data/plugins/*` only with
// `HF_PLUGIN_WATCH=1`, decided by the host). Events are debounced per plugin (300 ms) and reported to the host, which
// compares the content fingerprint and reloads only on a real change. `suppress()` drops events while the editor API
// writes files (`PluginHost.withoutWatch`). Watchers never keep the process alive.
import type { FSWatcher, WatchOptions } from 'node:fs'
import type { Logger } from '../logger.ts'
import { watch as fsWatch } from 'node:fs'

export const WATCH_DEBOUNCE_MS = 300

/** Path segments whose changes never matter (dependencies, VCS metadata). */
const IGNORED_SEGMENTS = new Set(['node_modules', '.git'])

export type WatchFunction = (path: string, options: WatchOptions, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher

export interface PluginWatcherOptions {
  /** Called (debounced) when a watched plugin directory changed. */
  readonly onChange: (pluginId: string) => void
  readonly logger: Logger
  readonly debounceMs?: number
  /** `fs.watch` (tests inject a fake). */
  readonly watch?: WatchFunction
}

export interface PluginWatcher {
  /** Starts (or moves) the watch of a plugin directory. Failures are logged, never thrown. */
  readonly watch: (pluginId: string, dir: string) => void
  readonly unwatch: (pluginId: string) => void
  readonly isWatching: (pluginId: string) => boolean
  /** Ignores events of the plugin until the returned release function is called (nesting is counted). */
  readonly suppress: (pluginId: string) => () => void
  readonly close: () => void
}

interface Watched {
  dir: string
  watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | undefined
}

function isIgnored(filename: string | Buffer | null): boolean {
  if (filename === null)
    return false
  const name = typeof filename === 'string' ? filename : filename.toString('utf8')
  return name.split(/[\\/]/).some(segment => IGNORED_SEGMENTS.has(segment))
}

export function createPluginWatcher(options: PluginWatcherOptions): PluginWatcher {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS
  const watchImpl: WatchFunction = options.watch ?? ((path, watchOptions, listener) => fsWatch(path, watchOptions, listener))
  const watched = new Map<string, Watched>()
  const suppressed = new Map<string, number>()
  let closed = false

  function stop(pluginId: string): void {
    const current = watched.get(pluginId)
    if (!current)
      return
    watched.delete(pluginId)
    if (current.timer !== undefined)
      clearTimeout(current.timer)
    try {
      current.watcher.close()
    }
    catch {}
  }

  function schedule(pluginId: string, entry: Watched): void {
    if ((suppressed.get(pluginId) ?? 0) > 0)
      return
    if (entry.timer !== undefined)
      clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (closed || watched.get(pluginId) !== entry || (suppressed.get(pluginId) ?? 0) > 0)
        return
      try {
        options.onChange(pluginId)
      }
      catch (error) {
        options.logger.error('plugin watch handler failed', { pluginId, err: error })
      }
    }, debounceMs)
    entry.timer.unref?.()
  }

  return {
    watch: (pluginId, dir) => {
      if (closed)
        return
      const current = watched.get(pluginId)
      if (current?.dir === dir)
        return
      stop(pluginId)
      try {
        const entry: Watched = { dir, watcher: undefined as unknown as FSWatcher, timer: undefined }
        entry.watcher = watchImpl(dir, { recursive: true, persistent: false }, (_event, filename) => {
          if (!isIgnored(filename))
            schedule(pluginId, entry)
        })
        entry.watcher.on('error', (error) => {
          options.logger.warn('plugin watcher stopped', { pluginId, dir, err: error })
          if (watched.get(pluginId) === entry)
            stop(pluginId)
        })
        watched.set(pluginId, entry)
      }
      catch (error) {
        options.logger.warn('cannot watch plugin directory', { pluginId, dir, err: error })
      }
    },
    unwatch: stop,
    isWatching: pluginId => watched.has(pluginId),
    suppress: (pluginId) => {
      suppressed.set(pluginId, (suppressed.get(pluginId) ?? 0) + 1)
      const current = watched.get(pluginId)
      if (current?.timer !== undefined) {
        clearTimeout(current.timer)
        current.timer = undefined
      }
      let released = false
      return () => {
        if (released)
          return
        released = true
        const count = (suppressed.get(pluginId) ?? 1) - 1
        if (count <= 0)
          suppressed.delete(pluginId)
        else
          suppressed.set(pluginId, count)
      }
    },
    close: () => {
      closed = true
      for (const pluginId of [...watched.keys()])
        stop(pluginId)
      suppressed.clear()
    },
  }
}
