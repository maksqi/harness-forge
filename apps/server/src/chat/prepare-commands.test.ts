// `prepareRun` with the Phase 11 command extras and call sites (W11.5-T1, T4, T6): the expansion host of a new message
// (the project folder opened at most once per turn, reused by the run), the expansion frozen in `metadata.command`
// (`kind`, `inlined`) so a regenerate never runs a span again and a v1.6 stored expansion is reused as stored, a refused
// first message (409 `untrusted`) that leaves no chat row, the output style notices appended once, and the texts of the
// three Phase 11 notices. Real shells in a `realpath(mkdtemp())` project (POSIX `sh` only; skipped on Windows); the
// catalog, the trust service and the hooks are fakes.
import type { ChatRequestBody, HarnessUIMessage } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { FakeProjectTrustService } from '../testing/fake-project-trust.ts'
import type { PreparedRun } from './prepare.ts'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createMessageId, LIMITS, planCommandExpansion } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { commandTrustSubject } from '../services/project-config/index.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { catalogEntryKey, fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { killLiveShellGroups } from '../workspace/shell.ts'
import { applyCommandExpansions } from './context.ts'
import { NOTICES } from './notices.ts'
import { resolveRunOutputStyle } from './output-style.ts'
import { commitHistory, prepareRun } from './prepare.ts'
import { createRunRegistry } from './runs.ts'
import { chatBody, testChatId } from './testing.ts'

vi.mock('./output-style.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./output-style.ts')>()
  return { ...actual, resolveRunOutputStyle: vi.fn(actual.resolveRunOutputStyle) }
})

const posix = process.platform !== 'win32'
let nextChat = 0xC000

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

