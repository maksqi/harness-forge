import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { CatalogModel, ChatDetail, ChatRequestBody, HarnessUIMessage, RunStartedData } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { ResolvedImageModel, ResolvedModel, ResolvedModelBase } from '../providers/types.ts'
import type { ChatEnsureInput, ChatRecord } from '../services/chats/types.ts'
import type { FilesService, StoredFile } from '../services/files/types.ts'
import type { OpenWorkspace, OpenWorkspaceResult } from '../services/projects/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { AppDeps } from '../types.ts'
import type { CommandResolution } from './commands.ts'
import type { PreparedRun, PrepareRunOptions, ResolvedTarget, RunTarget } from './prepare.ts'
import { chatDetailSchema, createMessageId, HarnessError, LIMITS } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { NOTICES } from './notices.ts'
import {
  checkImageOptions,
  commitHistory,
  ensureChat,
  generatedImageIds,
  imagePrompt,
  imageTurnInputs,
  openRunWorkspace,
  prepareRun,
  resolveTarget,
  resolveTurnModel,
  storedCommandModel,
} from './prepare.ts'
import { createRunRegistry } from './runs.ts'
import { answerApprovals, chatBody, nextEvent, postChat, readSse, runnerOf, streamedText, testChatId } from './testing.ts'

function row(id: string, mime: string): StoredFile {
  return { id, sha256: 'a'.repeat(64), name: `${id}.bin`, mime, size: 1, createdAt: 1 }
}

const rows = new Map<string, StoredFile>([
  ['file_png0000000000001', row('file_png0000000000001', 'image/png')],
  ['file_png0000000000002', row('file_png0000000000002', 'image/png')],
  ['file_png0000000000003', row('file_png0000000000003', 'image/jpeg')],
  ['file_png0000000000004', row('file_png0000000000004', 'image/webp')],
  ['file_png0000000000005', row('file_png0000000000005', 'image/gif')],
  ['file_svg0000000000001', row('file_svg0000000000001', 'image/svg+xml')],
  ['file_pdf0000000000001', row('file_pdf0000000000001', 'application/pdf')],
])

const files: Pick<FilesService, 'idFromUrl' | 'get'> = {
  idFromUrl: url => (url.startsWith('/api/files/') ? url.slice('/api/files/'.length) : null),
  get: async id => rows.get(id) ?? null,
}

function part(id: string, mediaType = rows.get(id)?.mime ?? 'image/png') {
  return { type: 'file' as const, mediaType, url: `/api/files/${id}` }
}

function model(vision: boolean): ResolvedModelBase {
  return { modelRef: 'prov:pix', providerId: 'prov', modelId: 'pix', entry: { capabilities: { vision } } } as unknown as ResolvedModelBase
}

function user(...parts: HarnessUIMessage['parts']): HarnessUIMessage {
  return { id: 'msg_u000000000000001', role: 'user', parts }
}

function reply(...parts: HarnessUIMessage['parts']): HarnessUIMessage {
  return { id: 'msg_a000000000000001', role: 'assistant', parts }
}

describe('checkImageOptions', () => {
  const chat = { ref: 'prov:chat', capabilities: { imageOutput: false } } as CatalogModel
  const painter = { ref: 'prov:painter', capabilities: { imageOutput: true } } as CatalogModel

  it('accepts no options, every option of an image model and the aspect ratio of an image-output model', () => {
    expect(() => checkImageOptions(undefined, 'chat', chat)).not.toThrow()
    expect(() => checkImageOptions({ n: 4, aspectRatio: '1:1', editPrevious: false }, 'image', chat)).not.toThrow()
    expect(() => checkImageOptions({ aspectRatio: '16:9' }, 'chat', painter)).not.toThrow()
    expect(() => checkImageOptions({}, 'chat', painter)).not.toThrow()
  })

  it('refuses everything else on imageOptions', () => {
    for (const [options, entry] of [[{}, chat], [{ aspectRatio: '1:1' }, chat], [{ n: 1 }, painter], [{ editPrevious: true }, painter]] as const) {
      let error: unknown
      try {
        checkImageOptions(options, 'chat', entry)
      }
      catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(HarnessError)
      expect((error as HarnessError).toJSON().error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['imageOptions'] }] } })
    }
  })
})

describe('imagePrompt', () => {
  it('joins the text parts after slash-command expansion', () => {
    expect(imagePrompt(user({ type: 'text', text: '  a red fox ' }))).toBe('a red fox')
    expect(imagePrompt(user(part('file_png0000000000001'), { type: 'text', text: 'first' }, { type: 'text', text: 'second' }))).toBe('first\nsecond')
    const command: HarnessUIMessage = {
      ...user({ type: 'text', text: '/sketch a cat' }),
      metadata: { modelRef: 'prov:pix', startedAt: 1, command: { name: 'sketch', input: 'a cat', type: 'prompt', expansion: 'A pencil sketch of a cat' } },
    }
    expect(imagePrompt(command)).toBe('A pencil sketch of a cat')
    expect(imagePrompt(user(part('file_png0000000000001')))).toBe('')
  })
})

