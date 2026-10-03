import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { CheckpointStore } from './store.ts'
import type { CheckpointService } from './types.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chats, projects, workspaceChanges } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { resolveWorkspacePath } from '../../workspace/paths.ts'
import { sha256Hex } from './disk.ts'
import { CHAT_DELETED_PRUNE_DELAY_MS, createCheckpointService, PRUNE_INTERVAL_MS } from './index.ts'
import { TOOL_EVENT_INTERVAL_MS } from './journal-service.ts'
import { CHECKPOINT_TEMP_MAX_AGE_MS, checkpointBlobPath, createCheckpointStore } from './store.ts'

const PROJECT = 'prj_SERVICEAAAAAAAAA'
const CHAT = '0199a8f0-0000-7000-8000-0000000000c1'
const OTHER_CHAT = '0199a8f0-0000-7000-8000-0000000000c2'

let t: TestApp
let events: RecordingEventBus
let base: string
let root: string
let store: CheckpointStore
let clock: number
const services: CheckpointService[] = []

function service(options: { background?: boolean, store?: CheckpointStore } = {}): CheckpointService {
  const created = createCheckpointService(t.deps, { now: () => clock, store: options.store ?? store, background: options.background ?? false })
  services.push(created)
  return created
}

/** An orphan blob (no row) old enough for prune at the current clock. */
async function orphan(content: string): Promise<string> {
  const sha = await store.put(Buffer.from(content))
  const at = new Date(clock - 2 * CHECKPOINT_TEMP_MAX_AGE_MS)
  await utimes(checkpointBlobPath(store.dir, sha), at, at)
  return sha
}

function pruneLogs() {
  return t.logs.records.filter(record => record.msg === 'checkpoints pruned')
}

beforeEach(async () => {
  events = createRecordingEventBus()
  t = await createTestApp({ start: false, overrides: { events } })
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
  store = createCheckpointStore(join(base, 'checkpoints'))
  clock = Date.now() + 86_400_000
  await t.db.insert(projects).values({ id: PROJECT, name: 'Service', path: root, createdAt: 1, updatedAt: 1 })
  await t.db.insert(chats).values([{ id: CHAT, projectId: PROJECT }, { id: OTHER_CHAT, projectId: PROJECT }])
})

afterEach(async () => {
  for (const created of services.splice(0))
    await created.stop()
  vi.useRealTimers()
  await t.close()
  await rm(base, { recursive: true, force: true })
})

describe('createCheckpointService: lifecycle', () => {
  it('start creates the store folder (0700) and runs one prune; the log has counts only', async () => {
    await mkdir(store.dir, { recursive: true })
    const sha = await orphan('orphan at boot')
    const checkpoints = service()
    await checkpoints.start()
    if (process.platform !== 'win32')
      expect((await stat(store.dir)).mode & 0o777).toBe(0o700)
    expect(await store.has(sha)).toBe(false)
    expect(pruneLogs()).toEqual([expect.objectContaining({ level: 'info', component: 'checkpoints', trigger: 'boot', orphanBlobs: 1, bytesFreed: 14, rowsEvicted: 0 })])
    expect(t.logs.text()).not.toContain(sha)
    // Background off: no timers, no subscription; a second start is idempotent.
    expect(events.subscriberCount()).toBe(0)
    await checkpoints.start()
    expect(pruneLogs()).toHaveLength(1)
  })

  it('a prune that found nothing logs nothing; a failed prune never fails the boot', async () => {
    await service().start()
    expect(pruneLogs()).toEqual([])
    const broken = createCheckpointStore(join(base, 'broken'))
    const failing = service({ store: { ...broken, withExclusiveGate: async () => {
      throw Object.assign(new Error(`EIO at ${root}`), { code: 'EIO' })
    } } })
    await expect(failing.start()).resolves.toBeUndefined()
    const warning = t.logs.records.find(record => record.msg === 'checkpoint prune failed')
    expect(warning).toMatchObject({ level: 'warn', trigger: 'boot', code: 'EIO' })
    expect(JSON.stringify(warning)).not.toContain(root)
  })

  it('background: prunes every 6 hours (chained); stop() cancels the timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const checkpoints = service({ background: true })
    await checkpoints.start()
    const first = await orphan('first')
    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS - 1)
    expect(await store.has(first)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(async () => expect(await store.has(first)).toBe(false))
    expect(pruneLogs().at(-1)).toMatchObject({ trigger: 'interval', orphanBlobs: 1 })
    // Chained: the next cycle comes 6 hours later.
    const second = await orphan('second')
    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS)
    await vi.waitFor(async () => expect(await store.has(second)).toBe(false))
    await checkpoints.stop()
    const third = await orphan('third')
    await vi.advanceTimersByTimeAsync(3 * PRUNE_INTERVAL_MS)
    expect(await store.has(third)).toBe(true)
    expect(events.subscriberCount()).toBe(0)
  })

  it('background: 60 s after the last chat.deleted of a burst (debounced)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const checkpoints = service({ background: true })
    await checkpoints.start()
    expect(events.subscriberCount()).toBe(1)
    const sha = await orphan('after a deletion')
    events.emit('chat.deleted', { id: CHAT })
    await vi.advanceTimersByTimeAsync(30_000)
    events.emit('chat.deleted', { id: OTHER_CHAT })
    await vi.advanceTimersByTimeAsync(CHAT_DELETED_PRUNE_DELAY_MS - 1)
    expect(await store.has(sha)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(async () => expect(await store.has(sha)).toBe(false))
    expect(pruneLogs().at(-1)).toMatchObject({ trigger: 'chat-deleted' })
    // Other events never schedule a prune; after stop() a deletion does nothing.
    const kept = await orphan('kept')
    events.emit('chat.created', { id: CHAT } as never)
    await checkpoints.stop()
    events.emit('chat.deleted', { id: CHAT })
    await vi.advanceTimersByTimeAsync(2 * CHAT_DELETED_PRUNE_DELAY_MS)
    expect(await store.has(kept)).toBe(true)
  })

  it('stop() waits for a running prune; the service can start again', async () => {
    const checkpoints = service()
    await checkpoints.start()
    let release!: () => void
    const holder = store.withSharedGate(() => new Promise<void>(resolve => (release = resolve)))
    const prune = checkpoints.prune({ now: clock })
    let stopped = false
    const stopping = checkpoints.stop().then(() => (stopped = true))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stopped).toBe(false)
    release()
    await holder
    await stopping
    expect(await prune).toMatchObject({ orphanBlobs: 0 })
    const sha = await orphan('after a restart')
    await checkpoints.start()
    expect(await store.has(sha)).toBe(false)
  })

  it('prune / purge / summary through the service', async () => {
    const checkpoints = service()
    await orphan('one')
    const fresh = await store.put(Buffer.from('fresh'))
    const young = new Date(clock - 60_000)
    await utimes(checkpointBlobPath(store.dir, fresh), young, young)
    expect(await checkpoints.summary()).toEqual({ bytes: 8, blobs: 2 })
    expect(await checkpoints.prune()).toMatchObject({ orphanBlobs: 1, bytesFreed: 3 })
    expect(await checkpoints.summary()).toEqual({ bytes: 5, blobs: 1 })
    expect(await checkpoints.purge()).toEqual({ bytes: 5, blobs: 1 })
    expect(await checkpoints.summary()).toEqual({ bytes: 0, blobs: 0 })
  })
})

