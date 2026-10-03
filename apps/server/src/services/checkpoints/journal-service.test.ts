import type { WorkspaceChangedData } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { CheckpointStore } from './store.ts'
import type { ChangeRowInput, CheckpointContext, CheckpointRowWriter, CheckpointWriteInput } from './types.ts'
import { Buffer } from 'node:buffer'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { LIMITS } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chats, messages, projects, workspaceChanges } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { resolveWorkspacePath } from '../../workspace/paths.ts'
import { sha256Hex } from './disk.ts'
import { beforeRowFields, createChangeRowWriter, createCheckpointJournal, createToolEventCoalescer, TOOL_EVENT_INTERVAL_MS } from './journal-service.ts'
import { createCheckpointStore } from './store.ts'

const POSIX = process.platform !== 'win32'
const CHAT = '0199a8f0-0000-7000-8000-0000000000a1'
const OTHER_CHAT = '0199a8f0-0000-7000-8000-0000000000a2'
const PROJECT = 'prj_JOURNALAAAAAAAAA'
const ASSISTANT = 'msg_ASSISTANTAAAAAAA'
const T0 = 1_760_000_000_000

let t: TestApp
let events: RecordingEventBus
let base: string
let root: string
let store: CheckpointStore

function context(rows: CheckpointRowWriter = createChangeRowWriter(t.deps, () => T0)): CheckpointContext {
  return { deps: t.deps, blobs: store, rows, now: () => T0 }
}

async function rowsOf(chatId = CHAT) {
  return t.db.select().from(workspaceChanges).where(eq(workspaceChanges.chatId, chatId)).orderBy(workspaceChanges.id)
}

async function writeInput(path: string, produce: CheckpointWriteInput['produce'], signal = new AbortController().signal): Promise<CheckpointWriteInput> {
  return { toolCallId: 'call_1', tool: 'write_file', root, resolved: await resolveWorkspacePath(root, path, { allowMissing: true }), produce, signal }
}

async function addMessage(id: string, seq: number, role: 'user' | 'assistant' = 'user', chatId = CHAT): Promise<void> {
  await t.db.insert(messages).values({ id, chatId, seq, role, parts: [] })
}

beforeEach(async () => {
  events = createRecordingEventBus()
  t = await createTestApp({ start: false, overrides: { events } })
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
  store = createCheckpointStore(join(base, 'checkpoints'))
  await t.db.insert(projects).values({ id: PROJECT, name: 'Journal', path: root, createdAt: 1, updatedAt: 1 })
  await t.db.insert(chats).values([{ id: CHAT, projectId: PROJECT }, { id: OTHER_CHAT, projectId: PROJECT }])
})

afterEach(async () => {
  vi.useRealTimers()
  await t.close()
  await rm(base, { recursive: true, force: true })
})

describe('createChangeRowWriter', () => {
  it('stamps message_seq with the chat watermark at insert time and created_at with the clock', async () => {
    let clock = T0
    const writer = createChangeRowWriter(t.deps, () => clock)
    const first = await writer.insert({ chatId: CHAT, projectId: PROJECT, kind: 'shell', tool: 'shell', command: 'ls' })
    expect(first).toMatchObject({ messageSeq: 0, createdAt: T0, kind: 'shell', path: null, batchId: null, messageId: null })
    await addMessage('msg_AAAAAAAAAAAAAAA1', 1)
    await addMessage('msg_AAAAAAAAAAAAAAA2', 2, 'assistant')
    // Another chat's messages never move this chat's watermark.
    await addMessage('msg_AAAAAAAAAAAAAAA9', 9, 'user', OTHER_CHAT)
    clock = T0 + 5
    const second = await writer.insert({ chatId: CHAT, projectId: PROJECT, kind: 'rewind', batchId: 'wcb_AAAAAAAAAAAAAAAA', path: 'a.txt', beforeState: 'missing', afterSha: sha256Hex('x'), afterSize: 1 })
    expect(second).toMatchObject({ messageSeq: 2, createdAt: T0 + 5, kind: 'rewind', batchId: 'wcb_AAAAAAAAAAAAAAAA', path: 'a.txt', beforeState: 'missing', afterSize: 1 })
    expect(second.id).toBeGreaterThan(first.id)
  })

  it('cuts a shell command at 1000 characters (never inside a surrogate pair)', async () => {
    const writer = createChangeRowWriter(t.deps, () => T0)
    const long = await writer.insert({ chatId: CHAT, projectId: PROJECT, kind: 'shell', command: 'x'.repeat(5000) })
    expect(long.command).toHaveLength(LIMITS.journalCommandMaxChars)
    const emoji = await writer.insert({ chatId: CHAT, projectId: PROJECT, kind: 'shell', command: `${'x'.repeat(999)}\u{1F600}tail` })
    expect(emoji.command).toBe('x'.repeat(999))
  })

  it('rejects a row of an unknown chat (real foreign keys)', async () => {
    const writer = createChangeRowWriter(t.deps, () => T0)
    await expect(writer.insert({ chatId: '0199a8f0-0000-7000-8000-0000000000ff', projectId: PROJECT, kind: 'untracked', tool: 'x' })).rejects.toThrow()
  })
})