describe('imageTurnInputs', () => {
  it('sends the attached raster images to a vision model (at most imageInputsMax) and drops the rest', async () => {
    const ids = ['file_png0000000000001', 'file_png0000000000002', 'file_png0000000000003', 'file_png0000000000004', 'file_png0000000000005']
    const message = user(...ids.map(id => part(id)), part('file_pdf0000000000001'), part('file_svg0000000000001'), { type: 'text', text: 'combine' })
    const inputs = await imageTurnInputs(message, reply(part('file_png0000000000001')), model(true), undefined, files)
    expect(inputs.inputFileIds).toEqual(ids.slice(0, LIMITS.imageInputsMax))
    // The fifth image, the PDF and the SVG.
    expect(inputs.dropped).toBe(3)
  })

  it('drops attached images for a model without vision and never falls back to the previous images then', async () => {
    const inputs = await imageTurnInputs(user(part('file_png0000000000001'), { type: 'text', text: 'x' }), reply(part('file_png0000000000002')), model(false), undefined, files)
    expect(inputs).toEqual({ inputFileIds: [], dropped: 1 })
  })

  it('edits the generated images of the parent reply unless editPrevious is false', async () => {
    const parent = reply(part('file_png0000000000001'), { type: 'text', text: 'here' }, part('file_png0000000000002'))
    const message = user({ type: 'text', text: 'make it blue' })
    expect(await imageTurnInputs(message, parent, model(true), undefined, files)).toEqual({ inputFileIds: ['file_png0000000000001', 'file_png0000000000002'], dropped: 0 })
    expect(await imageTurnInputs(message, parent, model(true), true, files)).toEqual({ inputFileIds: ['file_png0000000000001', 'file_png0000000000002'], dropped: 0 })
    expect(await imageTurnInputs(message, parent, model(true), false, files)).toEqual({ inputFileIds: [], dropped: 0 })
    expect(await imageTurnInputs(message, parent, model(false), undefined, files)).toEqual({ inputFileIds: [], dropped: 0 })
    // A PDF attachment is dropped, the previous images are still the input.
    expect(await imageTurnInputs(user(part('file_pdf0000000000001'), { type: 'text', text: 'blue' }), parent, model(true), undefined, files)).toEqual({ inputFileIds: ['file_png0000000000001', 'file_png0000000000002'], dropped: 1 })
    expect(await imageTurnInputs(message, undefined, model(true), undefined, files)).toEqual({ inputFileIds: [], dropped: 0 })
  })

  it('takes only stored raster images of an assistant reply, the latest imageInputsMax, without duplicates', async () => {
    const parent = reply(
      part('file_png0000000000001'),
      part('file_png0000000000001'),
      part('file_svg0000000000001'),
      part('file_missing000000001', 'image/png'),
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
      { type: 'reasoning-file', mediaType: 'image/png', url: '/api/files/file_png0000000000002' },
      part('file_png0000000000003'),
      part('file_png0000000000004'),
      part('file_png0000000000005'),
      part('file_png0000000000002'),
    )
    expect(await generatedImageIds(parent, files)).toEqual(['file_png0000000000003', 'file_png0000000000004', 'file_png0000000000005', 'file_png0000000000002'])
    expect(await generatedImageIds(user(part('file_png0000000000001')), files)).toEqual([])
    expect(await generatedImageIds(null, files)).toEqual([])
  })
})

describe('resolveTarget', () => {
  function deps(kind: string | null, calls: string[]): Pick<AppDeps, 'providers' | 'catalog'> {
    return {
      catalog: { get: async () => (kind === null ? null : { kind }) } as unknown as AppDeps['catalog'],
      providers: {
        resolveModel: async (ref: string) => {
          calls.push(`chat:${ref}`)
          if (ref.startsWith('gone:'))
            throw new HarnessError({ code: 'not_found', message: 'Unknown provider "gone".', providerId: 'gone' })
          return { modelRef: ref } as ResolvedModel
        },
        resolveImageModel: async (ref: string) => {
          calls.push(`image:${ref}`)
          if (ref.startsWith('gone:'))
            throw new HarnessError({ code: 'not_found', message: 'Unknown provider "gone".', providerId: 'gone' })
          return { modelRef: ref } as ResolvedImageModel
        },
      } as unknown as AppDeps['providers'],
    }
  }

  it('picks the resolver from the catalog kind', async () => {
    const calls: string[] = []
    const signal = new AbortController().signal
    expect(await resolveTarget(deps('image', calls), 'prov:pix', signal)).toMatchObject({ kind: 'image', model: { modelRef: 'prov:pix' } })
    expect(await resolveTarget(deps('chat', calls), 'prov:chat', signal)).toMatchObject({ kind: 'chat' })
    expect(await resolveTarget(deps(null, calls), 'prov:unknown', signal)).toMatchObject({ kind: 'chat' })
    expect(calls).toEqual(['image:prov:pix', 'chat:prov:chat', 'chat:prov:unknown'])
  })

  it('reports an unknown provider as provider_not_configured for both resolvers', async () => {
    const signal = new AbortController().signal
    for (const kind of ['image', null]) {
      const error = await resolveTarget(deps(kind, []), 'gone:model', signal).catch((caught: unknown) => caught)
      expect((error as HarnessError).toJSON().error).toMatchObject({ code: 'provider_not_configured', providerId: 'gone', action: 'configure-provider' })
    }
  })
})

