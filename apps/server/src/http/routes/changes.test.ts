// The changes routes (API.md 5.24) over the W8.2 modules (rewind, revert, undo on the restore primitive) with the C19
// fakes: an in-memory blob store, the test row writer over the in-memory database, and a fake checkpoint service whose
// read members (`listChanges`, `fileDiff`, `gitStatus`: W8.3) answer canned DTOs. Project folders are real temp folders
// inside a temp workspace root; the projects service is the real one. The last suite runs one round trip through the
// real checkpoint service (the journal, the blob store and the row writer of W8.1). Phase 9 (W9.7): the chats and
// projects services are the real ones wrapped to count `chats.find` / `projects.openWorkspace` (one chat lookup per
// request, in the service).
import type { ChatsService } from '../../services/chats/types.ts'
import type { RestoreIo } from '../../services/checkpoints/restore-scope.ts'
import type { RevertOptions } from '../../services/checkpoints/revert.ts'
import type { CheckpointService } from '../../services/checkpoints/types.ts'
import type { ProjectService } from '../../services/projects/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCheckpointBlobStore, FakeCheckpointService, TestChangeRowInput } from '../../testing/fake-checkpoints.ts'
import type { FakeChatRunner, RecordingEventBus } from '../../testing/fakes.ts'
import type { TempGitRepo } from '../../workspace/git.test-util.ts'
import type { WorkspaceWriteResult } from '../../workspace/paths.ts'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import {
  harnessErrorEnvelopeSchema,
  LIMITS,
  restoreResultSchema,
  rewindPreviewSchema,
} from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { chats, messages, projects, workspaceChanges } from '../../db/schema.ts'
import { createChatsService } from '../../services/chats/index.ts'
import { NO_PROJECT_MESSAGE as COMMON_NO_PROJECT_MESSAGE } from '../../services/checkpoints/changes-common.ts'
import { changesFileDiff, listChatChanges } from '../../services/checkpoints/changes.ts'
import { sha256Hex } from '../../services/checkpoints/disk.ts'
import { chatGitStatus } from '../../services/checkpoints/git-changes.ts'
import { NO_PROJECT_MESSAGE } from '../../services/checkpoints/restore-scope.ts'
import { revertFile, STALE_MESSAGE } from '../../services/checkpoints/revert.ts'
import { NOT_A_USER_MESSAGE, rewindFiles, rewindPreview } from '../../services/checkpoints/rewind.ts'
import { undoBatch } from '../../services/checkpoints/undo.ts'
import { createProjectService, PROJECT_GONE_MESSAGE, PROJECT_RUNNING_MESSAGE } from '../../services/projects/index.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeCheckpointBlobStore, createFakeCheckpointService, createTestChangeRowWriter, editRowFields, insertChangeRows } from '../../testing/fake-checkpoints.ts'
import { createFakeChatRunner, createRecordingEventBus } from '../../testing/fakes.ts'
import { createTempGitRepo, hasGit } from '../../workspace/git.test-util.ts'
import { resolveWorkspacePath, writeWorkspaceFile } from '../../workspace/paths.ts'

const CHAT = '0199a8f0-0000-7000-8000-0000000000d1'
const OTHER_CHAT = '0199a8f0-0000-7000-8000-0000000000d2'
const UNKNOWN_CHAT = '0199a8f0-0000-7000-8000-0000000000d9'
const PROJECT = 'prj_CHANGES000000001'
const OTHER_PROJECT = 'prj_CHANGES000000002'
const UNIX = process.platform !== 'win32'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface HarnessOptions {
  /** A folder to use as the workspace root (default: a new temp folder). */
  rootsDir?: string
  /** The project folder (default: `<rootsDir>/demo`, created). */
  projectDir?: string
  git?: RevertOptions['git']
  io?: RestoreIo
  overrides?: Partial<CheckpointService>
  /** Use the real read members (`listChanges`, `fileDiff`, `gitStatus` of W8.3) instead of the fake's canned DTOs. */
  realReads?: boolean
}

interface Harness {
  t: TestApp
  events: RecordingEventBus
  runs: FakeChatRunner
  blobs: FakeCheckpointBlobStore
  service: FakeCheckpointService
  /** The project folder of `CHAT` (canonical). */
  root: string
  /** Appends a message to a chat; returns its id. */
  message: (role: 'user' | 'assistant', chatId?: string) => Promise<string>
  /**
   * Journals an agent change of `path` from `before` to `after` (null = missing) like the journal: the before blob in
   * the store, the row (watermark = the chat's latest seq), and `after` on disk.
   */
  edit: (path: string, before: string | null, after: string | null, extra?: Partial<TestChangeRowInput>) => Promise<void>
  /** A `shell` / `untracked` row. */
  shell: (command: string, chatId?: string) => Promise<void>
  untracked: (tool: string) => Promise<void>
  /** The file on disk (null = missing). */
  read: (path: string) => Promise<string | null>
  /** Writes a file on disk outside the journal (null removes it). */
  disk: (path: string, content: string | null) => Promise<void>
  send: (method: string, path: string, body?: unknown) => Promise<{ status: number, body: any }>
  /** The ids passed to `chats.find` and `projects.openWorkspace` (tests clear them before a request). */
  finds: string[]
  opened: string[]
}

