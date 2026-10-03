import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { CheckpointStore } from '../services/checkpoints/store.ts'
import type { CheckpointJournal, CheckpointRowWriter } from '../services/checkpoints/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEditFileTool } from '../builtin-plugins/core-workspace/edit-file.ts'
import { promiseTool } from '../builtin-plugins/core-workspace/test-helpers.ts'
import { createWriteFileTool } from '../builtin-plugins/core-workspace/write-file.ts'
import { chats, projects, workspaceChanges } from '../db/schema.ts'
import { sha256Hex } from '../services/checkpoints/disk.ts'
import { createChangeRowWriter, createCheckpointJournal } from '../services/checkpoints/journal-service.ts'
import { createCheckpointStore } from '../services/checkpoints/store.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { heldFileLocks } from './file-lock.ts'
import { journaledWrite } from './journal.ts'
import { bindRunScope } from './run-scope.ts'

const PROJECT = 'prj_JOURNALWRITEAAAA'
const CHAT = '0199a8f0-0000-7000-8000-0000000000d1'
const ASSISTANT = 'msg_ASSISTANTAAAAAAA'

let t: TestApp
let base: string
let root: string
let store: CheckpointStore

function journal(rows: CheckpointRowWriter = createChangeRowWriter(t.deps, Date.now)): CheckpointJournal {
  return createCheckpointJournal({ deps: t.deps, blobs: store, rows, now: Date.now }, { chatId: CHAT, messageId: ASSISTANT, projectId: PROJECT })
}

/** The context of one tool call; with `scope` the run scope of a chat run is bound to it (as `wrapToolExecute` does). */
function call(toolCallId: string, options: { journal?: CheckpointJournal | null, projectId?: string, signal?: AbortSignal } = {}): ToolCallContext {
  const c: ToolCallContext = {
    chatId: CHAT,
    modelRef: 'mock:workspace',
    toolCallId,
    messages: [],
    signal: options.signal ?? new AbortController().signal,
    workspace: { projectId: PROJECT, name: 'Journal', root },
  }
  if (options.journal !== undefined) {
    bindRunScope(c, {
      chatId: CHAT,
      messageId: ASSISTANT,
      projectId: options.projectId ?? PROJECT,
      toolCallId,
      journal: options.journal,
      shellRules: { projectId: PROJECT, prefixes: [] },
      shellCwd: { current: '.' },
    })
  }
  return c
}

async function rows() {
  return t.db.select().from(workspaceChanges).where(eq(workspaceChanges.chatId, CHAT)).orderBy(workspaceChanges.id)
}

async function content(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8')
}

beforeEach(async () => {
  t = await createTestApp({ start: false })
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
  store = createCheckpointStore(join(base, 'checkpoints'))
  await t.db.insert(projects).values({ id: PROJECT, name: 'Journal', path: root, createdAt: 1, updatedAt: 1 })
  await t.db.insert(chats).values({ id: CHAT, projectId: PROJECT })
})

afterEach(async () => {
  await t.close()
  await rm(base, { recursive: true, force: true })
})

