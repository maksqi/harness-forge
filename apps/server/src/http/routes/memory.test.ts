// `POST /memory` (W10.6-T1, ADR-047, API.md 5.29) over the real projects, chats, settings and checkpoint services:
// the project file choice (AGENTS.md, else CLAUDE.md, else a new AGENTS.md), links and caps, the change journal (the
// append is listed, revertible and announced), the instruction targets and their cap, the text cleaning, the chat
// checks, and that the text is never logged. Project folders are real temp folders inside a temp workspace root.
import type { RememberResult } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { chatChangesSchema, harnessErrorEnvelopeSchema, LIMITS, rememberResultSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chats, projects, workspaceChanges } from '../../db/schema.ts'
import { appendInstructionLine, cleanRememberText, REMEMBER_CALL_PREFIX, REMEMBER_NO_PROJECT_MESSAGE, REMEMBER_TOOL } from '../../services/customizations/memory.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'

const CHAT = '0199a8f0-0000-7000-8000-0000000000e1'
const PLAIN_CHAT = '0199a8f0-0000-7000-8000-0000000000e2'
const UNKNOWN_CHAT = '0199a8f0-0000-7000-8000-0000000000e9'
const PROJECT = 'prj_REMEMBER00000001'
const UNIX = process.platform !== 'win32'
/** A text that must never reach a log record. */
const SECRET_TEXT = 'Remember-sentinel-q81 run pnpm test before committing'

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

interface Harness {
  t: TestApp
  events: RecordingEventBus
  /** The project folder (canonical). */
  root: string
  /** The folder holding the project folder (outside it: link targets go here). */
  rootsDir: string
  send: (body: unknown) => Promise<{ status: number, body: any }>
  read: (name: string) => Promise<string | null>
}