/** `service` with `member` calls recorded into `calls` (the first argument). */
function counting<T extends object>(service: T, member: keyof T, calls: string[]): T {
  return new Proxy(service, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property)
      if (property !== member || typeof value !== 'function')
        return value
      return (...args: unknown[]) => {
        calls.push(String(args[0]))
        return (value as (...args: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

let messageCounter = 0

async function open(options: HarnessOptions = {}): Promise<Harness> {
  const rootsDir = options.rootsDir ?? await tempFolder()
  const root = options.projectDir ?? join(rootsDir, 'demo')
  await mkdir(root, { recursive: true })
  const events = createRecordingEventBus()
  const runs = createFakeChatRunner()
  const blobs = createFakeCheckpointBlobStore()
  const finds: string[] = []
  const opened: string[] = []
  let service!: FakeCheckpointService
  const t = await createTestApp({
    workspaceRoots: [rootsDir],
    overrides: { events, runs },
    factories: {
      chats: (deps): ChatsService => counting(createChatsService(deps), 'find', finds),
      projects: (deps): ProjectService => counting(createProjectService(deps), 'openWorkspace', opened),
      checkpoints: (deps) => {
        const ctx = () => ({ deps, blobs, rows: createTestChangeRowWriter(deps.db), now: Date.now })
        const reads: Partial<CheckpointService> = options.realReads !== true
          ? {}
          : {
              listChanges: async (chatId, readOptions) => listChatChanges(ctx(), chatId, readOptions),
              fileDiff: async (chatId, query, readOptions) => changesFileDiff(ctx(), chatId, query, readOptions),
              gitStatus: async (chatId, readOptions) => chatGitStatus(ctx(), chatId, readOptions),
            }
        service = createFakeCheckpointService({
          ...reads,
          revert: (chatId, body) => revertFile(ctx(), chatId, body, { ...(options.git === undefined ? {} : { git: options.git }), ...(options.io === undefined ? {} : { io: options.io }) }),
          undo: (chatId, body) => undoBatch(ctx(), chatId, body, options.io === undefined ? {} : { io: options.io }),
          rewindPreview: (chatId, messageId, readOptions) => rewindPreview(ctx(), chatId, messageId, readOptions),
          rewind: (chatId, body) => rewindFiles(ctx(), chatId, body, options.io === undefined ? {} : { io: options.io }),
          ...options.overrides,
        })
        return service
      },
    },
  })
  cleanups.push(() => t.close())
  await t.db.insert(projects).values({ id: PROJECT, name: 'Demo', path: root, createdAt: 1, updatedAt: 1 })
  await t.db.insert(chats).values({ id: CHAT, projectId: PROJECT })

  const seqs = new Map<string, number>()
  const message: Harness['message'] = async (role, chatId = CHAT) => {
    messageCounter += 1
    const id = `msg_${String(messageCounter).padStart(16, '0')}`
    const seq = (seqs.get(chatId) ?? 0) + 1
    seqs.set(chatId, seq)
    await t.db.insert(messages).values({ id, chatId, seq, role, parts: [{ type: 'text', text: role }] })
    return id
  }
  const disk: Harness['disk'] = async (path, content) => {
    const target = join(root, path)
    if (content === null) {
      await rm(target, { force: true })
      return
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  const edit: Harness['edit'] = async (path, before, after, extra = {}) => {
    if (before !== null)
      await blobs.put(Buffer.from(before))
    await insertChangeRows(t.db, [{ chatId: CHAT, projectId: PROJECT, kind: 'edit', tool: 'write_file', messageId: 'msg_AGENT00000000001', toolCallId: 'call_1', path, ...editRowFields(before, after), ...extra }])
    if ((extra.chatId ?? CHAT) === CHAT && (extra.projectId ?? PROJECT) === PROJECT)
      await disk(path, after)
  }
  const shell: Harness['shell'] = async (command, chatId = CHAT) => {
    await insertChangeRows(t.db, [{ chatId, projectId: PROJECT, kind: 'shell', tool: 'shell', messageId: 'msg_AGENT00000000001', toolCallId: 'call_sh', command }])
  }
  const untracked: Harness['untracked'] = async (tool) => {
    await insertChangeRows(t.db, [{ chatId: CHAT, projectId: PROJECT, kind: 'untracked', tool, messageId: 'msg_AGENT00000000001', toolCallId: 'call_ut' }])
  }
  const read: Harness['read'] = async path => (existsSync(join(root, path)) ? readFile(join(root, path), 'utf8') : null)
  const send: Harness['send'] = async (method, path, body) => {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await t.request(`/api${path}`, init)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }
  return { t, events, runs, blobs, service, root, message, edit, shell, untracked, read, disk, send, finds, opened }
}

function errorOf(body: unknown) {
  return harnessErrorEnvelopeSchema.parse(body).error
}

async function journal(h: Harness, kind?: string) {
  const rows = await h.t.db.select().from(workspaceChanges).orderBy(workspaceChanges.id)
  return kind === undefined ? rows : rows.filter(row => row.kind === kind)
}

/** Two turns: u1 -> a.txt created (v1), src/b.txt created; u2 -> a.txt v1 -> v2, src/b.txt b1 -> b2, a shell command. */
async function twoTurns(h: Harness): Promise<{ u1: string, a1: string, u2: string, a2: string }> {
  const u1 = await h.message('user')
  const a1 = await h.message('assistant')
  await h.edit('a.txt', null, 'v1\n')
  await h.edit('src/b.txt', null, 'b1\n')
  const u2 = await h.message('user')
  const a2 = await h.message('assistant')
  await h.edit('a.txt', 'v1\n', 'v2\n')
  await h.shell('npm test')
  await h.edit('src/b.txt', 'b1\n', 'b2\n')
  return { u1, a1, u2, a2 }
}

// ---------- common answers ----------

/** One request of every changes route for `chatId` (`user`: a user message id of the chat). */
function everyRoute(chatId: string, user = 'msg_AAAAAAAAAAAAAAAA'): Array<[string, string, unknown?]> {
  return [
    ['GET', `/chats/${chatId}/changes`],
    ['GET', `/chats/${chatId}/changes/diff?source=chat&path=a.txt`],
    ['GET', `/chats/${chatId}/changes/diff?source=git&path=a.txt`],
    ['GET', `/chats/${chatId}/git`],
    ['POST', `/chats/${chatId}/changes/revert`, { source: 'chat', path: 'a.txt' }],
    ['POST', `/chats/${chatId}/changes/undo`, { batchId: 'wcb_AAAAAAAAAAAAAAAA', conflicts: 'skip' }],
    ['GET', `/chats/${chatId}/rewind?messageId=${user}`],
    ['POST', `/chats/${chatId}/rewind`, { messageId: user, conflicts: 'skip' }],
  ]
}

describe('changes routes: common answers', () => {
  it('every route answers 404 for an unknown chat: one chat lookup, before any project, git or disk work', async () => {
    const h = await open({ realReads: true })
    for (const [method, path, body] of everyRoute(UNKNOWN_CHAT)) {
      h.finds.length = 0
      h.opened.length = 0
      const { status, body: answer } = await h.send(method, path, body)
      expect(status, path).toBe(404)
      expect(errorOf(answer), path).toEqual({ code: 'not_found', message: `Chat ${UNKNOWN_CHAT} not found.` })
      expect(h.finds, path).toEqual([UNKNOWN_CHAT])
      expect(h.opened, path).toEqual([])
    }
  })

  it('looks the chat up once per request on every route (Phase 9, W9.7)', async () => {
    const h = await open({ realReads: true })
    const user = await h.message('user')
    for (const [method, path, body] of everyRoute(CHAT, user)) {
      h.finds.length = 0
      h.opened.length = 0
      await h.send(method, path, body)
      expect(h.finds, `${method} ${path}`).toEqual([CHAT])
      expect(h.opened, `${method} ${path}`).toEqual([PROJECT])
    }
  })

  it('defines the no-project message once (the reads and the writes share it)', () => {
    expect(NO_PROJECT_MESSAGE).toBe('This chat has no project.')
    expect(COMMON_NO_PROJECT_MESSAGE).toBe(NO_PROJECT_MESSAGE)
  })

  it('changes.list, changes.diff and changes.git delegate to the service with the request signal', async () => {
    const h = await open()
    expect((await h.send('GET', `/chats/${CHAT}/changes`)).body).toMatchObject({ available: false, reason: 'no-project' })
    const diff = await h.send('GET', `/chats/${CHAT}/changes/diff?source=git&path=src%2Fa.ts`)
    expect(diff.status).toBe(404)
    expect((await h.send('GET', `/chats/${CHAT}/git`)).body).toMatchObject({ available: false, reason: 'not-a-repo' })
    const calls = h.service.calls.filter(call => call.member !== 'start')
    expect(calls.map(call => call.member)).toEqual(['listChanges', 'fileDiff', 'gitStatus'])
    expect(calls[0]!.args[0]).toBe(CHAT)
    expect(calls[1]!.args.slice(0, 2)).toEqual([CHAT, { source: 'git', path: 'src/a.ts' }])
    for (const call of calls)
      expect((call.args.at(-1) as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal)
  })

  it('the read members answer their DTO as is (available, files)', async () => {
    const listed = { available: true, reason: null, projectId: PROJECT, files: [], truncated: false, untracked: { shellCommands: 2, toolCalls: 0 } }
    const h = await open({ overrides: { listChanges: async () => listed } })
    expect(await h.send('GET', `/chats/${CHAT}/changes`)).toEqual({ status: 200, body: listed })
  })

  it('writes and the rewind preview of a chat without a usable project answer 400 with the project message', async () => {
    const h = await open()
    await h.t.db.insert(chats).values({ id: OTHER_CHAT, projectId: null })
    const user = await h.message('user', OTHER_CHAT)
    const writes: Array<[string, string, unknown?]> = [
      ['POST', `/chats/${OTHER_CHAT}/changes/revert`, { source: 'chat', path: 'a.txt' }],
      ['POST', `/chats/${OTHER_CHAT}/changes/revert`, { source: 'git', path: 'a.txt' }],
      ['POST', `/chats/${OTHER_CHAT}/changes/undo`, { batchId: 'wcb_AAAAAAAAAAAAAAAA', conflicts: 'skip' }],
      ['GET', `/chats/${OTHER_CHAT}/rewind?messageId=${user}`],
      ['POST', `/chats/${OTHER_CHAT}/rewind`, { messageId: user, conflicts: 'skip' }],
    ]
    for (const [method, path, body] of writes) {
      const { status, body: answer } = await h.send(method, path, body)
      expect(status, path).toBe(400)
      expect(errorOf(answer), path).toMatchObject({ code: 'validation_error', message: NO_PROJECT_MESSAGE })
    }

    // A project that no longer exists, and a folder that is gone.
    await h.t.db.update(chats).set({ projectId: OTHER_PROJECT }).where(eq(chats.id, OTHER_CHAT))
    const gone = await h.send('POST', `/chats/${OTHER_CHAT}/rewind`, { messageId: user, conflicts: 'skip' })
    expect(gone.status).toBe(400)
    expect(errorOf(gone.body)).toMatchObject({ code: 'validation_error', message: PROJECT_GONE_MESSAGE })
    await rm(h.root, { recursive: true, force: true })
    const unavailable = await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path: 'a.txt' })
    expect(unavailable.status).toBe(400)
    expect(errorOf(unavailable.body).message).toMatch(/^The project folder .+ is not available: /)
  })
})

// ---------- rewind ----------

describe('changes.rewindPreview / changes.rewind', () => {
  it('previews every file changed since the user message, with the untracked changes of the range', async () => {
    const h = await open()
    const { u2 } = await twoTurns(h)
    await h.untracked('acme_write')
    const { status, body } = await h.send('GET', `/chats/${CHAT}/rewind?messageId=${u2}`)
    expect(status).toBe(200)
    const preview = rewindPreviewSchema.parse(body)
    expect(preview).toEqual({
      messageId: u2,
      files: [
        { path: 'src/b.txt', action: 'restore', conflict: false, edits: 1 },
        { path: 'a.txt', action: 'restore', conflict: false, edits: 1 },
      ],
      untracked: {
        shellCount: 1,
        shell: [{ command: 'npm test', at: expect.any(Number), messageId: 'msg_AGENT00000000001' }],
        tools: [{ tool: 'acme_write', at: expect.any(Number), messageId: 'msg_AGENT00000000001' }],
      },
      truncated: false,
    })
    // Nothing was written by the preview.
    expect(await h.read('a.txt')).toBe('v2\n')
    expect(await journal(h, 'rewind')).toEqual([])
  })

  it('the first message covers every change: created files are deleted', async () => {
    const h = await open()
    const { u1 } = await twoTurns(h)
    const preview = (await h.send('GET', `/chats/${CHAT}/rewind?messageId=${u1}`)).body
    expect(preview.files).toEqual([
      { path: 'src/b.txt', action: 'delete', conflict: false, edits: 2 },
      { path: 'a.txt', action: 'delete', conflict: false, edits: 2 },
    ])
    const { status, body } = await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u1, conflicts: 'skip' })
    expect(status).toBe(200)
    expect(restoreResultSchema.parse(body)).toMatchObject({ deleted: ['src/b.txt', 'a.txt'], restored: [], skipped: [] })
    expect(await h.read('a.txt')).toBeNull()
    expect(await h.read('src/b.txt')).toBeNull()
    // Folders the agent created stay.
    expect(existsSync(join(h.root, 'src'))).toBe(true)
  })

  it('applies a rewind as one batch: rows, the event, the logs; running it again changes nothing', async () => {
    const h = await open()
    const { u2 } = await twoTurns(h)
    const { status, body } = await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'skip' })
    expect(status).toBe(200)
    const result = restoreResultSchema.parse(body)
    expect(result).toEqual({ batchId: expect.stringMatching(/^wcb_/), restored: ['src/b.txt', 'a.txt'], deleted: [], unchanged: [], skipped: [] })
    expect(await h.read('a.txt')).toBe('v1\n')
    expect(await h.read('src/b.txt')).toBe('b1\n')

    const rows = await journal(h, 'rewind')
    expect(rows.map(row => [row.path, row.batchId, row.beforeSha, row.afterSha])).toEqual([
      ['src/b.txt', result.batchId, sha256Hex('b2\n'), sha256Hex('b1\n')],
      ['a.txt', result.batchId, sha256Hex('v2\n'), sha256Hex('v1\n')],
    ])
    expect(h.events.ofType('workspace.changed').map(event => event.data)).toEqual([
      { projectId: PROJECT, chatId: CHAT, batchId: result.batchId, source: 'rewind', paths: ['src/b.txt', 'a.txt'] },
    ])
    const info = h.t.logs.records.find(record => record.msg === 'files rewound')
    expect(info).toMatchObject({ level: 'info', chatId: CHAT, batchId: result.batchId, restored: 2, deleted: 0, unchanged: 0, skipped: 0 })
    expect(h.t.logs.records.filter(record => record.level !== 'debug').map(record => JSON.stringify(record)).join('\n')).not.toContain('a.txt')
    expect(h.t.logs.records.find(record => record.msg === 'files rewound: paths')).toMatchObject({ level: 'debug', restored: ['src/b.txt', 'a.txt'] })

    // Idempotent: the rewind sees its own rows; nothing to write, no batch, no event.
    const preview = (await h.send('GET', `/chats/${CHAT}/rewind?messageId=${u2}`)).body
    expect(preview.files.map((file: { action: string }) => file.action)).toEqual(['unchanged', 'unchanged'])
    const again = (await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'skip' })).body
    // Newest-edited first: the rewind's own rows (a.txt was written last) lead the order now.
    expect(again).toEqual({ batchId: null, restored: [], deleted: [], unchanged: ['a.txt', 'src/b.txt'], skipped: [] })
    expect(h.events.ofType('workspace.changed')).toHaveLength(1)
  })

  it('a message after every edit has nothing to restore (also a chat without any journal)', async () => {
    const h = await open()
    await twoTurns(h)
    const u3 = await h.message('user')
    expect((await h.send('GET', `/chats/${CHAT}/rewind?messageId=${u3}`)).body).toEqual({
      messageId: u3,
      files: [],
      untracked: { shellCount: 0, shell: [], tools: [] },
      truncated: false,
    })
    expect((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u3, conflicts: 'force' })).body).toEqual({ batchId: null, restored: [], deleted: [], unchanged: [], skipped: [] })
    expect(h.events.ofType('workspace.changed')).toEqual([])
    expect(await h.read('a.txt')).toBe('v2\n')
  })

  it('a file changed after the chat is a conflict: skip keeps the disk, force restores it', async () => {
    const h = await open()
    const { u2 } = await twoTurns(h)
    await h.disk('a.txt', 'mine\n')
    const preview = (await h.send('GET', `/chats/${CHAT}/rewind?messageId=${u2}`)).body
    expect(preview.files).toContainEqual({ path: 'a.txt', action: 'restore', conflict: true, edits: 1 })

    const skipped = restoreResultSchema.parse((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'skip' })).body)
    expect(skipped.restored).toEqual(['src/b.txt'])
    expect(skipped.skipped).toEqual([{ path: 'a.txt', reason: 'conflict', message: expect.any(String) }])
    expect(await h.read('a.txt')).toBe('mine\n')

    const forced = restoreResultSchema.parse((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'force' })).body)
    expect(forced).toMatchObject({ restored: ['a.txt'], unchanged: ['src/b.txt'], skipped: [] })
    expect(await h.read('a.txt')).toBe('v1\n')
    // The forced write snapshotted the user's version, so an undo brings it back.
    const undo = (await h.send('POST', `/chats/${CHAT}/changes/undo`, { batchId: forced.batchId, conflicts: 'skip' })).body
    expect(undo).toMatchObject({ restored: ['a.txt'] })
    expect(await h.read('a.txt')).toBe('mine\n')
  })

  it('an unavailable earlier state is listed and skipped', async () => {
    const h = await open()
    const u1 = await h.message('user')
    await h.message('assistant')
    await insertChangeRows(h.t.db, [{ chatId: CHAT, projectId: PROJECT, kind: 'edit', tool: 'write_file', path: 'big.bin', beforeState: 'too-large', beforeSize: 9_000_000, beforeMode: 0o644, afterSha: sha256Hex('small\n'), afterSize: 6 }])
    await h.disk('big.bin', 'small\n')
    expect((await h.send('GET', `/chats/${CHAT}/rewind?messageId=${u1}`)).body.files).toEqual([{ path: 'big.bin', action: 'unavailable', conflict: false, edits: 1 }])
    const result = (await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u1, conflicts: 'force' })).body
    expect(result).toMatchObject({ batchId: null, skipped: [{ path: 'big.bin', reason: 'unavailable' }] })
  })

  it('validates the target: unknown message 404, another chat\'s message 404, not a user message 400', async () => {
    const h = await open()
    const { a1 } = await twoTurns(h)
    await h.t.db.insert(chats).values({ id: OTHER_CHAT, projectId: PROJECT })
    const foreign = await h.message('user', OTHER_CHAT)
    for (const messageId of ['msg_UNKNOWN000000001', foreign]) {
      for (const [method, path, body] of [['GET', `/chats/${CHAT}/rewind?messageId=${messageId}`], ['POST', `/chats/${CHAT}/rewind`, { messageId, conflicts: 'skip' }]] as const) {
        const answer = await h.send(method, path, body)
        expect(answer.status, `${method} ${messageId}`).toBe(404)
        expect(errorOf(answer.body)).toEqual({ code: 'not_found', message: `Message ${messageId} not found in chat ${CHAT}.` })
      }
    }
    for (const [method, path, body] of [['GET', `/chats/${CHAT}/rewind?messageId=${a1}`], ['POST', `/chats/${CHAT}/rewind`, { messageId: a1, conflicts: 'skip' }]] as const) {
      const answer = await h.send(method, path, body)
      expect(answer.status).toBe(400)
      expect(errorOf(answer.body)).toMatchObject({ code: 'validation_error', message: NOT_A_USER_MESSAGE, details: { issues: [{ path: ['messageId'] }] } })
    }
  })

  it('409 run-active while another chat of the project runs; the preview still answers', async () => {
    const h = await open()
    const { u2 } = await twoTurns(h)
    await h.t.db.insert(chats).values({ id: OTHER_CHAT, projectId: PROJECT })
    h.runs.phases.set(OTHER_CHAT, 'streaming')
    const { status, body } = await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'force' })
    expect(status).toBe(409)
    expect(errorOf(body)).toEqual({ code: 'conflict', message: PROJECT_RUNNING_MESSAGE, details: { reason: 'run-active', chatId: OTHER_CHAT } })
    expect(await h.read('a.txt')).toBe('v2\n')
    expect(await journal(h, 'rewind')).toEqual([])
    expect((await h.send('GET', `/chats/${CHAT}/rewind?messageId=${u2}`)).status).toBe(200)

    // A run of a chat in another project does not block.
    await h.t.db.update(chats).set({ projectId: null }).where(eq(chats.id, OTHER_CHAT))
    expect((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'force' })).status).toBe(200)
  })

  it('ignores rows recorded in another project and edits of other chats (they show as conflicts)', async () => {
    const h = await open()
    const u1 = await h.message('user')
    await h.message('assistant')
    await h.t.db.insert(projects).values({ id: OTHER_PROJECT, name: 'Old', path: join(h.root, '..', 'old'), createdAt: 1, updatedAt: 1 })
    await h.edit('old.txt', null, 'old\n', { projectId: OTHER_PROJECT })
    await h.edit('a.txt', null, 'mine\n')
    // Another chat of the same project edited a.txt afterwards.
    await h.t.db.insert(chats).values({ id: OTHER_CHAT, projectId: PROJECT })
    await h.edit('a.txt', 'mine\n', 'theirs\n', { chatId: OTHER_CHAT })
    await h.disk('a.txt', 'theirs\n')
    const preview = (await h.send('GET', `/chats/${CHAT}/rewind?messageId=${u1}`)).body
    expect(preview.files).toEqual([{ path: 'a.txt', action: 'delete', conflict: true, edits: 1 }])
  })

  it('lists at most 500 files (truncated) and the latest 50 shell commands, counting all of them', async () => {
    const h = await open()
    const u1 = await h.message('user')
    await h.message('assistant')
    const rows: TestChangeRowInput[] = Array.from({ length: LIMITS.changesFilesMax + 1 }, (_, index) => ({
      chatId: CHAT,
      projectId: PROJECT,
      kind: 'edit',
      tool: 'write_file',
      path: `gen/f${index}.txt`,
      ...editRowFields(null, `${index}\n`),
    }))
    for (let index = 0; index < LIMITS.rewindUntrackedListMax + 5; index += 1)
      rows.push({ chatId: CHAT, projectId: PROJECT, kind: 'shell', tool: 'shell', command: `echo ${index}` })
    await insertChangeRows(h.t.db, rows)
    const preview = rewindPreviewSchema.parse((await h.send('GET', `/chats/${CHAT}/rewind?messageId=${u1}`)).body)
    expect(preview.files).toHaveLength(LIMITS.changesFilesMax)
    expect(preview.truncated).toBe(true)
    expect(preview.files[0]!.path).toBe(`gen/f${LIMITS.changesFilesMax}.txt`)
    // The files are not on disk: already at their target (missing).
    expect(preview.files[0]!.action).toBe('unchanged')
    expect(preview.untracked.shellCount).toBe(LIMITS.rewindUntrackedListMax + 5)
    expect(preview.untracked.shell).toHaveLength(LIMITS.rewindUntrackedListMax)
    expect(preview.untracked.shell[0]!.command).toBe(`echo ${LIMITS.rewindUntrackedListMax + 4}`)
  })

  it('a writer that fails after the first file: the batch continues, a rerun resumes it', async () => {
    let writes = 0
    let failing = true
    const io: RestoreIo = {
      writeFile: async (root: string, path: string, data: Uint8Array): Promise<WorkspaceWriteResult> => {
        writes += 1
        if (failing && writes > 1)
          throw Object.assign(new Error('EIO'), { code: 'EIO' })
        return writeWorkspaceFile(root, path, data)
      },
    }
    const h = await open({ io })
    const { u2 } = await twoTurns(h)
    const partial = restoreResultSchema.parse((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'skip' })).body)
    expect(partial).toMatchObject({ restored: ['src/b.txt'], skipped: [{ path: 'a.txt', reason: 'failed' }] })
    expect(h.events.ofType('workspace.changed').map(event => event.data.paths)).toEqual([['src/b.txt']])
    failing = false
    const resumed = restoreResultSchema.parse((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'skip' })).body)
    expect(resumed).toMatchObject({ restored: ['a.txt'], unchanged: ['src/b.txt'], skipped: [] })
    expect(await h.read('a.txt')).toBe('v1\n')
  })
})