// ---------- projects (Phase 7) ----------

const PROJECT_ID = 'prj_0123456789abcdef'
const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

function record(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return { id: CHAT_ID, title: null, titleSource: null, modelRef: null, settings: {}, pinned: false, archived: false, pendingApproval: false, activeLeafId: null, projectId: null, createdAt: 1, updatedAt: 1, ...overrides }
}

function body(overrides: Partial<ChatRequestBody> = {}): ChatRequestBody {
  return { chatId: CHAT_ID, message: user({ type: 'text', text: 'hi' }), trigger: 'submit-message', modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'edits', ...overrides }
}

/** A chats fake for `ensureChat`: `ensure` records its input. */
function chatsDeps() {
  const ensured: ChatEnsureInput[] = []
  const deps = {
    chats: {
      ensure: async (_id: string, init: ChatEnsureInput = {}) => {
        ensured.push(init)
        return { chat: record({ projectId: init.projectId ?? null }), created: true }
      },
    },
  } as unknown as Pick<AppDeps, 'chats'>
  return { deps, ensured }
}

describe('ensureChat (the project of a new chat)', () => {
  it('passes the request projectId to ensure, which applies it only when it creates the chat', async () => {
    const { deps, ensured } = chatsDeps()
    expect((await ensureChat(deps, body({ projectId: PROJECT_ID }))).projectId).toBe(PROJECT_ID)
    expect((await ensureChat(deps, body())).projectId).toBeNull()
    expect(ensured).toEqual([
      { modelRef: 'mock:echo', settings: { toolMode: 'edits', reasoningEffort: 'auto' }, projectId: PROJECT_ID },
      { modelRef: 'mock:echo', settings: { toolMode: 'edits', reasoningEffort: 'auto' } },
    ])
  })

  it('lets the not_found of an unknown project through (before the chat row exists)', async () => {
    const deps = { chats: { ensure: async () => {
      throw new HarnessError({ code: 'not_found', message: `Project ${PROJECT_ID} not found.` })
    } } } as unknown as Pick<AppDeps, 'chats'>
    const error = await ensureChat(deps, body({ projectId: PROJECT_ID })).catch((caught: unknown) => caught)
    expect((error as HarnessError).toJSON().error.code).toBe('not_found')
  })
})

describe('openRunWorkspace', () => {
  const workspace: OpenWorkspace = { projectId: PROJECT_ID, name: 'Demo', root: '/srv/demo', instructions: null, projectFile: null }
  const chatTarget = { kind: 'chat', model: {} } as RunTarget
  const imageTarget = { kind: 'image', model: {}, options: {} } as RunTarget

  function workspaceDeps(result: OpenWorkspaceResult) {
    const opened: string[] = []
    const deps = { projects: { openWorkspace: async (id: string) => {
      opened.push(id)
      return result
    } } } as unknown as Pick<AppDeps, 'projects'>
    return { deps, opened }
  }

  it('opens the folder of a chat-model run of a chat with a project', async () => {
    const { deps, opened } = workspaceDeps({ ok: true, workspace })
    expect(await openRunWorkspace(deps, { projectId: PROJECT_ID }, chatTarget, null, createSilentLogger())).toEqual({ workspace, notices: [] })
    expect(opened).toEqual([PROJECT_ID])
  })

  it('continues without a workspace and with the workspace-unavailable notice when the folder cannot be opened', async () => {
    const message = 'The project folder /srv/demo is not available: The folder no longer exists.'
    const { deps } = workspaceDeps({ ok: false, name: 'Demo', message })
    expect(await openRunWorkspace(deps, { projectId: PROJECT_ID }, chatTarget, null, createSilentLogger())).toEqual({
      workspace: null,
      notices: [{ level: 'warning', code: 'workspace-unavailable', message }],
    })
  })

  it('opens nothing without a project, for an image turn or a command reply', async () => {
    const { deps, opened } = workspaceDeps({ ok: true, workspace })
    const reply = { kind: 'reply', markdown: 'x' } as CommandResolution
    expect(await openRunWorkspace(deps, { projectId: null }, chatTarget, null, createSilentLogger())).toEqual({ workspace: null, notices: [] })
    expect(await openRunWorkspace(deps, { projectId: PROJECT_ID }, imageTarget, null, createSilentLogger())).toEqual({ workspace: null, notices: [] })
    expect(await openRunWorkspace(deps, { projectId: PROJECT_ID }, chatTarget, reply, createSilentLogger())).toEqual({ workspace: null, notices: [] })
    expect(opened).toEqual([])
  })

  it('lets a database failure reject (a normal error before the stream)', async () => {
    const deps = { projects: { openWorkspace: async () => {
      throw new Error('database is locked')
    } } } as unknown as Pick<AppDeps, 'projects'>
    await expect(openRunWorkspace(deps, { projectId: PROJECT_ID }, chatTarget, null, createSilentLogger())).rejects.toThrow('database is locked')
  })
})