async function open(): Promise<Harness> {
  const rootsDir = await tempFolder()
  const root = join(rootsDir, 'demo')
  await mkdir(root)
  const events = createRecordingEventBus()
  const t = await createTestApp({ workspaceRoots: [rootsDir], overrides: { events } })
  cleanups.push(() => t.close())
  await t.db.insert(projects).values({ id: PROJECT, name: 'Demo', path: root, createdAt: 1, updatedAt: 1 })
  await t.db.insert(chats).values({ id: CHAT, projectId: PROJECT })
  await t.db.insert(chats).values({ id: PLAIN_CHAT })
  const send: Harness['send'] = async (body) => {
    const response = await t.request('/api/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as any }
  }
  const read: Harness['read'] = async name => (existsSync(join(root, name)) ? readFile(join(root, name), 'utf8') : null)
  return { t, events, root, rootsDir, send, read }
}

function ok(response: { status: number, body: unknown }): RememberResult {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return rememberResultSchema.parse(response.body)
}

function error(response: { status: number, body: unknown }): { code: string, message: string, details?: unknown } {
  return harnessErrorEnvelopeSchema.parse(response.body).error
}

describe('pOST /memory: project-file', () => {
  it('appends to CLAUDE.md when only it exists, through the journal (listed, announced, revertible)', async () => {
    const h = await open()
    await writeFile(join(h.root, 'CLAUDE.md'), '# Notes\n\nUse tabs.')
    const result = ok(await h.send({ target: 'project-file', text: 'Run pnpm test before committing.', chatId: CHAT }))
    expect(result).toMatchObject({ target: 'project-file', file: 'CLAUDE.md', created: false, project: { id: PROJECT, instructionsFile: 'CLAUDE.md' } })
    // A newline first (the file did not end with one), then the line.
    expect(await h.read('CLAUDE.md')).toBe('# Notes\n\nUse tabs.\n- Run pnpm test before committing.\n')
    expect(await h.read('AGENTS.md')).toBeNull()

    const rows = await h.t.db.select().from(workspaceChanges).where(eq(workspaceChanges.chatId, CHAT))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'edit', tool: REMEMBER_TOOL, path: 'CLAUDE.md', messageId: null, projectId: PROJECT, beforeState: 'stored' })
    expect(rows[0]!.toolCallId).toMatch(new RegExp(`^${REMEMBER_CALL_PREFIX}[\\da-f]{16}$`))

    const listed = chatChangesSchema.parse(await (await h.t.request(`/api/chats/${CHAT}/changes`)).json())
    expect(listed.files.map(file => [file.path, file.status, file.revertible])).toEqual([['CLAUDE.md', 'modified', true]])

    // The journal announces the edit (coalesced, source `tool`).
    await vi.waitFor(() => expect(h.events.ofType('workspace.changed').map(event => event.data)).toEqual([
      { projectId: PROJECT, chatId: CHAT, batchId: null, source: 'tool', paths: ['CLAUDE.md'] },
    ]), { timeout: 1900, interval: 20 })

    const revert = await h.t.request(`/api/chats/${CHAT}/changes/revert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'chat', path: 'CLAUDE.md' }) })
    expect(revert.status).toBe(200)
    expect(await h.read('CLAUDE.md')).toBe('# Notes\n\nUse tabs.')
  })

  it('creates AGENTS.md when neither file exists, and prefers AGENTS.md when both do', async () => {
    const h = await open()
    const created = ok(await h.send({ target: 'project-file', text: 'First note', chatId: CHAT }))
    expect(created).toMatchObject({ file: 'AGENTS.md', created: true, project: { instructionsFile: 'AGENTS.md' } })
    expect(await h.read('AGENTS.md')).toBe('- First note\n')
    const rows = await h.t.db.select().from(workspaceChanges).where(eq(workspaceChanges.chatId, CHAT))
    expect(rows.map(row => [row.path, row.beforeState])).toEqual([['AGENTS.md', 'missing']])

    await writeFile(join(h.root, 'CLAUDE.md'), 'claude\n')
    const second = ok(await h.send({ target: 'project-file', text: 'Second note', chatId: CHAT }))
    expect(second).toMatchObject({ file: 'AGENTS.md', created: false })
    expect(await h.read('AGENTS.md')).toBe('- First note\n- Second note\n')
    expect(await h.read('CLAUDE.md')).toBe('claude\n')

    // Reverting a created file deletes it.
    const revert = await h.t.request(`/api/chats/${CHAT}/changes/revert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'chat', path: 'AGENTS.md' }) })
    expect(revert.status).toBe(200)
    expect(await h.read('AGENTS.md')).toBeNull()
  })

  it.skipIf(!UNIX)('refuses a linked AGENTS.md (400) without falling back or touching the target', async () => {
    const h = await open()
    const outside = join(h.rootsDir, 'outside.md')
    await writeFile(outside, 'outside\n')
    await symlink(outside, join(h.root, 'AGENTS.md'))
    await writeFile(join(h.root, 'CLAUDE.md'), 'claude\n')
    const response = await h.send({ target: 'project-file', text: 'Note', chatId: CHAT })
    expect(response.status).toBe(400)
    expect(error(response)).toMatchObject({ code: 'validation_error', message: 'AGENTS.md is a symbolic link: Remember never writes through a link.' })
    expect(await readFile(outside, 'utf8')).toBe('outside\n')
    expect(await h.read('CLAUDE.md')).toBe('claude\n')

    // A link that stays inside the project is refused too.
    await rm(join(h.root, 'AGENTS.md'))
    await rm(join(h.root, 'CLAUDE.md'))
    await writeFile(join(h.root, 'notes.md'), 'notes\n')
    await symlink('notes.md', join(h.root, 'CLAUDE.md'))
    expect((await h.send({ target: 'project-file', text: 'Note', chatId: CHAT })).status).toBe(400)
    expect(await h.read('notes.md')).toBe('notes\n')
    expect(await h.t.db.select().from(workspaceChanges)).toEqual([])
  })

  it('refuses a folder named AGENTS.md and a binary file (400)', async () => {
    const h = await open()
    await mkdir(join(h.root, 'AGENTS.md'))
    expect(error(await h.send({ target: 'project-file', text: 'Note', chatId: CHAT }))).toMatchObject({ code: 'validation_error', message: 'AGENTS.md is not a regular file.' })
    await rm(join(h.root, 'AGENTS.md'), { recursive: true })
    await writeFile(join(h.root, 'AGENTS.md'), Buffer.from([0x41, 0x00, 0x42]))
    expect(error(await h.send({ target: 'project-file', text: 'Note', chatId: CHAT }))).toMatchObject({ code: 'validation_error', message: 'AGENTS.md is not a text file.' })
  })

  it('answers 413 when the file would pass 1 MiB, and leaves it unchanged', async () => {
    const h = await open()
    const line = '- Note\n'
    const fits = 'x'.repeat(LIMITS.rememberFileMaxBytes - Buffer.byteLength(line) - 1)
    await writeFile(join(h.root, 'AGENTS.md'), `${fits}\n`)
    // Exactly the cap fits.
    ok(await h.send({ target: 'project-file', text: 'Note', chatId: CHAT }))
    expect(Buffer.byteLength((await h.read('AGENTS.md'))!)).toBe(LIMITS.rememberFileMaxBytes)
    const before = await h.read('AGENTS.md')
    const response = await h.send({ target: 'project-file', text: 'N', chatId: CHAT })
    expect(response.status).toBe(413)
    expect(error(response)).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.rememberFileMaxBytes } })
    expect(await h.read('AGENTS.md')).toBe(before)
  })

  it('answers 400 when the project folder is not available', async () => {
    const h = await open()
    await rm(h.root, { recursive: true })
    const response = await h.send({ target: 'project-file', text: 'Note', chatId: CHAT })
    expect(response.status).toBe(400)
    expect(error(response).code).toBe('validation_error')
  })
})