// ---------- undo ----------

describe('changes.undo', () => {
  it('rewind -> undo brings the pre-rewind state back; undoing the undo redoes the rewind', async () => {
    const h = await open()
    const { u1 } = await twoTurns(h)
    const rewound = restoreResultSchema.parse((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u1, conflicts: 'skip' })).body)
    expect(await h.read('a.txt')).toBeNull()

    const { status, body } = await h.send('POST', `/chats/${CHAT}/changes/undo`, { batchId: rewound.batchId, conflicts: 'skip' })
    expect(status).toBe(200)
    const undone = restoreResultSchema.parse(body)
    expect(undone).toMatchObject({ restored: ['a.txt', 'src/b.txt'], skipped: [] })
    expect(undone.batchId).not.toBe(rewound.batchId)
    expect(await h.read('a.txt')).toBe('v2\n')
    expect(await h.read('src/b.txt')).toBe('b2\n')
    expect((await journal(h, 'undo')).every(row => row.batchId === undone.batchId)).toBe(true)
    expect(h.events.ofType('workspace.changed').at(-1)!.data).toEqual({ projectId: PROJECT, chatId: CHAT, batchId: undone.batchId, source: 'undo', paths: ['a.txt', 'src/b.txt'] })
    expect(h.t.logs.records.find(record => record.msg === 'restore undone')).toMatchObject({ level: 'info', restored: 2 })

    const redone = restoreResultSchema.parse((await h.send('POST', `/chats/${CHAT}/changes/undo`, { batchId: undone.batchId, conflicts: 'skip' })).body)
    expect(redone).toMatchObject({ deleted: ['src/b.txt', 'a.txt'] })
    expect(await h.read('a.txt')).toBeNull()
  })

  it('a file changed since the batch wrote it: skip or force', async () => {
    const h = await open()
    const { u2 } = await twoTurns(h)
    const rewound = restoreResultSchema.parse((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'skip' })).body)
    await h.disk('a.txt', 'later\n')
    const skipped = (await h.send('POST', `/chats/${CHAT}/changes/undo`, { batchId: rewound.batchId, conflicts: 'skip' })).body
    expect(skipped).toMatchObject({ restored: ['src/b.txt'], skipped: [{ path: 'a.txt', reason: 'conflict' }] })
    expect(await h.read('a.txt')).toBe('later\n')
    const forced = (await h.send('POST', `/chats/${CHAT}/changes/undo`, { batchId: rewound.batchId, conflicts: 'force' })).body
    expect(forced).toMatchObject({ restored: ['a.txt'], unchanged: ['src/b.txt'] })
    expect(await h.read('a.txt')).toBe('v2\n')
  })

  it('an unknown batch, a batch of another chat and an agent edit id are 404', async () => {
    const h = await open()
    const { u2 } = await twoTurns(h)
    const rewound = restoreResultSchema.parse((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'skip' })).body)
    await h.t.db.insert(chats).values({ id: OTHER_CHAT, projectId: PROJECT })
    for (const [chatId, batchId] of [[CHAT, 'wcb_UNKNOWN000000001'], [OTHER_CHAT, rewound.batchId!]] as const) {
      const answer = await h.send('POST', `/chats/${chatId}/changes/undo`, { batchId, conflicts: 'skip' })
      expect(answer.status).toBe(404)
      expect(errorOf(answer.body)).toEqual({ code: 'not_found', message: `Change batch ${batchId} not found.` })
    }
  })

  it('409 run-active while a chat of the project runs (also the chat itself)', async () => {
    const h = await open()
    const { u2 } = await twoTurns(h)
    const rewound = restoreResultSchema.parse((await h.send('POST', `/chats/${CHAT}/rewind`, { messageId: u2, conflicts: 'skip' })).body)
    h.runs.phases.set(CHAT, 'preparing')
    const answer = await h.send('POST', `/chats/${CHAT}/changes/undo`, { batchId: rewound.batchId, conflicts: 'force' })
    expect(answer.status).toBe(409)
    expect(errorOf(answer.body).details).toEqual({ reason: 'run-active', chatId: CHAT })
    expect(await h.read('a.txt')).toBe('v1\n')
  })
})