describe('beforeRowFields', () => {
  it('maps every before-state', () => {
    const bytes = Buffer.from('abc')
    const present = { state: 'present' as const, bytes, sha: sha256Hex(bytes), size: 3, mode: 0o644 }
    expect(beforeRowFields({ state: 'missing' }, null)).toEqual({ beforeState: 'missing', beforeSha: null, beforeSize: null, beforeMode: null })
    expect(beforeRowFields({ state: 'too-large', size: 9, mode: 0o600 }, null)).toEqual({ beforeState: 'too-large', beforeSha: null, beforeSize: 9, beforeMode: 0o600 })
    expect(beforeRowFields(present, present.sha)).toEqual({ beforeState: 'stored', beforeSha: present.sha, beforeSize: 3, beforeMode: 0o644 })
    expect(beforeRowFields(present, null)).toEqual({ beforeState: 'evicted', beforeSha: present.sha, beforeSize: 3, beforeMode: 0o644 })
  })
})

describe('createCheckpointJournal', () => {
  const scope = { chatId: CHAT, messageId: ASSISTANT, projectId: PROJECT }

  it('write: stores the before blob, writes, and journals an edit row with both states', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    if (POSIX)
      await chmod(join(root, 'a.txt'), 0o640)
    await addMessage('msg_AAAAAAAAAAAAAAA1', 1)
    const journal = createCheckpointJournal(context(), scope)
    expect(journal.scope).toEqual(scope)
    const result = await journal.write(await writeInput('a.txt', before => `${before.state === 'present' ? before.bytes.toString('utf8') : ''}new\n`))
    expect(result).toMatchObject({ recorded: true, before: { state: 'present', size: 4 }, written: { rel: 'a.txt', created: false } })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old\nnew\n')
    const [row] = await rowsOf()
    expect(row).toMatchObject({
      chatId: CHAT,
      projectId: PROJECT,
      messageSeq: 1,
      messageId: ASSISTANT,
      toolCallId: 'call_1',
      batchId: null,
      kind: 'edit',
      tool: 'write_file',
      path: 'a.txt',
      command: null,
      beforeState: 'stored',
      beforeSha: sha256Hex('old\n'),
      beforeSize: 4,
      afterSha: sha256Hex('old\nnew\n'),
      afterSize: 8,
      createdAt: T0,
    })
    if (POSIX)
      expect(row!.beforeMode).toBe(0o640)
    expect((await store.read(sha256Hex('old\n')))!.toString('utf8')).toBe('old\n')
  })

  it('write: a created file is journaled as missing (no blob); bytes are written as given', async () => {
    const journal = createCheckpointJournal(context(), scope)
    const bytes = new Uint8Array([0, 1, 2, 255])
    const result = await journal.write(await writeInput('bin/new.dat', () => bytes))
    expect(result).toMatchObject({ recorded: true, before: { state: 'missing' }, written: { rel: 'bin/new.dat', created: true, bytes: 4 } })
    expect([...await readFile(join(root, 'bin/new.dat'))]).toEqual([0, 1, 2, 255])
    expect(await rowsOf()).toEqual([expect.objectContaining({ kind: 'edit', path: 'bin/new.dat', beforeState: 'missing', beforeSha: null, beforeSize: null, beforeMode: null, afterSha: sha256Hex(bytes), afterSize: 4 })])
    expect(await store.summary()).toEqual({ bytes: 0, blobs: 0 })
  })

  it('write: a produce error writes, stores and journals nothing', async () => {
    await writeFile(join(root, 'a.txt'), 'keep\n')
    const journal = createCheckpointJournal(context(), scope)
    await expect(journal.write(await writeInput('a.txt', () => {
      throw new Error('edit failed')
    }))).rejects.toThrow('edit failed')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('keep\n')
    expect(await rowsOf()).toEqual([])
    expect(await store.summary()).toEqual({ bytes: 0, blobs: 0 })
  })

  it('write: a failed row insert keeps the write and its result (recorded false, a warning without the path)', async () => {
    await writeFile(join(root, 'secret-name.txt'), 'before\n')
    const failing: CheckpointRowWriter = { insert: async () => {
      throw new Error('database is locked')
    } }
    const journal = createCheckpointJournal(context(failing), scope)
    const result = await journal.write(await writeInput('secret-name.txt', () => 'after\n'))
    expect(result).toMatchObject({ recorded: false, written: { rel: 'secret-name.txt' } })
    expect(await readFile(join(root, 'secret-name.txt'), 'utf8')).toBe('after\n')
    const warning = t.logs.records.find(record => record.msg === 'checkpoint not recorded')
    expect(warning).toMatchObject({ level: 'warn', kind: 'edit', chatId: CHAT, toolCallId: 'call_1', code: 'Error' })
    expect(t.logs.records.filter(record => record.level !== 'debug').map(record => JSON.stringify(record)).join('\n')).not.toMatch(/secret-name|before|after/)
  })

  it('write: a blob that cannot be stored journals the edit as evicted (listed, not restorable)', async () => {
    await writeFile(join(root, 'a.txt'), 'before\n')
    const brokenStore: CheckpointStore = { ...store, put: async () => {
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    } }
    const journal = createCheckpointJournal({ ...context(), blobs: brokenStore }, scope)
    const result = await journal.write(await writeInput('a.txt', () => 'after\n'))
    expect(result.recorded).toBe(false)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after\n')
    expect(await rowsOf()).toEqual([expect.objectContaining({ beforeState: 'evicted', beforeSha: sha256Hex('before\n'), afterSha: sha256Hex('after\n') })])
    expect(t.logs.records.find(record => record.msg === 'checkpoint not recorded')).toMatchObject({ code: 'ENOSPC' })
  })

  it('write: a refused target rejects and journals nothing', async () => {
    await mkdir(join(root, 'dir'))
    const journal = createCheckpointJournal(context(), scope)
    await expect(journal.write(await writeInput('dir', () => 'x'))).rejects.toMatchObject({ code: 'validation_error' })
    expect(await rowsOf()).toEqual([])
  })

  it.skipIf(!POSIX || process.getuid?.() === 0)('write: a failed disk write rejects with no row; its stored blob is an orphan for prune', async () => {
    await mkdir(join(root, 'ro'))
    await writeFile(join(root, 'ro', 'a.txt'), 'before\n')
    await chmod(join(root, 'ro'), 0o500)
    try {
      const journal = createCheckpointJournal(context(), scope)
      await expect(journal.write(await writeInput('ro/a.txt', () => 'after\n'))).rejects.toMatchObject({ code: 'EACCES' })
      expect(await readFile(join(root, 'ro', 'a.txt'), 'utf8')).toBe('before\n')
      expect(await rowsOf()).toEqual([])
      expect(await store.has(sha256Hex('before\n'))).toBe(true)
    }
    finally {
      await chmod(join(root, 'ro'), 0o700)
    }
  })

  it('write: the abort check runs after produce and before anything is stored or written', async () => {
    await writeFile(join(root, 'a.txt'), 'keep\n')
    const controller = new AbortController()
    const journal = createCheckpointJournal(context(), scope)
    await expect(journal.write(await writeInput('a.txt', () => {
      controller.abort(new Error('stopped'))
      return 'never'
    }, controller.signal))).rejects.toThrow('stopped')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('keep\n')
    expect(await rowsOf()).toEqual([])
    expect(await store.summary()).toEqual({ bytes: 0, blobs: 0 })
  })

  it('write: the store gate is held shared from the blob write until the row insert', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const real = createChangeRowWriter(t.deps, () => T0)
    let releaseInsert!: () => void
    let inserting!: () => void
    const insertStarted = new Promise<void>(resolve => (inserting = resolve))
    const slow: CheckpointRowWriter = {
      insert: async (row: ChangeRowInput) => {
        inserting()
        await new Promise<void>(resolve => (releaseInsert = resolve))
        return real.insert(row)
      },
    }
    const journal = createCheckpointJournal(context(slow), scope)
    const write = journal.write(await writeInput('a.txt', () => 'new\n'))
    await insertStarted
    const order: string[] = []
    const exclusive = store.withExclusiveGate(async () => {
      order.push('prune')
      // The blob exists and its row is in: prune never sees a blob without its row.
      expect((await rowsOf()).map(row => row.beforeState)).toEqual(['stored'])
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(order).toEqual([])
    order.push('insert')
    releaseInsert()
    await write
    await exclusive
    expect(order).toEqual(['insert', 'prune'])
  })

  it('recordShell / recordUntracked insert their rows and never reject', async () => {
    await addMessage('msg_AAAAAAAAAAAAAAA1', 1)
    const journal = createCheckpointJournal(context(), scope)
    await journal.recordShell({ toolCallId: 'call_2', command: `mkdir -p a && cd a ${'x'.repeat(2000)}` })
    await journal.recordUntracked({ toolCallId: 'call_3', tool: 'plugin_writer' })
    const [shell, untracked] = await rowsOf()
    expect(shell).toMatchObject({ kind: 'shell', tool: 'shell', path: null, messageId: ASSISTANT, toolCallId: 'call_2', messageSeq: 1, beforeState: null, afterSha: null })
    expect(shell!.command).toHaveLength(LIMITS.journalCommandMaxChars)
    expect(untracked).toMatchObject({ kind: 'untracked', tool: 'plugin_writer', path: null, command: null, messageId: ASSISTANT, toolCallId: 'call_3' })

    const failing = createCheckpointJournal(context({ insert: async () => {
      throw new Error('gone')
    } }), scope)
    await expect(failing.recordShell({ toolCallId: 'call_4', command: 'rm -rf build' })).resolves.toBeUndefined()
    await expect(failing.recordUntracked({ toolCallId: 'call_5', tool: 'x' })).resolves.toBeUndefined()
    const warnings = t.logs.records.filter(record => record.msg === 'checkpoint not recorded')
    expect(warnings.map(record => record.kind)).toEqual(['shell', 'untracked'])
    expect(JSON.stringify(warnings)).not.toContain('rm -rf')
  })

  it('a continuation keeps the assistant message id; the watermark follows the messages', async () => {
    await addMessage('msg_AAAAAAAAAAAAAAA1', 1)
    await createCheckpointJournal(context(), scope).recordShell({ toolCallId: 'call_1', command: 'ls' })
    // The approval continuation of the same assistant message builds a new journal with the same scope.
    await addMessage('msg_AAAAAAAAAAAAAAA2', 2, 'assistant')
    await createCheckpointJournal(context(), scope).write(await writeInput('c.txt', () => 'c'))
    const rows = await rowsOf()
    expect(rows.map(row => row.messageId)).toEqual([ASSISTANT, ASSISTANT])
    expect(rows.map(row => row.messageSeq)).toEqual([1, 2])
  })

  it('a journal outside a run (messageId null) records null', async () => {
    const journal = createCheckpointJournal(context(), { chatId: CHAT, messageId: null, projectId: PROJECT })
    await journal.write(await writeInput('n.txt', () => 'n'))
    expect((await rowsOf())[0]).toMatchObject({ messageId: null })
  })

  it('rows chain: parallel writes of one file serialize under its lock', async () => {
    await writeFile(join(root, 'count.txt'), '0')
    const journal = createCheckpointJournal(context(), scope)
    const increment = async () => journal.write(await writeInput('count.txt', before => String(Number(before.state === 'present' ? before.bytes.toString('utf8') : '0') + 1)))
    await Promise.all([increment(), increment(), increment()])
    expect(await readFile(join(root, 'count.txt'), 'utf8')).toBe('3')
    const rows = await rowsOf()
    expect(rows.map(row => [row.beforeSha, row.afterSha])).toEqual([
      [sha256Hex('0'), sha256Hex('1')],
      [sha256Hex('1'), sha256Hex('2')],
      [sha256Hex('2'), sha256Hex('3')],
    ])
    for (const value of ['0', '1', '2'])
      expect((await store.read(sha256Hex(value)))!.toString('utf8')).toBe(value)
    expect(await store.has(sha256Hex('3'))).toBe(false)
  })
})