describe('pOST /memory: instruction targets', () => {
  it('appends to the project instructions (project.changed) and refuses more than 20 000 characters', async () => {
    const h = await open()
    const first = ok(await h.send({ target: 'project-instructions', text: 'Prefer small diffs.', chatId: CHAT }))
    expect(first).toMatchObject({ target: 'project-instructions', project: { id: PROJECT, instructions: '- Prefer small diffs.' } })
    const second = ok(await h.send({ target: 'project-instructions', text: 'Write tests.', chatId: CHAT }))
    expect(second.project?.instructions).toBe('- Prefer small diffs.\n- Write tests.')
    expect(h.events.ofType('project.changed').map(event => event.data.project?.instructions)).toEqual(['- Prefer small diffs.', '- Prefer small diffs.\n- Write tests.'])

    const full = 'y'.repeat(LIMITS.instructionsMaxChars - 10)
    await h.t.db.update(projects).set({ instructions: full }).where(eq(projects.id, PROJECT))
    const response = await h.send({ target: 'project-instructions', text: 'One more line', chatId: CHAT })
    expect(response.status).toBe(400)
    expect(error(response)).toMatchObject({ code: 'validation_error', details: { issues: [expect.objectContaining({ path: ['text'] })] } })
    expect((await h.t.deps.projects.get(PROJECT)).instructions).toBe(full)
    // Nothing touched the folder.
    expect(await h.read('AGENTS.md')).toBeNull()
  })

  it('appends to the global instructions and refuses more than 20 000 characters', async () => {
    const h = await open()
    await h.t.deps.settings.update({ instructions: 'Be brief.\n' })
    const result = ok(await h.send({ target: 'global', text: 'Answer in English.' }))
    expect(result).toMatchObject({ target: 'global', settings: { instructions: 'Be brief.\n- Answer in English.' } })
    expect((await h.t.deps.settings.get()).instructions).toBe('Be brief.\n- Answer in English.')
    // A chat id is not needed (and not checked) for the global target.
    ok(await h.send({ target: 'global', text: 'Third.', chatId: PLAIN_CHAT }))
    expect((await h.t.deps.settings.get()).instructions).toBe('Be brief.\n- Answer in English.\n- Third.')

    await h.t.deps.settings.update({ instructions: 'z'.repeat(LIMITS.instructionsMaxChars - 3) })
    const response = await h.send({ target: 'global', text: 'Too long' })
    expect(response.status).toBe(400)
    expect(error(response).code).toBe('validation_error')
    expect((await h.t.deps.settings.get()).instructions).toHaveLength(LIMITS.instructionsMaxChars - 3)
  })
})