describe('journaledWrite', () => {
  it('records through the run scope: the row carries the scope, the tool call and the tool; produce sees the resolved path', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n')
    const seen: string[] = []
    const result = await journaledWrite(call('call_7', { journal: journal() }), root, { tool: 'edit_file', path: './sub/../a.txt' }, (before, resolved) => {
      seen.push(`${before.state}:${resolved.rel}`)
      return 'new\n'
    })
    expect(seen).toEqual(['present:a.txt'])
    expect(result).toMatchObject({ recorded: true, written: { rel: 'a.txt', created: false } })
    expect(await rows()).toEqual([expect.objectContaining({ kind: 'edit', tool: 'edit_file', toolCallId: 'call_7', messageId: ASSISTANT, path: 'a.txt', beforeState: 'stored', beforeSha: sha256Hex('old\n'), afterSha: sha256Hex('new\n') })])
    expect(heldFileLocks()).toBe(0)
  })

  it('without a run scope (or a scope without a journal, or of another project) it writes without recording', async () => {
    await journaledWrite(call('call_1'), root, { tool: 'write_file', path: 'none.txt' }, () => 'a')
    await journaledWrite(call('call_2', { journal: null }), root, { tool: 'write_file', path: 'null.txt' }, () => 'b')
    const other = await journaledWrite(call('call_3', { journal: journal(), projectId: 'prj_OTHERAAAAAAAAAAA' }), root, { tool: 'write_file', path: 'other.txt' }, () => 'c')
    // The journal's own scope decides: a journal of another project never records into this folder's history.
    const foreign = createCheckpointJournal({ deps: t.deps, blobs: store, rows: createChangeRowWriter(t.deps, Date.now), now: Date.now }, { chatId: CHAT, messageId: ASSISTANT, projectId: 'prj_OTHERAAAAAAAAAAA' })
    await journaledWrite(call('call_4', { journal: foreign }), root, { tool: 'write_file', path: 'foreign.txt' }, () => 'd')
    expect(other.recorded).toBe(false)
    expect([await content('none.txt'), await content('null.txt'), await content('other.txt'), await content('foreign.txt')]).toEqual(['a', 'b', 'c', 'd'])
    expect(await rows()).toEqual([])
    expect(await store.summary()).toEqual({ bytes: 0, blobs: 0 })
  })

  it('refuses .git and paths outside the project before anything is read, stored or locked', async () => {
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), '[core]\n')
    let produced = false
    const produce = () => {
      produced = true
      return 'x'
    }
    await expect(journaledWrite(call('call_1', { journal: journal() }), root, { tool: 'write_file', path: '.git/config' }, produce)).rejects.toThrow('".git/config" is inside a .git folder: the workspace tools never write there.')
    await expect(journaledWrite(call('call_2', { journal: journal() }), root, { tool: 'write_file', path: 'sub/.GIT/hooks/x' }, produce)).rejects.toThrow(/\.git folder/)
    await expect(journaledWrite(call('call_3', { journal: journal() }), root, { tool: 'write_file', path: '../escape.txt' }, produce)).rejects.toThrow(/outside the project folder/)
    expect(produced).toBe(false)
    expect(await content('.git/config')).toBe('[core]\n')
    expect(await rows()).toEqual([])
  })

  it('two parallel edit_file calls on one file serialize and both edits land (one step, one journal)', async () => {
    await writeFile(join(root, 'shared.ts'), 'const a = 1\nconst b = 2\n')
    const tool = promiseTool(createEditFileTool())
    const scoped = journal()
    const [first, second] = await Promise.all([
      tool.execute({ path: 'shared.ts', old_string: 'const a = 1', new_string: 'const a = 10' }, call('call_a', { journal: scoped })),
      tool.execute({ path: 'shared.ts', old_string: 'const b = 2', new_string: 'const b = 20' }, call('call_b', { journal: scoped })),
    ])
    expect(await content('shared.ts')).toBe('const a = 10\nconst b = 20\n')
    expect([first.replacements, second.replacements]).toEqual([1, 1])
    // The lock order (not the call order) decides which edit saw the other's result; the rows follow the lock order.
    const journaled = await rows()
    expect(journaled.map(row => row.toolCallId).sort()).toEqual(['call_a', 'call_b'])
    expect(journaled[1]!.beforeSha).toBe(journaled[0]!.afterSha)
    expect(journaled[1]!.afterSha).toBe(sha256Hex('const a = 10\nconst b = 20\n'))
    const [earlier, later] = journaled[0]!.toolCallId === 'call_a' ? [first, second] : [second, first]
    expect(earlier.diff!.hunks[0]!.lines).not.toContain(' const a = 10')
    expect(earlier.diff!.hunks[0]!.lines).not.toContain(' const b = 20')
    expect(later.diff!.hunks[0]!.lines.some(line => line === ' const a = 10' || line === ' const b = 20')).toBe(true)
  })

  it('a before-state over 8 MiB is journaled as too-large and the write still runs', async () => {
    await writeFile(join(root, 'huge.log'), Buffer.alloc(LIMITS.checkpointFileMaxBytes + 1, 0x61))
    const output = await createWriteFileTool().execute({ path: 'huge.log', content: 'small now\n' }, call('call_1', { journal: journal() }))
    expect(output).toMatchObject({ created: false, diff: null, bytes: 10 })
    expect(await content('huge.log')).toBe('small now\n')
    expect(await rows()).toEqual([expect.objectContaining({ beforeState: 'too-large', beforeSha: null, beforeSize: LIMITS.checkpointFileMaxBytes + 1, afterSha: sha256Hex('small now\n') })])
    expect(await store.summary()).toEqual({ bytes: 0, blobs: 0 })
  })

  it('binary bytes round-trip through the blob store', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0xFF, 0x0D, 0x0A, 0x1A])
    await writeFile(join(root, 'image.png'), bytes)
    const output = await promiseTool(createWriteFileTool()).execute({ path: 'image.png', content: 'replaced\n' }, call('call_1', { journal: journal() }))
    expect(output.diff).toBeNull()
    const [row] = await rows()
    expect(row).toMatchObject({ beforeState: 'stored', beforeSha: sha256Hex(bytes), beforeSize: bytes.byteLength })
    expect((await store.read(row!.beforeSha!))!.equals(bytes)).toBe(true)
  })

  it('a failed insert keeps the file and the tool result', async () => {
    await writeFile(join(root, 'keep.txt'), 'one\n')
    const failing = journal({ insert: async () => {
      throw new Error('SQLITE_BUSY')
    } })
    const output = await createEditFileTool().execute({ path: 'keep.txt', old_string: 'one', new_string: 'two' }, call('call_1', { journal: failing }))
    expect(output).toMatchObject({ path: 'keep.txt', replacements: 1, diff: { added: 1, removed: 1 } })
    expect(await content('keep.txt')).toBe('two\n')
    expect(await rows()).toEqual([])
    expect(t.logs.records.filter(record => record.msg === 'checkpoint not recorded')).toHaveLength(1)
  })

  it('an abort before the write leaves the file and the rows unchanged', async () => {
    await writeFile(join(root, 'stay.txt'), 'stay\n')
    const controller = new AbortController()
    const c = call('call_1', { journal: journal(), signal: controller.signal })
    await expect(journaledWrite(c, root, { tool: 'write_file', path: 'stay.txt' }, () => {
      controller.abort(new DOMException('Stopped.', 'AbortError'))
      return 'changed\n'
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(await content('stay.txt')).toBe('stay\n')
    expect(await rows()).toEqual([])
    expect(await store.summary()).toEqual({ bytes: 0, blobs: 0 })
  })
})