describe('prepareRun: the Phase 10 fields (C31-T1 / T6)', () => {
  it('takes one catalog snapshot of the chat\'s project; the chat keeps the request\'s model; no restriction without a command', async () => {
    const t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, customizations: 'fake' })
    try {
      const fake = t.deps.customizations as FakeCustomizationService
      fake.entries.set('', [fakeCatalogEntry('skill', 'release-notes', { source: 'plugin', pluginId: 'mock' })])
      const chatId = testChatId(0xA001)
      for (const serverMessage of [undefined, false]) {
        const before = fake.calls.catalog
        const run = createRunRegistry().acquire(chatId, 'mock:echo')
        const body = chatBody(chatId, 'hello')
        const prepared = await prepareRun(t.deps, run, body, createSilentLogger(), serverMessage === undefined ? undefined : { serverMessage })
        expect(fake.calls.catalog).toBe(before + 1)
        expect(prepared.catalog.projectId).toBeNull()
        expect(prepared.catalog.agents().map(entry => entry.name)).toEqual(['explore', 'general'])
        expect(prepared.catalog.skills().map(entry => entry.name)).toEqual(['release-notes'])
        expect(prepared.requestModelRef).toBe('mock:echo')
        expect(prepared.requestModelRef).toBe(prepared.resolved.modelRef)
        expect(prepared.turnRestriction).toBeNull()
        expect(prepared.notices).toEqual([])
        await commitHistory(t.deps, chatId, prepared.writes)
      }
    }
    finally {
      await t.close()
    }
  })
})

// ---------- W10.2: the command's model, the turn's tools, the server message ----------

/** A personal command of the fake catalog (global, so every chat sees it). */
async function personalCommand(t: TestApp, name: string, frontmatter: string, body: string): Promise<void> {
  await (t.deps.customizations as FakeCustomizationService).create({ kind: 'command', content: `---\nname: ${name}\ndescription: The ${name} command.\n${frontmatter}---\n${body}` })
}

async function prepareFor(t: TestApp, body: ChatRequestBody, options?: PrepareRunOptions): Promise<PreparedRun> {
  const run = createRunRegistry().acquire(body.chatId, body.modelRef)
  return prepareRun(t.deps, run, body, createSilentLogger(), options)
}

/** Prepares and commits (the history a later regenerate or continuation reads). */
async function prepareAndCommit(t: TestApp, body: ChatRequestBody, options?: PrepareRunOptions): Promise<PreparedRun> {
  const prepared = await prepareFor(t, body, options)
  await commitHistory(t.deps, body.chatId, prepared.writes)
  return prepared
}