describe.skipIf(!posix)('prepareRun: command extras (W11.5)', () => {
  let base: string
  let t: TestApp
  let projectId: string
  let projectRoot: string
  let opened: string[]

  async function prepare(body: ChatRequestBody): Promise<PreparedRun> {
    const run = createRunRegistry().acquire(body.chatId, body.modelRef)
    return prepareRun(t.deps, run, body, createSilentLogger())
  }

  async function prepareAndCommit(body: ChatRequestBody): Promise<PreparedRun> {
    const prepared = await prepare(body)
    await commitHistory(t.deps, body.chatId, prepared.writes)
    return prepared
  }

  async function counter(): Promise<string> {
    return readFile(join(projectRoot, 'counter.txt'), 'utf8').catch(() => '')
  }

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, workspaceRoots: [base], customizations: 'fake', projectTrust: 'fake', hooks: 'fake' })
    const project = await t.deps.projects.create({ name: 'Demo', path: base, newFolder: 'demo' })
    projectId = project.id
    projectRoot = await realpath(join(base, 'demo'))
    await mkdir(join(projectRoot, 'scripts'))
    await writeFile(join(projectRoot, 'scripts', 'count.sh'), 'echo run >> counter.txt\necho counted\n')
    await writeFile(join(projectRoot, 'README.md'), 'Hello readme\n')
    const fake = t.deps.customizations as FakeCustomizationService
    await fake.create({ kind: 'command', content: '---\nname: status\ndescription: Status.\n---\nStatus: !`sh scripts/count.sh`\nRead @README.md for $ARGUMENTS' })
    const deploy = fakeCatalogEntry('command', 'deploy', { source: 'project', path: '.harness/commands/deploy.md' })
    fake.entries.set(projectId, [deploy])
    fake.bodies.set(catalogEntryKey(deploy), '---\ndescription: Deploy.\n---\nDeploy: !`sh scripts/count.sh`')
    opened = []
    const openWorkspace = t.deps.projects.openWorkspace
    vi.spyOn(t.deps.projects, 'openWorkspace').mockImplementation(async (id) => {
      opened.push(id)
      return openWorkspace(id)
    })
  })

  afterAll(async () => {
    killLiveShellGroups()
    await t.close()
    await rm(base, { recursive: true, force: true })
  })

  it('freezes the expansion of a new message and opens the project folder once for the command and the run', async () => {
    const chatId = newChatId()
    opened.length = 0
    const prepared = await prepareAndCommit(chatBody(chatId, '/status now', { projectId }))
    expect(prepared.userMessage?.metadata?.command).toEqual({
      name: 'status',
      input: 'now',
      type: 'prompt',
      expansion: 'Status: counted\nRead @README.md for now\n\n<file path="README.md">\nHello readme\n</file>',
      source: 'user',
      kind: 'command',
      inlined: { shell: 1, files: ['README.md'] },
    })
    expect(prepared.workspace?.root).toBe(projectRoot)
    expect(opened).toEqual([projectId])
    expect(await counter()).toBe('run\n')

    // A regenerate reuses the stored expansion: the span never runs again.
    const user = prepared.userMessage!
    const again = await prepare({ ...chatBody(chatId, ''), trigger: 'regenerate-message', messageId: user.id, message: user })
    expect(again.kind).toBe('regenerate')
    expect(again.history.at(-1)?.metadata?.command).toEqual(user.metadata?.command)
    expect(applyCommandExpansions(again.history).at(-1)?.parts).toEqual([{ type: 'text', text: user.metadata!.command!.expansion }])
    expect(await counter()).toBe('run\n')
  })

  it('reuses a v1.6 stored /status expansion as stored (its spans stay text, nothing runs)', async () => {
    const chatId = newChatId()
    await prepareAndCommit(chatBody(chatId, 'first', { projectId }))
    const before = await counter()
    const stored: HarnessUIMessage = {
      id: createMessageId(),
      role: 'user',
      parts: [{ type: 'text', text: '/status now' }],
      metadata: { modelRef: 'mock:echo', startedAt: 1, command: { name: 'status', input: 'now', type: 'prompt', expansion: 'Status: !`sh scripts/count.sh`\nRead @README.md for now', source: 'user' } },
    }
    const chat = await t.deps.chats.find(chatId)
    await commitHistory(t.deps, chatId, { updates: [], append: { message: stored, parentId: chat!.activeLeafId }, activeLeafId: stored.id })
    const again = await prepare({ ...chatBody(chatId, ''), trigger: 'regenerate-message', messageId: stored.id, message: stored })
    expect(again.command).toBeNull()
    expect(applyCommandExpansions(again.history).at(-1)?.parts).toEqual([{ type: 'text', text: 'Status: !`sh scripts/count.sh`\nRead @README.md for now' }])
    expect(await counter()).toBe(before)
  })

  it('refuses an unapproved project command file (409 untrusted) without a chat row; runs it once approved', async () => {
    const fresh = newChatId()
    const refused = await prepare(chatBody(fresh, '/deploy', { projectId })).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'conflict', details: { reason: 'untrusted' } })
    expect(await t.deps.chats.find(fresh)).toBeNull()

    const existing = newChatId()
    await prepareAndCommit(chatBody(existing, 'first', { projectId }))
    await expect(prepare(chatBody(existing, '/deploy', { projectId }))).rejects.toMatchObject({ code: 'conflict', details: { reason: 'untrusted' } })
    expect(await t.deps.chats.find(existing)).not.toBeNull()

    const subject = await commandTrustSubject(projectRoot, 'deploy', planCommandExpansion('Deploy: !`sh scripts/count.sh`').shellCommands)
    await (t.deps.projectTrust as FakeProjectTrustService).approve(projectId, [{ kind: 'command', sha256: subject.sha256 }])
    const before = await counter()
    const approved = await prepare(chatBody(existing, '/deploy', { projectId }))
    expect(approved.userMessage?.metadata?.command).toMatchObject({ name: 'deploy', expansion: 'Deploy: counted', source: 'project', kind: 'command', inlined: { shell: 1, files: [] } })
    expect(await counter()).toBe(`${before}run\n`)
  })

  it('refuses spans in a chat without a project with a 400 on the message', async () => {
    await expect(prepare(chatBody(newChatId(), '/status now'))).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts'] }] } })
  })

  it('appends the output style notices once and resolves no style for a command reply', async () => {
    const mocked = vi.mocked(resolveRunOutputStyle)
    mocked.mockClear()
    const notice = NOTICES.outputStyleUnavailable('gone')
    mocked.mockImplementationOnce(async () => ({ style: { name: 'default', label: 'Default', content: '', keepCodingInstructions: true }, notices: [notice] }))
    const prepared = await prepare(chatBody(newChatId(), 'hi', { outputStyle: 'gone' }))
    expect(prepared.notices.filter(item => item.code === 'output-style-unavailable')).toEqual([notice])
    expect(prepared.chat.settings.outputStyle).toBe('gone')
    expect(mocked).toHaveBeenCalledTimes(1)
    const compact = await prepare(chatBody(newChatId(), '/compact'))
    expect(compact.outputStyle).toBeNull()
    expect(mocked).toHaveBeenCalledTimes(1)
  })

  it('the Phase 11 notices', () => {
    expect(NOTICES.outputStyleUnavailable('terse')).toEqual({ level: 'warning', code: 'output-style-unavailable', message: 'The output style "terse" is not available, so the default style was used.' })
    expect(NOTICES.hookContinuationLimit()).toEqual({ level: 'info', code: 'hook-continuation-limit', message: `Stopped after ${LIMITS.hookContinuationsMax} hook continuations in a row.` })
    expect(NOTICES.projectMcpUnavailable(['Docs'])).toEqual({ level: 'warning', code: 'project-mcp-unavailable', message: 'The project MCP server "Docs" is not ready, so its tools were not sent.' })
    expect(NOTICES.projectMcpUnavailable(['A', 'B']).message).toBe('2 project MCP servers are not ready ("A", "B"), so their tools were not sent.')
  })
})
