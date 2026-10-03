import type { CatalogModel, ChatRequestBody, HarnessUIMessage } from '@harness-forge/shared'
import type { ResolvedImageModel, ResolvedModel, ResolvedModelBase } from '../providers/types.ts'
import type { ChatEnsureInput, ChatRecord } from '../services/chats/types.ts'
import type { FilesService, StoredFile } from '../services/files/types.ts'
import type { OpenWorkspace, OpenWorkspaceResult } from '../services/projects/types.ts'
import type { AppDeps } from '../types.ts'
import type { CommandResolution } from './commands.ts'
import type { RunTarget } from './prepare.ts'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { checkImageOptions, ensureChat, generatedImageIds, imagePrompt, imageTurnInputs, openRunWorkspace, resolveTarget } from './prepare.ts'

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
