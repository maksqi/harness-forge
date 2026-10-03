import type { TestApp } from '../../testing/create-test-app.ts'
import type { TestChangeRowInput } from '../../testing/fake-checkpoints.ts'
import type { CheckpointStore } from './store.ts'
import type { CheckpointContext } from './types.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chats, projects, workspaceChanges } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { insertChangeRows } from '../../testing/fake-checkpoints.ts'
import { sha256Hex } from './disk.ts'
import { createChangeRowWriter } from './journal-service.ts'
import { EMPTY_PRUNE_RESULT, pruneCheckpoints, pruneFoundNothing } from './prune.ts'
import { CHECKPOINT_TEMP_MAX_AGE_MS, checkpointBlobPath, createCheckpointStore } from './store.ts'

const PROJECT_A = 'prj_PRUNEAAAAAAAAAAA'
const PROJECT_B = 'prj_PRUNEBBBBBBBBBBB'
const CHAT_A = '0199a8f0-0000-7000-8000-0000000000b1'
const CHAT_B = '0199a8f0-0000-7000-8000-0000000000b2'
const DAY = 86_400_000
const MIB = 1_048_576

let t: TestApp
let base: string
let store: CheckpointStore
/** The prune clock: well after every file's real mtime, so the orphan grace is decided by `utimes` below. */
let now: number

function context(): CheckpointContext {
  return { deps: t.deps, blobs: store, rows: createChangeRowWriter(t.deps, () => now), now: () => now }
}

/** Stores `content` as a blob with an mtime `ageMs` before `now`. */
async function blob(content: string, ageMs = 2 * CHECKPOINT_TEMP_MAX_AGE_MS): Promise<string> {
  const sha = await store.put(Buffer.from(content))
  const at = new Date(now - ageMs)
  await utimes(checkpointBlobPath(store.dir, sha), at, at)
  return sha
}

/** An `edit` row whose before-state is the stored blob of `content` (size overridable for the budget). */
function storedRow(chatId: string, projectId: string, content: string, createdAt: number, beforeSize = Buffer.byteLength(content)): TestChangeRowInput {
  return { chatId, projectId, kind: 'edit', tool: 'edit_file', path: `${content}.txt`, beforeState: 'stored', beforeSha: sha256Hex(content), beforeSize, beforeMode: 0o644, afterSha: sha256Hex(`${content}!`), afterSize: 1, createdAt }
}

async function states(): Promise<Record<string, string | null>> {
  const rows = await t.db.select().from(workspaceChanges).orderBy(workspaceChanges.id)
  return Object.fromEntries(rows.map(row => [`${row.projectId === PROJECT_A ? 'A' : 'B'}:${row.path}@${row.id}`, row.beforeState]))
}

beforeEach(async () => {
  t = await createTestApp({ start: false })
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  store = createCheckpointStore(join(base, 'checkpoints'))
  now = Date.now() + 10 * DAY
  await t.db.insert(projects).values([
    { id: PROJECT_A, name: 'A', path: join(base, 'a'), createdAt: 1, updatedAt: 1 },
    { id: PROJECT_B, name: 'B', path: join(base, 'b'), createdAt: 1, updatedAt: 1 },
  ])
  await t.db.insert(chats).values([{ id: CHAT_A, projectId: PROJECT_A }, { id: CHAT_B, projectId: PROJECT_B }])
})

afterEach(async () => {
  await t.close()
  await rm(base, { recursive: true, force: true })
})