describe('tool events', () => {
  function collect(): { emitted: WorkspaceChangedData[], emit: (data: WorkspaceChangedData) => void } {
    const emitted: WorkspaceChangedData[] = []
    return { emitted, emit: data => emitted.push(data) }
  }

  it('five edits within a second -> one event with every path; another chat -> its own event', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { emitted, emit } = collect()
    const coalescer = createToolEventCoalescer(emit)
    for (const path of ['a.txt', 'b.txt', 'a.txt', 'c/d.txt', 'e.txt'])
      coalescer.add(PROJECT, CHAT, path)
    vi.advanceTimersByTime(500)
    coalescer.add(PROJECT, OTHER_CHAT, 'z.txt')
    vi.advanceTimersByTime(TOOL_EVENT_INTERVAL_MS - 501)
    expect(emitted).toEqual([])
    vi.advanceTimersByTime(1)
    expect(emitted).toEqual([{ projectId: PROJECT, chatId: CHAT, batchId: null, source: 'tool', paths: ['a.txt', 'b.txt', 'c/d.txt', 'e.txt'] }])
    vi.advanceTimersByTime(500)
    expect(emitted).toEqual([
      expect.objectContaining({ chatId: CHAT }),
      { projectId: PROJECT, chatId: OTHER_CHAT, batchId: null, source: 'tool', paths: ['z.txt'] },
    ])
    // The next edit starts a new window: at most one event per second per chat.
    coalescer.add(PROJECT, CHAT, 'f.txt')
    vi.advanceTimersByTime(999)
    expect(emitted).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(emitted[2]).toMatchObject({ chatId: CHAT, paths: ['f.txt'] })
    expect(coalescer.pending()).toBe(0)
  })

  it('caps the paths of one event; stop() drops what is pending and ignores later edits', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { emitted, emit } = collect()
    const coalescer = createToolEventCoalescer(emit)
    for (let index = 0; index < 250; index++)
      coalescer.add(PROJECT, CHAT, `f${index}.txt`)
    vi.advanceTimersByTime(TOOL_EVENT_INTERVAL_MS)
    expect(emitted[0]!.paths).toHaveLength(LIMITS.workspaceEventPathsMax)
    expect(emitted[0]!.paths[0]).toBe('f0.txt')
    coalescer.add(PROJECT, CHAT, 'pending.txt')
    coalescer.stop()
    coalescer.add(PROJECT, CHAT, 'late.txt')
    vi.advanceTimersByTime(10 * TOOL_EVENT_INTERVAL_MS)
    expect(emitted).toHaveLength(1)
    expect(coalescer.pending()).toBe(0)
  })

  it('journal writes feed the coalescer (also when recording failed), shell rows do not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { emitted, emit } = collect()
    const toolEvents = createToolEventCoalescer(emit)
    const journal = createCheckpointJournal(context(), { chatId: CHAT, messageId: ASSISTANT, projectId: PROJECT }, { toolEvents })
    for (const path of ['one.txt', 'two.txt', 'one.txt'])
      await journal.write(await writeInput(path, () => path))
    await journal.recordShell({ toolCallId: 'call_9', command: 'touch three.txt' })
    const failing = createCheckpointJournal(context({ insert: async () => {
      throw new Error('x')
    } }), { chatId: CHAT, messageId: ASSISTANT, projectId: PROJECT }, { toolEvents })
    await failing.write(await writeInput('four.txt', () => '4'))
    await expect(failing.write(await writeInput('five.txt', () => {
      throw new Error('no')
    }))).rejects.toThrow('no')
    vi.advanceTimersByTime(TOOL_EVENT_INTERVAL_MS)
    expect(emitted).toEqual([{ projectId: PROJECT, chatId: CHAT, batchId: null, source: 'tool', paths: ['one.txt', 'two.txt', 'four.txt'] }])
  })
})
