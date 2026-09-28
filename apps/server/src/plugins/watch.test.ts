import type { FSWatcher, WatchOptions } from 'node:fs'
import type { WatchFunction } from './watch.ts'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '../logger.ts'
import { removeTempDirs, tempDir, waitFor } from './__fixtures__/harness.ts'
import { createPluginWatcher, WATCH_DEBOUNCE_MS } from './watch.ts'

afterEach(() => {
  vi.useRealTimers()
  removeTempDirs()
})

interface FakeWatch {
  watch: WatchFunction
  emit: (dir: string, filename: string | null) => void
  closed: string[]
  options: WatchOptions[]
  fail: (dir: string) => void
}

function fakeWatch(): FakeWatch {
  const listeners = new Map<string, { listener: (event: string, filename: string | null) => void, emitter: EventEmitter }>()
  const closed: string[] = []
  const options: WatchOptions[] = []
  return {
    closed,
    options,
    watch: (path, watchOptions, listener) => {
      options.push(watchOptions)
      const emitter = new EventEmitter()
      listeners.set(path, { listener: listener as (event: string, filename: string | null) => void, emitter })
      return Object.assign(emitter, {
        close: () => {
          closed.push(path)
          listeners.delete(path)
        },
      }) as unknown as FSWatcher
    },
    emit: (dir, filename) => listeners.get(dir)?.listener('change', filename),
    fail: dir => void listeners.get(dir)?.emitter.emit('error', new Error('watch failed')),
  }
}

describe('plugin watcher', () => {
  it('debounces events per plugin and ignores dependency folders', async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    const changes: string[] = []
    const watcher = createPluginWatcher({ logger: createMemoryLogger().logger, onChange: id => changes.push(id), watch: fake.watch })
    watcher.watch('a', '/plugins/a')
    watcher.watch('b', '/plugins/b')
    expect(fake.options[0]).toEqual({ recursive: true, persistent: false })
    fake.emit('/plugins/a', 'index.mjs')
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS - 1)
    fake.emit('/plugins/a', 'plugin.json')
    fake.emit('/plugins/b', 'node_modules/x/index.js')
    fake.emit('/plugins/b', '.git/HEAD')
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS - 1)
    expect(changes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(changes).toEqual(['a'])
    fake.emit('/plugins/b', null)
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS)
    expect(changes).toEqual(['a', 'b'])
    watcher.close()
    expect(fake.closed.sort()).toEqual(['/plugins/a', '/plugins/b'])
  })

  it('drops events while suppressed and restarts a watch on a new directory', async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    const changes: string[] = []
    const watcher = createPluginWatcher({ logger: createMemoryLogger().logger, onChange: id => changes.push(id), watch: fake.watch })
    watcher.watch('a', '/plugins/a')
    fake.emit('/plugins/a', 'index.mjs')
    const release = watcher.suppress('a')
    const nested = watcher.suppress('a')
    fake.emit('/plugins/a', 'index.mjs')
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS * 2)
    release()
    fake.emit('/plugins/a', 'index.mjs')
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS * 2)
    expect(changes).toEqual([])
    nested()
    nested()
    fake.emit('/plugins/a', 'index.mjs')
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS)
    expect(changes).toEqual(['a'])

    watcher.watch('a', '/linked/a')
    expect(fake.closed).toEqual(['/plugins/a'])
    expect(watcher.isWatching('a')).toBe(true)
    watcher.unwatch('a')
    expect(watcher.isWatching('a')).toBe(false)
  })

  it('stops a watcher that errors and never throws for unwatchable folders', () => {
    const fake = fakeWatch()
    const memory = createMemoryLogger()
    const watcher = createPluginWatcher({ logger: memory.logger, onChange: () => {}, watch: fake.watch })
    watcher.watch('a', '/plugins/a')
    fake.fail('/plugins/a')
    expect(watcher.isWatching('a')).toBe(false)
    const failing = createPluginWatcher({
      logger: memory.logger,
      onChange: () => {},
      watch: () => {
        throw new Error('ENOENT')
      },
    })
    expect(() => failing.watch('b', '/missing')).not.toThrow()
    expect(memory.records.map(record => record.msg)).toEqual(['plugin watcher stopped', 'cannot watch plugin directory'])
  })

  it('reports real file changes with fs.watch', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'index.mjs'), 'export default {}\n')
    const changes: string[] = []
    const watcher = createPluginWatcher({ logger: createMemoryLogger().logger, onChange: id => changes.push(id) })
    watcher.watch('real', dir)
    await new Promise(resolve => setTimeout(resolve, 100))
    writeFileSync(join(dir, 'src', 'index.mjs'), 'export default { changed: true }\n')
    await waitFor(() => changes.length > 0, 5000)
    expect(changes[0]).toBe('real')
    watcher.close()
  })
})