describe('pOST /memory: validation, chats and logs', () => {
  it('needs the chat of a project for the project targets (400 / 404) and validates the body', async () => {
    const h = await open()
    for (const target of ['project-file', 'project-instructions']) {
      const plain = await h.send({ target, text: 'Note', chatId: PLAIN_CHAT })
      expect(plain.status).toBe(400)
      expect(error(plain)).toMatchObject({ code: 'validation_error', message: REMEMBER_NO_PROJECT_MESSAGE, details: { issues: [expect.objectContaining({ path: ['chatId'] })] } })
      const missing = await h.send({ target, text: 'Note' })
      expect(missing.status).toBe(400)
      expect(error(missing)).toMatchObject({ details: { issues: [expect.objectContaining({ path: ['chatId'] })] } })
      const unknown = await h.send({ target, text: 'Note', chatId: UNKNOWN_CHAT })
      expect(unknown.status).toBe(404)
      expect(error(unknown).code).toBe('not_found')
    }
    for (const body of [
      { target: 'project-file', text: '', chatId: CHAT },
      { target: 'project-file', text: '   ', chatId: CHAT },
      { target: 'project-file', text: 'x'.repeat(LIMITS.rememberTextMaxChars + 1), chatId: CHAT },
      { target: 'project', text: 'Note', chatId: CHAT },
      { target: 'global', text: 'Note', extra: true },
      { target: 'global', text: '\u0007\u0008' },
    ])
      expect((await h.send(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400)
    expect(await h.read('AGENTS.md')).toBeNull()
    expect(await h.t.db.select().from(workspaceChanges)).toEqual([])
  })

  it('removes control characters except line breaks', async () => {
    const h = await open()
    ok(await h.send({ target: 'project-file', text: 'Use\u0007 pnpm\u202E\r\nnot npm\u0000', chatId: CHAT }))
    expect(await h.read('AGENTS.md')).toBe('- Use pnpm\nnot npm\n')
    expect(cleanRememberText('  a\tb\u2028c d\re\u009F ')).toBe('abc d\ne')
    expect(cleanRememberText('x\uD800y')).toBe('x\uFFFDy')
    expect(appendInstructionLine(null, '- a')).toBe('- a')
    expect(appendInstructionLine('b', '- a')).toBe('b\n- a')
    expect(appendInstructionLine('b\n', '- a')).toBe('b\n- a')
  })

  it('never logs the text', async () => {
    const h = await open()
    ok(await h.send({ target: 'project-file', text: SECRET_TEXT, chatId: CHAT }))
    ok(await h.send({ target: 'project-instructions', text: SECRET_TEXT, chatId: CHAT }))
    ok(await h.send({ target: 'global', text: SECRET_TEXT }))
    expect(h.t.logs.text()).not.toContain('Remember-sentinel-q81')
    const saved = h.t.logs.records.filter(record => record.msg === 'remember saved')
    expect(saved.map(record => [record.level, record.target])).toEqual([['info', 'project-file'], ['info', 'project-instructions'], ['info', 'global']])
    expect(saved[0]).toMatchObject({ file: 'AGENTS.md', created: true, chars: SECRET_TEXT.length })
  })
})
