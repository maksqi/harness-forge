// The output style of a run (W11.6-T4, ADR-051): the name (chat > project row > global setting), the builtins straight
// from `core-agent`, catalog styles loaded again (a project file, a personal row, a plugin style), the fallback to
// `default` with the notice `output-style-unavailable` once per model (`alreadyNoticed`), an unreadable project row or
// body, the abort, and the logs (never a style body). The catalog is the C36 fake (`createFakeCustomizationService`).
// End to end (the real catalog over a project folder, `mock:hooks` `style?`): the block first, `.harness` over `.claude`,
// keep = false drops the workspace rules and the todo hint, the global setting, and the notice once per model.
import type { HarnessUIMessage, ProjectSummary } from '@harness-forge/shared'
import type { ChatRecord } from '../services/chats/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { AppDeps } from '../types.ts'
import type { OutputStyleInput } from './output-style.ts'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HarnessError, settingsSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUILTIN_STYLE_DEFINITIONS } from '../builtin-plugins/core-agent/styles.ts'
import { createMemoryLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { catalogEntryKey, createFakeCustomizationService, fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { NOTICES } from './notices.ts'
import { builtinRunOutputStyle, DEFAULT_RUN_OUTPUT_STYLE, resolveRunOutputStyle } from './output-style.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from './testing.ts'

const PROJECT = 'prj_AAAAAAAAAAAAAAAA'
const MODEL = 'mock:echo'

const TERSE = fakeCatalogEntry('style', 'terse', { label: 'Terse', path: '.harness/output-styles/terse.md' })
const PLAIN = fakeCatalogEntry('style', 'plain', { path: '.claude/output-styles/plain.md' })
const PIRATE = fakeCatalogEntry('style', 'pirate', { source: 'plugin', pluginId: 'acme' })
const GONE = fakeCatalogEntry('style', 'gone', { path: '.harness/output-styles/gone.md' })

function chat(outputStyle?: string, projectId: string | null = PROJECT): ChatRecord {
  return {
    id: testChatId(1),
    title: null,
    titleSource: null,
    modelRef: MODEL,
    settings: { toolMode: 'ask', reasoningEffort: 'auto', ...(outputStyle === undefined ? {} : { outputStyle }) },
    pinned: false,
    archived: false,
    pendingApproval: false,
    activeLeafId: null,
    projectId,
    createdAt: 1,
    updatedAt: 1,
  }
}

interface Setup {
  input: (overrides?: Partial<OutputStyleInput>) => OutputStyleInput
  /** Project ids read through `projects.get`. */
  projectReads: string[]
  logs: () => string
  fake: ReturnType<typeof createFakeCustomizationService>
}

async function setup(options: { projectStyle?: string | null, projectError?: unknown, global?: string } = {}): Promise<Setup> {
  const fake = createFakeCustomizationService({
    entries: { [PROJECT]: [TERSE, PLAIN, GONE], '': [PIRATE] },
    bodies: {
      [catalogEntryKey(TERSE)]: '---\nname: Terse\ndescription: Short answers.\nkeep-coding-instructions: true\n---\nTERSE-BODY: answer in three lines.\n',
      [catalogEntryKey(PLAIN)]: '---\nname: plain\ndescription: Plain prose.\n---\nPLAIN-BODY\n',
      [catalogEntryKey(PIRATE)]: { kind: 'style', fields: { name: 'pirate', label: 'pirate', description: 'Arr.', keepCodingInstructions: false, content: 'PIRATE-BODY' } },
    },
  })
  const projectReads: string[] = []
  const projects = {
    get: async (id: string): Promise<ProjectSummary> => {
      projectReads.push(id)
      if (options.projectError !== undefined)
        throw options.projectError
      return { id, name: 'Demo', path: '/w/demo', instructions: null, available: false, issue: 'Gone.', instructionsFile: null, chatCount: 1, outputStyle: options.projectStyle ?? null, createdAt: 1, updatedAt: 1 }
    },
  }
  const memory = createMemoryLogger()
  const catalog = await fake.catalog(PROJECT)
  const settings = settingsSchema.parse(options.global === undefined ? {} : { outputStyle: options.global })
  return {
    fake,
    projectReads,
    logs: memory.text,
    input: overrides => ({
      deps: { projects, customizations: fake } as unknown as Pick<AppDeps, 'projects' | 'customizations'>,
      catalog,
      chat: chat(),
      settings,
      history: [],
      modelRef: MODEL,
      signal: new AbortController().signal,
      logger: memory.logger,
      ...overrides,
    }),
  }
}

/** An earlier reply of `modelRef` that showed `notice`. */
function noticedReply(modelRef: string, name: string): HarnessUIMessage {
  return { id: 'msg_AAAAAAAAAAAAAAAAAAAAAA', role: 'assistant', metadata: { modelRef }, parts: [{ type: 'data-notice', data: NOTICES.outputStyleUnavailable(name) }] } as HarnessUIMessage
}

describe('resolveRunOutputStyle', () => {
  it('uses the global setting, the project row over it and the chat over both', async () => {
    const global = await setup({ global: 'explanatory' })
    const globalStyle = await resolveRunOutputStyle(global.input({ chat: chat(undefined, null) }))
    expect(globalStyle.style).toMatchObject({ name: 'explanatory', label: 'Explanatory', keepCodingInstructions: true })
    expect(globalStyle.style.content).toBe(BUILTIN_STYLE_DEFINITIONS[1]!.content)
    expect(globalStyle.notices).toEqual([])
    // A chat without a project never reads a project row.
    expect(global.projectReads).toEqual([])

    const project = await setup({ projectStyle: 'terse', global: 'explanatory' })
    const projectStyle = await resolveRunOutputStyle(project.input())
    expect(projectStyle).toEqual({ style: { name: 'terse', label: 'Terse', content: 'TERSE-BODY: answer in three lines.', keepCodingInstructions: true }, notices: [] })
    // The row decides, even while the folder is unavailable.
    expect(project.projectReads).toEqual([PROJECT])

    const own = await resolveRunOutputStyle(project.input({ chat: chat('plain') }))
    expect(own).toEqual({ style: { name: 'plain', label: 'plain', content: 'PLAIN-BODY', keepCodingInstructions: false }, notices: [] })
    // The chat's own choice needs no project read.
    expect(project.projectReads).toEqual([PROJECT])
    // A chat that chose `default` gets no block, whatever the project says.
    expect((await resolveRunOutputStyle(project.input({ chat: chat('default') }))).style).toBe(DEFAULT_RUN_OUTPUT_STYLE)
  })

  it('answers default without any choice; builtins never touch the catalog', async () => {
    const s = await setup()
    expect(await resolveRunOutputStyle(s.input())).toEqual({ style: DEFAULT_RUN_OUTPUT_STYLE, notices: [] })
    const learning = await resolveRunOutputStyle(s.input({ chat: chat('learning') }))
    expect(learning.style).toMatchObject({ name: 'learning', label: 'Learning', keepCodingInstructions: true })
    expect(learning.style.content).toContain('Learn by doing:')
    expect(s.fake.calls.load).toBe(0)
    expect(builtinRunOutputStyle('default')).toBe(DEFAULT_RUN_OUTPUT_STYLE)
    expect(builtinRunOutputStyle('terse')).toBeNull()
  })

  it('loads a plugin style through the catalog', async () => {
    const s = await setup({ global: 'pirate' })
    expect(await resolveRunOutputStyle(s.input({ chat: chat(undefined, null) }))).toEqual({
      style: { name: 'pirate', label: 'pirate', content: 'PIRATE-BODY', keepCodingInstructions: false },
      notices: [],
    })
    expect(s.fake.calls.load).toBe(1)
  })

  it('falls back to default with the notice for an unknown, turned-off or unreadable style, once per model', async () => {
    const s = await setup({ projectStyle: 'missing' })
    const unknown = await resolveRunOutputStyle(s.input())
    expect(unknown).toEqual({ style: DEFAULT_RUN_OUTPUT_STYLE, notices: [NOTICES.outputStyleUnavailable('missing')] })
    expect(unknown.notices[0]!.message).toBe('The output style "missing" is not available, so the default style was used.')
    // Shown once per chat path and model: an earlier reply of the same model already has it.
    expect((await resolveRunOutputStyle(s.input({ history: [noticedReply(MODEL, 'missing')] }))).notices).toEqual([])
    expect((await resolveRunOutputStyle(s.input({ history: [noticedReply('mock:other', 'missing')] }))).notices).toHaveLength(1)
    expect((await resolveRunOutputStyle(s.input({ history: [noticedReply(MODEL, 'other')] }))).notices).toHaveLength(1)

    // The entry is listed but its body is gone (the load fails).
    const gone = await resolveRunOutputStyle(s.input({ chat: chat('gone') }))
    expect(gone).toEqual({ style: DEFAULT_RUN_OUTPUT_STYLE, notices: [NOTICES.outputStyleUnavailable('gone')] })

    // A turned-off personal style is not active.
    const personal = await s.fake.create({ kind: 'style', content: '---\nname: quiet\ndescription: Quiet.\n---\nQUIET-BODY\n', enabled: false })
    expect(personal.enabled).toBe(false)
    const off = await resolveRunOutputStyle(s.input({ catalog: await s.fake.catalog(PROJECT), chat: chat('quiet') }))
    expect(off.notices.map(notice => notice.code)).toEqual(['output-style-unavailable'])
    await s.fake.update(personal.id, { enabled: true })
    const on = await resolveRunOutputStyle(s.input({ catalog: await s.fake.catalog(PROJECT), chat: chat('quiet') }))
    expect(on).toEqual({ style: { name: 'quiet', label: 'quiet', content: 'QUIET-BODY', keepCodingInstructions: false }, notices: [] })
  })

  it('a missing project or a failed project read counts as no choice (the global setting applies)', async () => {
    const missing = await setup({ projectError: new HarnessError({ code: 'not_found', message: 'Project gone.' }), global: 'learning' })
    expect((await resolveRunOutputStyle(missing.input())).style.name).toBe('learning')
    expect(missing.logs()).not.toContain('project not read')
    const failing = await setup({ projectError: new Error('database is locked'), global: 'learning' })
    expect((await resolveRunOutputStyle(failing.input())).style.name).toBe('learning')
    expect(failing.logs()).toContain('output style: project not read')
  })

  it('rejects only on an abort', async () => {
    const s = await setup({ projectStyle: 'terse' })
    const controller = new AbortController()
    controller.abort()
    await expect(resolveRunOutputStyle(s.input({ signal: controller.signal }))).rejects.toBeDefined()
    // An abort during the body load rejects too.
    const loading = new AbortController()
    const deps = s.input().deps
    const slow = {
      ...deps,
      customizations: {
        ...s.fake,
        load: async () => {
          loading.abort()
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        },
      },
    } as unknown as OutputStyleInput['deps']
    await expect(resolveRunOutputStyle(s.input({ deps: slow, signal: loading.signal }))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('tolerates a partial input (no chat settings, no settings) and never logs a style body', async () => {
    const s = await setup({ projectStyle: 'terse' })
    const partial = { ...s.input(), chat: {} as ChatRecord, settings: {} as OutputStyleInput['settings'] }
    expect(await resolveRunOutputStyle(partial)).toEqual({ style: DEFAULT_RUN_OUTPUT_STYLE, notices: [] })
    await resolveRunOutputStyle(s.input())
    await resolveRunOutputStyle(s.input({ chat: chat('plain') }))
    expect(s.logs()).toContain('output style loaded')
    expect(s.logs()).not.toMatch(/TERSE-BODY|PLAIN-BODY|Short answers/)
  })
})

describe('output styles in a run (mock:hooks style?)', () => {
  let t: TestApp
  let base: string
  let project: ProjectSummary

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, workspaceRoots: [base] })
    project = await t.deps.projects.create({ name: 'Styles', path: base, newFolder: 'styles' })
    const files: Record<string, string> = {
      '.claude/output-styles/terse.md': '---\nname: Terse\ndescription: The claude copy.\nkeep-coding-instructions: true\n---\nCLAUDE-TERSE\n',
      '.harness/output-styles/terse.md': '---\nname: terse\ndescription: The harness copy.\n---\nHARNESS-TERSE\n',
    }
    for (const [rel, content] of Object.entries(files)) {
      const path = join(base, 'styles', rel)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
  })

  afterAll(async () => {
    await t.close()
    await rm(base, { recursive: true, force: true })
  })

  async function ask(chatId: string, overrides: Parameters<typeof chatBody>[2] = {}): Promise<{ text: string, notices: string[] }> {
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'style?', { modelRef: 'mock:hooks', toolMode: 'edits', projectId: project.id, ...overrides })))
    await runnerOf(t).idle()
    const notices = chunks.flatMap(chunk => (chunk.type === 'data-notice' ? [(chunk.data as { code: string }).code] : []))
    return { text: streamedText(chunks), notices }
  }

  it('the chat style: the .harness file wins, its block first; keep = false drops the workspace rules and the todo hint', async () => {
    expect(await ask(testChatId(0xD001), { outputStyle: 'terse' })).toEqual({ text: 'Style: terse | workspace-rules: no | todo-hint: no', notices: [] })
    // Without a choice: the global `default`, nothing in front.
    expect((await ask(testChatId(0xD002))).text).toBe('Style: none | workspace-rules: yes | todo-hint: yes')
  })

  it('the global setting applies to chats without a choice; a builtin keeps the coding instructions', async () => {
    await t.deps.settings.update({ outputStyle: 'learning' })
    try {
      expect((await ask(testChatId(0xD003))).text).toBe('Style: Learning | workspace-rules: yes | todo-hint: yes')
      // The chat's own choice wins over the setting.
      expect((await ask(testChatId(0xD004), { outputStyle: 'default' })).text).toBe('Style: none | workspace-rules: yes | todo-hint: yes')
    }
    finally {
      await t.deps.settings.update({ outputStyle: 'default' })
    }
  })

  it('an unknown style falls back to default with the notice, shown once per model on the chat path', async () => {
    const chatId = testChatId(0xD005)
    const first = await ask(chatId, { outputStyle: 'missing' })
    expect(first).toEqual({ text: 'Style: none | workspace-rules: yes | todo-hint: yes', notices: ['output-style-unavailable'] })
    // The next turn of the same chat (it keeps its style): the reply of the same model already shows the notice.
    expect(await ask(chatId)).toEqual({ text: 'Style: none | workspace-rules: yes | todo-hint: yes', notices: [] })
    // Another model on the same path is told once.
    expect((await ask(chatId, { modelRef: 'mock:agents' })).notices).toEqual(['output-style-unavailable'])
  })
})