// ---------- revert (chat) ----------

describe('changes.revert (source chat)', () => {
  it('writes the base back (the state before the chat first changed it); undo brings the agent version back', async () => {
    const h = await open()
    await h.disk('a.txt', 'base\n')
    await h.message('user')
    await h.edit('a.txt', 'base\n', 'v1\n')
    await h.edit('a.txt', 'v1\n', 'v2\n')
    const { status, body } = await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path: './a.txt', expectedSha: sha256Hex('v2\n') })
    expect(status).toBe(200)
    const reverted = restoreResultSchema.parse(body)
    expect(reverted).toEqual({ batchId: expect.stringMatching(/^wcb_/), restored: ['a.txt'], deleted: [], unchanged: [], skipped: [] })
    expect(await h.read('a.txt')).toBe('base\n')
    expect((await journal(h, 'revert')).map(row => [row.path, row.batchId])).toEqual([['a.txt', reverted.batchId]])
    expect(h.events.ofType('workspace.changed').map(event => event.data)).toEqual([{ projectId: PROJECT, chatId: CHAT, batchId: reverted.batchId, source: 'revert', paths: ['a.txt'] }])
    expect(h.t.logs.records.find(record => record.msg === 'file reverted')).toMatchObject({ level: 'info', restored: 1 })

    await h.send('POST', `/chats/${CHAT}/changes/undo`, { batchId: reverted.batchId, conflicts: 'skip' })
    expect(await h.read('a.txt')).toBe('v2\n')
  })

  it('a file the chat created is deleted; reverting again leaves it unchanged', async () => {
    const h = await open()
    await h.edit('new/file.txt', null, 'new\n')
    expect((await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path: 'new/file.txt' })).body).toMatchObject({ deleted: ['new/file.txt'] })
    expect(await h.read('new/file.txt')).toBeNull()
    expect((await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path: 'new/file.txt' })).body).toEqual({ batchId: null, restored: [], deleted: [], unchanged: ['new/file.txt'], skipped: [] })
  })

  it('409 stale when the disk is not the expected state; nothing is written', async () => {
    const h = await open()
    await h.edit('a.txt', 'base\n', 'v1\n')
    for (const expectedSha of [sha256Hex('other\n'), null]) {
      const answer = await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path: 'a.txt', expectedSha })
      expect(answer.status).toBe(409)
      expect(errorOf(answer.body)).toEqual({ code: 'conflict', message: STALE_MESSAGE, details: { reason: 'stale' } })
    }
    expect(await h.read('a.txt')).toBe('v1\n')
    // null = the client showed a missing file.
    await h.disk('a.txt', null)
    expect((await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path: 'a.txt', expectedSha: null })).body).toMatchObject({ restored: ['a.txt'] })
    expect(await h.read('a.txt')).toBe('base\n')
  })

  it('404 for a path the chat never changed (or changed only in another project); 400 for a refused path', async () => {
    const h = await open()
    await h.t.db.insert(projects).values({ id: OTHER_PROJECT, name: 'Old', path: join(h.root, '..', 'old'), createdAt: 1, updatedAt: 1 })
    await h.edit('old.txt', null, 'x\n', { projectId: OTHER_PROJECT })
    for (const path of ['never.txt', 'old.txt']) {
      const answer = await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path })
      expect(answer.status, path).toBe(404)
      expect(errorOf(answer.body).message).toBe(`"${path}" has no changes in this chat.`)
    }
    for (const path of ['../outside.txt', '.git/config', '.']) {
      const answer = await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path })
      expect(answer.status, path).toBe(400)
      expect(errorOf(answer.body), path).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    }
  })

  it('a base that is not stored: 200 with the file skipped as unavailable and no batch', async () => {
    const h = await open()
    await insertChangeRows(h.t.db, [{ chatId: CHAT, projectId: PROJECT, kind: 'edit', tool: 'write_file', path: 'big.bin', beforeState: 'evicted', beforeSha: sha256Hex('old'), beforeSize: 3, afterSha: sha256Hex('new\n'), afterSize: 4 }])
    await h.disk('big.bin', 'new\n')
    const answer = await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path: 'big.bin' })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ batchId: null, skipped: [{ path: 'big.bin', reason: 'unavailable' }] })
    expect(h.events.ofType('workspace.changed')).toEqual([])
  })

  it('409 run-active while a chat of the project runs', async () => {
    const h = await open()
    await h.edit('a.txt', 'base\n', 'v1\n')
    h.runs.phases.set(CHAT, 'streaming')
    const answer = await h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path: 'a.txt' })
    expect(answer.status).toBe(409)
    expect(errorOf(answer.body).details).toEqual({ reason: 'run-active', chatId: CHAT })
    expect(await h.read('a.txt')).toBe('v1\n')
  })
})