describe('createCheckpointService: the default wiring', () => {
  it('deps.checkpoints stores blobs under DataPaths.checkpoints/<aa>/<sha256> and journals the edit', async () => {
    await writeFile(join(root, 'notes.txt'), 'Turn 1\n')
    const journal = t.deps.checkpoints.journal({ chatId: CHAT, messageId: 'msg_AAAAAAAAAAAAAAAA', projectId: PROJECT })
    const result = await journal.write({
      toolCallId: 'call_1',
      tool: 'write_file',
      root,
      resolved: await resolveWorkspacePath(root, 'notes.txt', { allowMissing: true }),
      produce: () => 'Turn 2\n',
      signal: new AbortController().signal,
    })
    expect(result.recorded).toBe(true)
    const sha = sha256Hex('Turn 1\n')
    expect(await readFile(join(t.env.paths.checkpoints, sha.slice(0, 2), sha), 'utf8')).toBe('Turn 1\n')
    expect(await t.deps.checkpoints.summary()).toEqual({ bytes: 7, blobs: 1 })
    expect(await t.db.select().from(workspaceChanges)).toEqual([expect.objectContaining({ kind: 'edit', path: 'notes.txt', beforeState: 'stored', beforeSha: sha })])
  })
})

describe('createCheckpointService: journals and tool events', () => {
  async function write(checkpoints: CheckpointService, chatId: string, path: string, content: string): Promise<void> {
    const journal = checkpoints.journal({ chatId, messageId: 'msg_AAAAAAAAAAAAAAAA', projectId: PROJECT })
    await journal.write({ toolCallId: `call_${path}`, tool: 'write_file', root, resolved: await resolveWorkspacePath(root, path, { allowMissing: true }), produce: () => content, signal: new AbortController().signal })
  }

  it('five edits within a second -> one workspace.changed with every path; another chat -> its own event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const checkpoints = service()
    for (const path of ['a.txt', 'b.txt', 'c.txt', 'a.txt', 'd/e.txt'])
      await write(checkpoints, CHAT, path, path)
    await write(checkpoints, OTHER_CHAT, 'z.txt', 'z')
    expect(events.ofType('workspace.changed')).toEqual([])
    await vi.advanceTimersByTimeAsync(TOOL_EVENT_INTERVAL_MS)
    expect(events.ofType('workspace.changed').map(event => event.data)).toEqual([
      { projectId: PROJECT, chatId: CHAT, batchId: null, source: 'tool', paths: ['a.txt', 'b.txt', 'c.txt', 'd/e.txt'] },
      { projectId: PROJECT, chatId: OTHER_CHAT, batchId: null, source: 'tool', paths: ['z.txt'] },
    ])
  })

  it('stop() drops the pending tool events', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const checkpoints = service()
    await write(checkpoints, CHAT, 'pending.txt', 'p')
    await checkpoints.stop()
    await vi.advanceTimersByTimeAsync(10 * TOOL_EVENT_INTERVAL_MS)
    expect(events.ofType('workspace.changed')).toEqual([])
  })
})