describe('resolveTurnModel (W10.2-T2)', () => {
  const chatTarget = { kind: 'chat', model: { modelRef: 'mock:echo' } } as ResolvedTarget
  const signal = new AbortController().signal

  function providers(models: Record<string, { kind: string } | HarnessError>, calls: string[] = []): Pick<AppDeps, 'providers'> {
    return {
      providers: {
        resolveModel: async (modelRef: string) => {
          calls.push(modelRef)
          const found = models[modelRef]
          if (found === undefined)
            throw new HarnessError({ code: 'provider_not_configured', message: 'Not configured.', providerId: modelRef.split(':')[0] })
          if (found instanceof HarnessError)
            throw found
          return { modelRef, entry: { kind: found.kind } } as unknown as ResolvedModel
        },
      } as unknown as AppDeps['providers'],
    }
  }

  it('keeps the request\'s model (and its image options) without an override or when the override is the same model', async () => {
    const calls: string[] = []
    const request = { target: chatTarget, imageOptions: { aspectRatio: '1:1' as const } }
    for (const override of [undefined, 'mock:echo'])
      expect(await resolveTurnModel(providers({}, calls), request, override, { signal, logger: createSilentLogger() })).toEqual({ ...request, notices: [] })
    expect(calls).toEqual([])
  })

  it('runs a command model that resolves to a chat model, without the request\'s image options', async () => {
    const turn = await resolveTurnModel(providers({ 'mock:agents': { kind: 'chat' } }), { target: chatTarget, imageOptions: { n: 2 } }, 'mock:agents', { signal, logger: createSilentLogger() })
    expect(turn).toEqual({ target: { kind: 'chat', model: { modelRef: 'mock:agents', entry: { kind: 'chat' } } }, imageOptions: undefined, notices: [] })
  })

  it('falls back to the request\'s model with the notice when the command model cannot run', async () => {
    const models = {
      'mock:image': new HarnessError({ code: 'validation_error', message: 'An image model.' }),
      'mock:transcribe': { kind: 'transcription' },
      'mock:missing': new HarnessError({ code: 'model_not_found', message: 'Unknown model.' }),
      'mock:broken': new HarnessError({ code: 'plugin_error', message: 'The factory threw.' }),
    }
    for (const override of ['nope:model', 'mock:image', 'mock:transcribe', 'mock:missing', 'mock:broken']) {
      const turn = await resolveTurnModel(providers(models), { target: chatTarget, imageOptions: undefined }, override, { signal, logger: createSilentLogger() })
      expect(turn.target).toBe(chatTarget)
      expect(turn.notices).toEqual([{ level: 'warning', code: 'command-model-unavailable', message: `The command's model ${override} is not available, so the chat's model answered.` }])
    }
  })

  it('adds the notice once per reply: not again for a continuation whose reply shows it', async () => {
    const shown: HarnessUIMessage = reply({ type: 'data-notice', data: NOTICES.commandModelUnavailable('nope:model') })
    const turn = await resolveTurnModel(providers({}), { target: chatTarget, imageOptions: undefined }, 'nope:model', { signal, logger: createSilentLogger(), continued: shown })
    expect(turn.notices).toEqual([])
    const other = await resolveTurnModel(providers({}), { target: chatTarget, imageOptions: undefined }, 'nope:model', { signal, logger: createSilentLogger(), continued: reply({ type: 'text', text: 'x' }) })
    expect(other.notices).toHaveLength(1)
  })

  it('rethrows when the run was stopped while the command model resolved', async () => {
    const controller = new AbortController()
    const deps = { providers: { resolveModel: async () => {
      controller.abort(new DOMException('stopped', 'AbortError'))
      throw controller.signal.reason
    } } } as unknown as Pick<AppDeps, 'providers'>
    await expect(resolveTurnModel(deps, { target: chatTarget, imageOptions: undefined }, 'mock:agents', { signal: controller.signal, logger: createSilentLogger() })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reads the stored command model of a user message only', () => {
    const meta = { modelRef: 'mock:echo', startedAt: 1, command: { name: 'review', input: '', type: 'prompt' as const, expansion: 'R', modelRef: 'mock:agents' } }
    expect(storedCommandModel({ ...user({ type: 'text', text: '/review' }), metadata: meta })).toBe('mock:agents')
    expect(storedCommandModel({ ...reply({ type: 'text', text: 'x' }), metadata: meta })).toBeUndefined()
    expect(storedCommandModel(user({ type: 'text', text: 'plain' }))).toBeUndefined()
    expect(storedCommandModel(null)).toBeUndefined()
  })
})

describe('prepareRun: the command\'s model and tools (W10.2-T2 / T3)', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, customizations: 'fake' })
    await personalCommand(t, 'review', 'model: mock:agents\nallowed-tools: Read, current_time\nargument-hint: <files>\n', 'Review $ARGUMENTS.')
    await personalCommand(t, 'lost', 'model: nope:model\n', 'Lost $1.')
    await personalCommand(t, 'painter', 'model: mock:image\n', 'Paint $ARGUMENTS.')
  })

  afterAll(async () => {
    await t.close()
  })

  it('runs a new command turn on the command\'s model; the chat and the user message keep the request\'s model', async () => {
    const chatId = testChatId(0xB001)
    const prepared = await prepareAndCommit(t, chatBody(chatId, '/review src/a.ts'))
    expect(prepared.resolved.modelRef).toBe('mock:agents')
    expect(prepared.target).toMatchObject({ kind: 'chat', model: { modelRef: 'mock:agents' } })
    expect(prepared.requestModelRef).toBe('mock:echo')
    expect(prepared.notices).toEqual([])
    expect(prepared.command).toBeNull()
    expect(prepared.userMessage?.metadata).toMatchObject({
      modelRef: 'mock:echo',
      command: { name: 'review', input: 'src/a.ts', type: 'prompt', expansion: 'Review src/a.ts.', source: 'user', modelRef: 'mock:agents', allowedTools: ['read_file', 'current_time'] },
    })
    expect(prepared.turnRestriction).toEqual(['read_file', 'current_time'])
    // `ensure` saved the request's model, never the command's.
    expect((await t.deps.chats.find(chatId))?.modelRef).toBe('mock:echo')
  })

  it('answers with the chat\'s model and the notice when the command\'s model cannot run (unknown provider, image model)', async () => {
    for (const [index, text] of ['/lost one two', '/painter a fox'].entries()) {
      const prepared = await prepareAndCommit(t, chatBody(testChatId(0xB010 + index), text))
      expect(prepared.resolved.modelRef).toBe('mock:echo')
      expect(prepared.requestModelRef).toBe('mock:echo')
      expect(prepared.notices.map(notice => notice.code)).toEqual(['command-model-unavailable'])
      expect(prepared.notices[0]?.message).toContain(index === 0 ? 'nope:model' : 'mock:image')
    }
  })

  it('a regenerate reuses the stored model and tools (a file changed since does not matter)', async () => {
    const chatId = testChatId(0xB020)
    const first = await prepareAndCommit(t, chatBody(chatId, '/review b.ts'))
    const fake = t.deps.customizations as FakeCustomizationService
    const row = [...fake.personal.values()].find(entry => entry.name === 'review')!
    await fake.update(row.id, { content: '---\nname: review\ndescription: Changed.\nmodel: mock:echo\n---\nChanged $ARGUMENTS.' })
    try {
      const again = await prepareFor(t, { ...chatBody(chatId, ''), trigger: 'regenerate-message', messageId: first.userMessage!.id, message: first.userMessage! })
      expect(again.kind).toBe('regenerate')
      expect(again.resolved.modelRef).toBe('mock:agents')
      expect(again.requestModelRef).toBe('mock:echo')
      expect(again.turnRestriction).toEqual(['read_file', 'current_time'])
      expect(again.history.at(-1)?.metadata?.command?.expansion).toBe('Review b.ts.')
    }
    finally {
      await fake.update(row.id, { content: '---\nname: review\ndescription: The review command.\nmodel: mock:agents\nallowed-tools: Read, current_time\nargument-hint: <files>\n---\nReview $ARGUMENTS.' })
    }
  })

  it('a regenerate whose stored model cannot run any more adds the notice', async () => {
    const chatId = testChatId(0xB030)
    const first = await prepareAndCommit(t, chatBody(chatId, '/lost x'))
    const again = await prepareFor(t, { ...chatBody(chatId, ''), trigger: 'regenerate-message', messageId: first.userMessage!.id, message: first.userMessage! })
    expect(again.resolved.modelRef).toBe('mock:echo')
    expect(again.notices.map(notice => notice.code)).toEqual(['command-model-unavailable'])
  })

  it('an image chat model runs a command turn on the command\'s chat model (its image options are not applied)', async () => {
    const chatId = testChatId(0xB040)
    const prepared = await prepareFor(t, chatBody(chatId, '/review c.ts', { modelRef: 'mock:image', imageOptions: { n: 2 } }))
    expect(prepared.target).toMatchObject({ kind: 'chat', model: { modelRef: 'mock:agents' } })
    expect(prepared.requestModelRef).toBe('mock:image')
    // An unavailable command model: the image turn of the request, its prompt the expansion.
    const lost = await prepareFor(t, chatBody(testChatId(0xB041), '/lost a red fox', { modelRef: 'mock:image', imageOptions: { n: 2 } }))
    expect(lost.target).toMatchObject({ kind: 'image', options: { prompt: 'Lost a.', n: 2 } })
    expect(lost.notices.map(notice => notice.code)).toEqual(['command-model-unavailable'])
  })

  it('keeps the request errors of the chat\'s model before anything else', async () => {
    const error = await prepareFor(t, chatBody(testChatId(0xB050), '/review x', { modelRef: 'gone:model' })).catch((caught: unknown) => caught)
    expect((error as HarnessError).toJSON().error).toMatchObject({ code: 'provider_not_configured' })
  })
})