// ---------- revert (git) ----------

describe.skipIf(!hasGit())('changes.revert (source git)', () => {
  async function openRepo(options: { subfolder?: string } = {}): Promise<{ h: Harness, repo: TempGitRepo, root: string }> {
    const rootsDir = await tempFolder()
    const repo = await createTempGitRepo({ base: rootsDir })
    const projectDir = options.subfolder === undefined ? repo.dir : join(repo.dir, options.subfolder)
    const h = await open({ rootsDir, projectDir, git: { parentEnv: repo.env } })
    return { h, repo, root: projectDir }
  }

  async function revert(h: Harness, path: string, extra: Record<string, unknown> = {}) {
    return h.send('POST', `/chats/${CHAT}/changes/revert`, { source: 'git', path, ...extra })
  }

  it('a modified tracked file gets its HEAD content (the index is never touched); undo brings the change back', async () => {
    const { h, repo } = await openRepo()
    await repo.write('a.txt', 'head\n')
    await repo.commitAll()
    await repo.write('a.txt', 'changed\n')
    const index = await readFile(join(repo.dir, '.git', 'index'))
    const { status, body } = await revert(h, 'a.txt', { expectedSha: sha256Hex('changed\n') })
    expect(status).toBe(200)
    const reverted = restoreResultSchema.parse(body)
    expect(reverted).toMatchObject({ restored: ['a.txt'], skipped: [] })
    expect(await h.read('a.txt')).toBe('head\n')
    expect(await readFile(join(repo.dir, '.git', 'index'))).toEqual(index)
    expect(h.events.ofType('workspace.changed').at(-1)!.data).toMatchObject({ source: 'revert', batchId: reverted.batchId, paths: ['a.txt'] })

    await h.send('POST', `/chats/${CHAT}/changes/undo`, { batchId: reverted.batchId, conflicts: 'skip' })
    expect(await h.read('a.txt')).toBe('changed\n')
  })

  it('an untracked file is deleted after a snapshot (undo restores it); a staged new file is deleted too', async () => {
    const { h, repo } = await openRepo()
    await repo.commitAll()
    await repo.write('new.txt', 'untracked\n')
    const reverted = restoreResultSchema.parse((await revert(h, 'new.txt')).body)
    expect(reverted.deleted).toEqual(['new.txt'])
    expect(await h.read('new.txt')).toBeNull()
    await h.send('POST', `/chats/${CHAT}/changes/undo`, { batchId: reverted.batchId, conflicts: 'skip' })
    expect(await h.read('new.txt')).toBe('untracked\n')

    await repo.write('staged.txt', 'staged\n')
    await repo.git(['add', 'staged.txt'])
    expect((await revert(h, 'staged.txt')).body).toMatchObject({ deleted: ['staged.txt'] })
    expect(await h.read('staged.txt')).toBeNull()
  })

  it.skipIf(!UNIX)('a deleted executable comes back executable; a lost executable bit is set again', async () => {
    const { h, repo } = await openRepo()
    await repo.write('run.sh', '#!/bin/sh\necho hi\n', 0o755)
    await repo.commitAll()
    await unlink(join(repo.dir, 'run.sh'))
    expect((await revert(h, 'run.sh')).body).toMatchObject({ restored: ['run.sh'] })
    expect(await h.read('run.sh')).toBe('#!/bin/sh\necho hi\n')
    expect((await stat(join(repo.dir, 'run.sh'))).mode & 0o111).not.toBe(0)
    await chmod(join(repo.dir, 'run.sh'), 0o644)
    expect((await revert(h, 'run.sh')).body).toMatchObject({ restored: ['run.sh'] })
    expect((await stat(join(repo.dir, 'run.sh'))).mode & 0o111).not.toBe(0)
  })

  it('a rename restores origPath and deletes path', async () => {
    const { h, repo } = await openRepo()
    await repo.write('old.txt', 'content\n')
    await repo.commitAll()
    await repo.git(['mv', 'old.txt', 'new.txt'])
    const reverted = restoreResultSchema.parse((await revert(h, 'new.txt')).body)
    expect(reverted).toMatchObject({ restored: ['old.txt'], deleted: ['new.txt'], skipped: [] })
    expect(await h.read('old.txt')).toBe('content\n')
    expect(await h.read('new.txt')).toBeNull()
  })

  it('works in a project that is a subfolder of the repository', async () => {
    const { h, repo } = await openRepo({ subfolder: 'pkg' })
    await repo.write('pkg/a.txt', 'head\n')
    await repo.write('top.txt', 'top\n')
    await repo.commitAll()
    await repo.write('pkg/a.txt', 'changed\n')
    expect((await revert(h, 'a.txt')).body).toMatchObject({ restored: ['a.txt'] })
    expect(await readFile(join(repo.dir, 'pkg', 'a.txt'), 'utf8')).toBe('head\n')
  })

  it('refuses conflicted files, symbolic links, submodules, filtered paths and ignored files with 400', async () => {
    const { h, repo } = await openRepo()
    await repo.write('.gitattributes', '*.bin filter=lfs\n')
    await repo.write('.gitignore', 'ignored.log\n')
    await repo.write('conflict.txt', 'base\n')
    await repo.write('data.bin', 'pointer\n')
    if (UNIX)
      await symlink('conflict.txt', join(repo.dir, 'link'))
    const head = await repo.commitAll()
    await repo.git(['update-index', '--add', '--cacheinfo', `160000,${head},sub`])
    await repo.git(['commit', '-q', '--no-verify', '-m', 'gitlink'])
    await repo.git(['checkout', '-q', '-b', 'other'])
    await repo.write('conflict.txt', 'other\n')
    await repo.commitAll('other')
    await repo.git(['checkout', '-q', 'main'])
    await repo.write('conflict.txt', 'main\n')
    await repo.commitAll('main')
    await expect(repo.git(['merge', '-q', 'other'])).rejects.toThrow()
    await repo.write('data.bin', 'changed\n')
    await repo.write('ignored.log', 'log\n')

    const refused = ['conflict.txt', 'sub', 'data.bin', 'ignored.log', ...(UNIX ? ['link'] : [])]
    for (const path of refused) {
      const answer = await revert(h, path)
      expect(answer.status, path).toBe(400)
      expect(errorOf(answer.body), path).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    }
    expect(await h.read('data.bin')).toBe('changed\n')
    expect(await h.read('ignored.log')).toBe('log\n')
    expect(await journal(h, 'revert')).toEqual([])
  })

  it('409 stale for another disk state; a missing file never at HEAD is unchanged', async () => {
    const { h, repo } = await openRepo()
    await repo.write('a.txt', 'head\n')
    await repo.commitAll()
    await repo.write('a.txt', 'changed\n')
    const stale = await revert(h, 'a.txt', { expectedSha: sha256Hex('something else\n') })
    expect(stale.status).toBe(409)
    expect(errorOf(stale.body).details).toEqual({ reason: 'stale' })
    expect(await h.read('a.txt')).toBe('changed\n')
    expect((await revert(h, 'nothing.txt')).body).toEqual({ batchId: null, restored: [], deleted: [], unchanged: ['nothing.txt'], skipped: [] })
  })

  it('a project that is not in a repository: 400 on source', async () => {
    const h = await open()
    await h.disk('a.txt', 'x\n')
    const answer = await revert(h, 'a.txt')
    expect(answer.status).toBe(400)
    expect(errorOf(answer.body)).toMatchObject({ code: 'validation_error', message: 'The Git view is not available: the project folder is not inside a git repository.', details: { issues: [{ path: ['source'] }] } })
  })
})