describe('pruneCheckpoints', () => {
  it('an empty store and journal: nothing to do', async () => {
    expect(await pruneCheckpoints(context(), store, { now })).toEqual(EMPTY_PRUNE_RESULT)
    expect(pruneFoundNothing(EMPTY_PRUNE_RESULT)).toBe(true)
  })

  it('age: a stored before-state older than 30 days is evicted and its blob unlinked; younger ones stay', async () => {
    await blob('old')
    await blob('young')
    await insertChangeRows(t.db, [
      storedRow(CHAT_A, PROJECT_A, 'old', now - LIMITS.checkpointMaxAgeMs - 1),
      storedRow(CHAT_A, PROJECT_A, 'young', now - LIMITS.checkpointMaxAgeMs + DAY),
    ])
    const result = await pruneCheckpoints(context(), store, { now })
    expect(result).toEqual({ ...EMPTY_PRUNE_RESULT, evictedByAge: 1, rowsEvicted: 1, bytesFreed: 3 })
    expect(Object.values(await states())).toEqual(['evicted', 'stored'])
    expect(await store.has(sha256Hex('old'))).toBe(false)
    expect(await store.has(sha256Hex('young'))).toBe(true)
    // The evicted row keeps its sha (the history stays readable); a second prune has nothing left to do.
    const [row] = await t.db.select().from(workspaceChanges).where(eq(workspaceChanges.path, 'old.txt'))
    expect(row!.beforeSha).toBe(sha256Hex('old'))
    expect(pruneFoundNothing(await pruneCheckpoints(context(), store, { now }))).toBe(true)
  })

  it('age: a blob still referenced by a younger stored row (same content) is kept', async () => {
    await blob('shared')
    await insertChangeRows(t.db, [
      storedRow(CHAT_A, PROJECT_A, 'shared', now - LIMITS.checkpointMaxAgeMs - DAY),
      storedRow(CHAT_B, PROJECT_B, 'shared', now - DAY),
    ])
    const result = await pruneCheckpoints(context(), store, { now })
    expect(result).toEqual({ ...EMPTY_PRUNE_RESULT, rowsEvicted: 1 })
    expect(Object.values(await states())).toEqual(['evicted', 'stored'])
    expect(await store.has(sha256Hex('shared'))).toBe(true)
  })

  it('budget: a project over 512 MiB loses its least recently used blobs until it fits; another project keeps a shared blob', async () => {
    for (const name of ['a1', 'a2', 'a3', 'b1'])
      await blob(name)
    // Sizes come from the journal (`before_size`): three blobs of 200 MiB = 600 MiB in project A.
    await insertChangeRows(t.db, [
      storedRow(CHAT_A, PROJECT_A, 'a1', now - 5 * DAY, 200 * MIB),
      storedRow(CHAT_A, PROJECT_A, 'a2', now - 4 * DAY, 200 * MIB),
      storedRow(CHAT_A, PROJECT_A, 'a3', now - 3 * DAY, 200 * MIB),
      // a1 is used again later in A: it becomes the most recently used, a2 the oldest.
      storedRow(CHAT_A, PROJECT_A, 'a1', now - DAY, 200 * MIB),
      // Project B references a2 too and is far below its budget.
      storedRow(CHAT_B, PROJECT_B, 'a2', now - 2 * DAY, 200 * MIB),
      storedRow(CHAT_B, PROJECT_B, 'b1', now - 2 * DAY, 200 * MIB),
    ])
    const result = await pruneCheckpoints(context(), store, { now })
    // a2 leaves A (A drops to 400 MiB); its blob stays for B.
    expect(result).toEqual({ ...EMPTY_PRUNE_RESULT, rowsEvicted: 1 })
    const rows = await t.db.select().from(workspaceChanges).orderBy(workspaceChanges.id)
    expect(rows.map(row => [row.projectId === PROJECT_A ? 'A' : 'B', row.path, row.beforeState])).toEqual([
      ['A', 'a1.txt', 'stored'],
      ['A', 'a2.txt', 'evicted'],
      ['A', 'a3.txt', 'stored'],
      ['A', 'a1.txt', 'stored'],
      ['B', 'a2.txt', 'stored'],
      ['B', 'b1.txt', 'stored'],
    ])
    expect(await store.has(sha256Hex('a2'))).toBe(true)

    // Now A goes over again with a3 bigger: a3 (older than a1's last use) is evicted, and nothing else holds it.
    await insertChangeRows(t.db, [storedRow(CHAT_A, PROJECT_A, 'a3', now - 3 * DAY, 400 * MIB)])
    const second = await pruneCheckpoints(context(), store, { now })
    expect(second).toEqual({ ...EMPTY_PRUNE_RESULT, evictedByBudget: 1, rowsEvicted: 2, bytesFreed: 2 })
    expect(await store.has(sha256Hex('a3'))).toBe(false)
    expect(await store.has(sha256Hex('a1'))).toBe(true)
  })

  it('orphans: an old blob no stored row references is unlinked; a referenced one and a young orphan are kept', async () => {
    const referenced = await blob('referenced')
    const oldOrphan = await blob('old orphan')
    const youngOrphan = await blob('young orphan', CHECKPOINT_TEMP_MAX_AGE_MS - 60_000)
    // An evicted row does not keep its blob.
    const evictedOnly = await blob('evicted only')
    await insertChangeRows(t.db, [
      storedRow(CHAT_A, PROJECT_A, 'referenced', now - DAY),
      { ...storedRow(CHAT_A, PROJECT_A, 'evicted only', now - DAY), beforeState: 'evicted' },
    ])
    const result = await pruneCheckpoints(context(), store, { now })
    expect(result).toEqual({ ...EMPTY_PRUNE_RESULT, orphanBlobs: 2, bytesFreed: Buffer.byteLength('old orphan') + Buffer.byteLength('evicted only') })
    expect(await store.has(referenced)).toBe(true)
    expect(await store.has(youngOrphan)).toBe(true)
    expect(await store.has(oldOrphan)).toBe(false)
    expect(await store.has(evictedOnly)).toBe(false)
  })

  it('temp files: stale ones are removed, a young one (a write in progress elsewhere) stays; foreign files are ignored', async () => {
    const sha = sha256Hex('tmp')
    const shard = join(store.dir, sha.slice(0, 2))
    await mkdir(shard, { recursive: true })
    const stale = join(shard, `.${sha}.0000000000000000.tmp`)
    const fresh = join(shard, `.${sha}.1111111111111111.tmp`)
    await writeFile(stale, 'stale')
    await writeFile(fresh, 'fresh')
    await writeFile(join(shard, 'notes.txt'), 'foreign')
    const old = new Date(now - 2 * CHECKPOINT_TEMP_MAX_AGE_MS)
    await utimes(stale, old, old)
    const young = new Date(now - 60_000)
    await utimes(fresh, young, young)
    const result = await pruneCheckpoints(context(), store, { now })
    expect(result).toEqual({ ...EMPTY_PRUNE_RESULT, tempFiles: 1, bytesFreed: 5 })
    expect((await readdir(shard)).sort()).toEqual([`.${sha}.1111111111111111.tmp`, 'notes.txt'])
  })

  it('a deleted chat cascades its rows: its blobs become orphans and go once they are old', async () => {
    await blob('of a deleted chat')
    await insertChangeRows(t.db, [storedRow(CHAT_B, PROJECT_B, 'of a deleted chat', now - DAY)])
    await t.db.delete(chats).where(eq(chats.id, CHAT_B))
    expect(await t.db.select().from(workspaceChanges)).toEqual([])
    expect(await pruneCheckpoints(context(), store, { now })).toMatchObject({ orphanBlobs: 1 })
    expect(await store.summary()).toEqual({ bytes: 0, blobs: 0 })
  })

  it('holds the store gate exclusively (a writer between its blob and its row is never cut in half)', async () => {
    let release!: () => void
    const order: string[] = []
    const writer = store.withSharedGate(async () => {
      order.push('writer:blob')
      await new Promise<void>(resolve => (release = resolve))
      order.push('writer:row')
    })
    const prune = pruneCheckpoints(context(), store, { now }).then(() => order.push('prune'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(order).toEqual(['writer:blob'])
    release()
    await Promise.all([writer, prune])
    expect(order).toEqual(['writer:blob', 'writer:row', 'prune'])
  })

  it('an aborted signal stops it before any step', async () => {
    await blob('kept')
    const controller = new AbortController()
    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(pruneCheckpoints(context(), store, { now, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(await store.summary()).toMatchObject({ blobs: 1 })
  })
})