describe('prepareRun: the server message path (W10.2-T5)', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, customizations: 'fake' })
  })

  afterAll(async () => {
    await t.close()
  })

  function result(taskId = 'bgt_0123456789abcdef'): Record<string, unknown> {
    return {
      taskId,
      toolCallId: 'call_1',
      messageId: 'msg_a000000000000001',
      output: { status: 'completed', type: 'explore', description: 'Look around', modelRef: 'mock:echo', steps: [], stepsOmitted: 0, report: 'Found it.', startedAt: 1, finishedAt: 2, taskId },
      deliveredAt: 3,
    }
  }

  function carrier(chatId: string, parts: unknown[]): ChatRequestBody {
    return { ...chatBody(chatId, ''), message: { id: createMessageId(), role: 'user', parts } as unknown as HarnessUIMessage }
  }

  it('accepts a user-role carrier of data-task-result parts without normalizing them, and resolves no command', async () => {
    const chatId = testChatId(0xC001)
    await prepareAndCommit(t, chatBody(chatId, 'start'))
    const body = carrier(chatId, [{ type: 'data-task-result', data: result() }, { type: 'data-task-result', id: 'r2', data: result('bgt_fedcba9876543210') }])
    const prepared = await prepareAndCommit(t, body, { serverMessage: true })
    expect(prepared.kind).toBe('new')
    expect(prepared.command).toBeNull()
    expect(prepared.turnRestriction).toBeNull()
    expect(prepared.userMessage).toEqual({
      id: body.message.id,
      role: 'user',
      parts: [{ type: 'data-task-result', data: result() }, { type: 'data-task-result', id: 'r2', data: result('bgt_fedcba9876543210') }],
      metadata: { modelRef: 'mock:echo', startedAt: expect.any(Number) },
    })
    const stored = await t.deps.chats.getMessage(chatId, body.message.id)
    expect(stored?.parts.map(part => part.type)).toEqual(['data-task-result', 'data-task-result'])
  })

  it('refuses text, file and mixed parts, an empty carrier, invalid result data, and anything but a new message', async () => {
    const chatId = testChatId(0xC010)
    await prepareAndCommit(t, chatBody(chatId, 'start'))
    const refused: Array<[parts: unknown[], path: (string | number)[]]> = [
      [[{ type: 'text', text: 'results arrived' }], ['message', 'parts', 0]],
      [[{ type: 'data-task-result', data: result() }, { type: 'text', text: '/review' }], ['message', 'parts', 1]],
      [[{ type: 'file', mediaType: 'text/plain', url: '/api/files/file_0000000000000001' }], ['message', 'parts', 0]],
      [[{ type: 'data-steer', data: {} }], ['message', 'parts', 0]],
      [[], ['message', 'parts']],
    ]
    for (const [parts, path] of refused) {
      const error = await prepareFor(t, carrier(chatId, parts), { serverMessage: true }).catch((caught: unknown) => caught)
      expect((error as HarnessError).toJSON().error, JSON.stringify(parts)).toMatchObject({ code: 'validation_error', details: { issues: [{ path }] } })
    }
    const invalid = await prepareFor(t, carrier(chatId, [{ type: 'data-task-result', data: { taskId: 'nope' } }]), { serverMessage: true }).catch((caught: unknown) => caught)
    expect((invalid as HarnessError).toJSON().error).toMatchObject({ code: 'validation_error' })
    const regenerate = await prepareFor(t, { ...chatBody(chatId, ''), trigger: 'regenerate-message' }, { serverMessage: true }).catch((caught: unknown) => caught)
    expect((regenerate as HarnessError).toJSON().error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message'] }] } })
    // Nothing was stored by the refused requests.
    expect((await t.deps.chats.listPath(chatId, (await t.deps.chats.find(chatId))!.activeLeafId)).map(message => message.role)).toEqual(['user'])
  })

  it('a user request can never send a carrier (data parts are refused by normalizeUserParts)', async () => {
    const error = await prepareFor(t, carrier(testChatId(0xC020), [{ type: 'data-task-result', data: result() }])).catch((caught: unknown) => caught)
    expect((error as HarnessError).toJSON().error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts', 0] }] } })
  })
})