// ---------- the real checkpoint service ----------

describe('the real checkpoint service: journaled agent writes -> rewind -> undo -> revert', () => {
  it('restores what the journal recorded, through the routes', async () => {
    const rootsDir = await tempFolder()
    const root = join(rootsDir, 'demo')
    await mkdir(root)
    const events = createRecordingEventBus()
    const t = await createTestApp({ workspaceRoots: [rootsDir], overrides: { events } })
    cleanups.push(() => t.close())
    await t.db.insert(projects).values({ id: PROJECT, name: 'Demo', path: root, createdAt: 1, updatedAt: 1 })
    await t.db.insert(chats).values({ id: CHAT, projectId: PROJECT })
    let seq = 0
    const message = async (id: string, role: 'user' | 'assistant') => {
      seq += 1
      await t.db.insert(messages).values({ id, chatId: CHAT, seq, role, parts: [{ type: 'text', text: role }] })
    }
    const write = async (messageId: string, path: string, content: string) => {
      const journal = t.deps.checkpoints.journal({ chatId: CHAT, messageId, projectId: PROJECT })
      const resolved = await resolveWorkspacePath(root, path, { allowMissing: true })
      const result = await journal.write({ toolCallId: 'call_1', tool: 'write_file', root, resolved, produce: () => content, signal: new AbortController().signal })
      expect(result.recorded).toBe(true)
    }
    const send = async (method: string, path: string, body?: unknown) => {
      const response = await t.request(`/api${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json() as any }
    }
    const content = async () => (existsSync(join(root, 'a.txt')) ? readFile(join(root, 'a.txt'), 'utf8') : null)

    await message('msg_ROUNDTRIP0000001', 'user')
    await message('msg_ROUNDTRIP0000002', 'assistant')
    await write('msg_ROUNDTRIP0000002', 'a.txt', 'Turn 1\n')
    await message('msg_ROUNDTRIP0000003', 'user')
    await message('msg_ROUNDTRIP0000004', 'assistant')
    await write('msg_ROUNDTRIP0000004', 'a.txt', 'Turn 2\n')

    const preview = await send('GET', `/chats/${CHAT}/rewind?messageId=msg_ROUNDTRIP0000003`)
    expect(preview.body.files).toEqual([{ path: 'a.txt', action: 'restore', conflict: false, edits: 1 }])
    const rewound = await send('POST', `/chats/${CHAT}/rewind`, { messageId: 'msg_ROUNDTRIP0000003', conflicts: 'skip' })
    expect(rewound.body).toMatchObject({ restored: ['a.txt'], skipped: [] })
    expect(await content()).toBe('Turn 1\n')
    expect(events.ofType('workspace.changed').filter(event => event.data.source === 'rewind').map(event => event.data.batchId)).toEqual([rewound.body.batchId])

    expect((await send('POST', `/chats/${CHAT}/changes/undo`, { batchId: rewound.body.batchId, conflicts: 'skip' })).body).toMatchObject({ restored: ['a.txt'] })
    expect(await content()).toBe('Turn 2\n')

    expect((await send('POST', `/chats/${CHAT}/rewind`, { messageId: 'msg_ROUNDTRIP0000001', conflicts: 'skip' })).body).toMatchObject({ deleted: ['a.txt'] })
    expect(await content()).toBeNull()

    const reverted = await send('POST', `/chats/${CHAT}/changes/revert`, { source: 'chat', path: 'a.txt', expectedSha: null })
    expect(reverted).toMatchObject({ status: 200, body: { unchanged: ['a.txt'], batchId: null } })
    expect((await t.deps.checkpoints.summary()).blobs).toBeGreaterThan(0)
  })
})