// ---------- W10.2: command turns end to end (POST /chat) ----------

describe('command turns end to end (W10.2-T2 / T3)', () => {
  /** Models of the `cmdkit` provider (tools), set per test; every call is recorded. */
  const cmdkitCalls: LanguageModelV4CallOptions[] = []
  let t: TestApp
  let disposable: { dispose: () => void } | undefined

  function finish(reason: 'stop' | 'tool-calls'): LanguageModelV4StreamPart {
    return {
      type: 'finish',
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
      finishReason: { unified: reason, raw: reason },
    }
  }

  /** Calls `mock_approval_tool` once per turn, then answers with the text `done`. */
  const agent = new MockLanguageModelV4({
    doStream: async (options) => {
      cmdkitCalls.push(options)
      const parts: LanguageModelV4StreamPart[] = options.prompt.at(-1)?.role === 'tool'
        ? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, finish('stop')]
        : [{ type: 'tool-call', toolCallId: `call_${cmdkitCalls.length}`, toolName: 'mock_approval_tool', input: '{"text":"x"}' }, finish('tool-calls')]
      return { stream: convertArrayToReadableStream(parts) }
    },
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'A title' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
      warnings: [],
    }),
  })

  function toolNames(call: LanguageModelV4CallOptions | undefined): string[] {
    return (call?.tools ?? []).map(tool => tool.name).sort()
  }

  async function detail(chatId: string): Promise<ChatDetail> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
  }

  /** One request through `POST /chat`: the streamed chunks, the `run.started` data and the stored chat after it. */
  async function send(body: ChatRequestBody): Promise<{ chunks: UIMessageChunk[], started: RunStartedData, chat: ChatDetail }> {
    const started = nextEvent(t, 'run.started', event => event.data.chatId === body.chatId)
    const response = await postChat(t, body)
    expect(response.status).toBe(200)
    const { chunks } = await readSse(response)
    await runnerOf(t).idle()
    return { chunks, started: (await started).data, chat: await detail(body.chatId) }
  }

  function notices(message: HarnessUIMessage | undefined, code: string): number {
    return message?.parts.filter(part => part.type === 'data-notice' && part.data.code === code).length ?? 0
  }

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, customizations: 'fake' })
    disposable = t.deps.registry.providers.register('mock', {
      id: 'cmdkit',
      name: 'Command kit',
      credentials: [],
      seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 100_000, capabilities: { tools: true }, cost: { input: 1, output: 2 } }],
      createLanguageModel: () => agent,
    })
    await personalCommand(t, 'greet', 'model: mock:agents\nargument-hint: <name>\n', 'Say hello to $ARGUMENTS.')
    await personalCommand(t, 'lost', 'model: nope:model\n', 'Lost $ARGUMENTS.')
    await personalCommand(t, 'probe', 'model: mock:agents\nallowed-tools: current_time\n', 'Check the tools.\n$ARGUMENTS')
    await personalCommand(t, 'approve', 'model: cmdkit:agent\nallowed-tools: mock_approval_tool, current_time\n', 'Use the tool on $ARGUMENTS.')
    await personalCommand(t, 'ask-lost', 'model: nope:model\n', 'Ask $ARGUMENTS.')
  })

  afterAll(async () => {
    disposable?.dispose()
    await t.close()
  })

  it('runs the turn on the command\'s model: run.started and the reply name it, the chat keeps its model', async () => {
    const chatId = testChatId(0xD001)
    const { chunks, started, chat } = await send(chatBody(chatId, '/greet Ada'))
    expect(streamedText(chunks)).toBe('Agents mock: Say hello to Ada.')
    expect(started.modelRef).toBe('mock:agents')
    expect(chat.modelRef).toBe('mock:echo')
    const [question, answer] = chat.messages
    expect(question?.metadata).toMatchObject({ modelRef: 'mock:echo', command: { name: 'greet', source: 'user', modelRef: 'mock:agents', expansion: 'Say hello to Ada.' } })
    expect(answer?.metadata?.modelRef).toBe('mock:agents')
    expect(notices(answer, 'command-model-unavailable')).toBe(0)
    // The next plain message runs on the chat's model again.
    const next = await send(chatBody(chatId, 'plain'))
    expect(next.started.modelRef).toBe('mock:echo')
    expect(streamedText(next.chunks)).toBe('plain')
  })

  it('answers with the chat\'s model and one notice when the command\'s model cannot run (a regenerate too)', async () => {
    const chatId = testChatId(0xD010)
    const first = await send(chatBody(chatId, '/lost keys'))
    expect(first.started.modelRef).toBe('mock:echo')
    expect(streamedText(first.chunks)).toBe('Lost keys.')
    // (mock:echo has no tools: its own `tools-unsupported` notice follows.)
    expect(first.chunks.filter(chunk => chunk.type === 'data-notice').map(chunk => (chunk as { data: { code: string, message: string } }).data).filter(data => data.code !== 'tools-unsupported')).toEqual([
      { level: 'warning', code: 'command-model-unavailable', message: 'The command\'s model nope:model is not available, so the chat\'s model answered.' },
    ])
    expect(first.chat.modelRef).toBe('mock:echo')
    expect(notices(first.chat.messages[1], 'command-model-unavailable')).toBe(1)
    // The reply starts with it.
    expect(first.chat.messages[1]?.parts[0]).toMatchObject({ type: 'data-notice', data: { code: 'command-model-unavailable' } })
    const user = first.chat.messages[0]!
    const again = await send({ ...chatBody(chatId, ''), trigger: 'regenerate-message', messageId: user.id, message: user })
    expect(streamedText(again.chunks)).toBe('Lost keys.')
    expect(notices(again.chat.messages[1], 'command-model-unavailable')).toBe(1)
  })

  it('narrows the turn\'s tools to allowed-tools (in ask and in auto), only for that turn', async () => {
    for (const toolMode of ['ask', 'auto'] as const) {
      const chatId = testChatId(toolMode === 'ask' ? 0xD020 : 0xD021)
      const { chunks } = await send(chatBody(chatId, '/probe tools?', { toolMode }))
      expect(streamedText(chunks), toolMode).toBe('Tools: current_time')
      // A later plain turn of the same chat is not restricted.
      const later = await send(chatBody(chatId, 'tools?', { toolMode, modelRef: 'mock:agents' }))
      expect(streamedText(later.chunks).split(', ').length).toBeGreaterThan(1)
    }
  })

  it('keeps the command\'s model and tools across an approval continuation, and in auto', async () => {
    cmdkitCalls.length = 0
    const chatId = testChatId(0xD030)
    const first = await send(chatBody(chatId, '/approve x'))
    expect(first.started.modelRef).toBe('cmdkit:agent')
    expect(first.chat.pendingApproval).toBe(true)
    expect(toolNames(cmdkitCalls[0])).toEqual(['current_time', 'mock_approval_tool'])
    const continued = await send({ ...chatBody(chatId, ''), message: answerApprovals(first.chat.messages[1]!, true) })
    expect(continued.started.modelRef).toBe('cmdkit:agent')
    expect(streamedText(continued.chunks)).toBe('done')
    expect(cmdkitCalls).toHaveLength(2)
    expect(toolNames(cmdkitCalls[1])).toEqual(['current_time', 'mock_approval_tool'])
    expect(continued.chat.modelRef).toBe('mock:echo')
    expect(continued.chat.messages[1]?.metadata?.modelRef).toBe('cmdkit:agent')

    cmdkitCalls.length = 0
    const auto = await send(chatBody(testChatId(0xD031), '/approve y', { toolMode: 'auto' }))
    expect(streamedText(auto.chunks)).toBe('done')
    expect(cmdkitCalls.map(toolNames)).toEqual([['current_time', 'mock_approval_tool'], ['current_time', 'mock_approval_tool']])
  })

  it('shows the notice once in a reply that waits for an approval and is continued', async () => {
    const chatId = testChatId(0xD040)
    const first = await send(chatBody(chatId, '/ask-lost x', { modelRef: 'mock:tool-approval' }))
    expect(first.started.modelRef).toBe('mock:tool-approval')
    expect(first.chat.pendingApproval).toBe(true)
    expect(notices(first.chat.messages[1], 'command-model-unavailable')).toBe(1)
    const continued = await send({ ...chatBody(chatId, '', { modelRef: 'mock:tool-approval' }), message: answerApprovals(first.chat.messages[1]!, true) })
    expect(streamedText(continued.chunks)).toContain('Tool result:')
    expect(notices(continued.chat.messages[1], 'command-model-unavailable')).toBe(1)
  })
})
