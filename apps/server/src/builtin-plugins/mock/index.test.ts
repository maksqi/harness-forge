import type { PluginContext, ProviderDefinition, ToolDefinition } from '@harness-forge/plugin-sdk'
import { modelInfoListSchema, modelInfoSchema, pluginManifestBaseSchema } from '@harness-forge/shared'
import { RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import { validateProviderDefinition } from '../../registry/validate.ts'
import { getBuiltinPlugins } from '../index.ts'
import mockPlugin, { createMockWav, manifest, MOCK_SPEECH_VOICES, MOCK_TRANSCRIPT, mockApprovalTool, mockModels, mockProvider } from './index.ts'
import { readWav } from './media.test-util.ts'
import { mockAuthError } from './models.ts'

describe('mock plugin', () => {
  it('has a valid builtin manifest', () => {
    expect(pluginManifestBaseSchema.parse(manifest).id).toBe('mock')
  })

  it('is loaded only with HF_MOCK_PROVIDER=1', () => {
    expect(getBuiltinPlugins({ mockProvider: false }).some(plugin => plugin.id === 'mock')).toBe(false)
    expect(getBuiltinPlugins({ mockProvider: true }).some(plugin => plugin.id === 'mock')).toBe(true)
  })

  it('registers the provider and the approval tool through ctx', async () => {
    const providers: ProviderDefinition[] = []
    const tools: ToolDefinition[] = []
    const ctx = {
      providers: {
        register: (definition: ProviderDefinition) => {
          providers.push(definition)
          return { dispose() {} }
        },
      },
      tools: {
        register: (definition: ToolDefinition) => {
          tools.push(definition)
          return { dispose() {} }
        },
      },
    } as unknown as PluginContext
    await mockPlugin.setup(ctx)
    expect(providers).toEqual([mockProvider])
    expect(tools).toEqual([mockApprovalTool])
  })
})

describe('mock provider definition', () => {
  it('has no credentials, no icon, echo as small model and the nine models as listing and seeds', async () => {
    expect(mockProvider).toMatchObject({ id: 'mock', name: 'Mock (dev only)', credentials: [], smallModelId: 'echo' })
    expect(mockProvider.icon).toBeUndefined()
    const listed = await mockProvider.listModels?.({ credentials: {}, fetch: globalThis.fetch })
    expect(listed?.map(model => model.id)).toEqual(['echo', 'reasoning', 'tool-approval', 'error', 'image', 'image-chat', 'image-tool', 'transcribe', 'speech'])
    expect(mockProvider.seedModels).toEqual(listed)
    expect(modelInfoListSchema.parse(mockModels())).toEqual(mockModels())
    const byId = new Map(mockModels().map(model => [model.id, model]))
    for (const id of ['echo', 'reasoning', 'tool-approval', 'error', 'image-chat', 'image-tool'])
      expect(modelInfoSchema.parse(byId.get(id)), id).toMatchObject({ contextWindow: 32_000, maxOutputTokens: 4096, cost: { input: 1, output: 2 } })
    for (const id of ['echo', 'reasoning', 'tool-approval', 'error'])
      expect(byId.get(id)?.kind, id).toBeUndefined()
    expect(byId.get('echo')?.capabilities).toMatchObject({ vision: true, pdf: true })
    expect(byId.get('reasoning')).toMatchObject({ capabilities: { reasoning: true }, reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'] })
    expect(byId.get('tool-approval')?.capabilities).toMatchObject({ tools: true })
    await expect(mockProvider.validate?.({ credentials: {}, fetch: globalThis.fetch })).resolves.toBeUndefined()
  })

  it('lists the Phase 6 models with their kinds and capabilities (PROVIDERS.md 8)', () => {
    const byId = new Map(mockModels().map(model => [model.id, model]))
    expect(byId.get('image')).toMatchObject({ name: 'Mock Image', kind: 'image', capabilities: { vision: true, imageOutput: false }, cost: { input: 1, output: 2 } })
    // Explicit chat kinds: the id classifier would take "image-..." for image models (hidden from the picker).
    expect(byId.get('image-chat')).toMatchObject({ name: 'Mock Image Chat', kind: 'chat', capabilities: { imageOutput: true, tools: false } })
    expect(byId.get('image-tool')).toMatchObject({ name: 'Mock Image Tool', kind: 'chat', capabilities: { tools: true, imageOutput: false } })
    expect(byId.get('transcribe')).toEqual({ id: 'transcribe', name: 'Mock Transcribe', kind: 'transcription' })
    expect(byId.get('speech')).toEqual({ id: 'speech', name: 'Mock Speech', kind: 'speech', voices: ['mock-voice-a', 'mock-voice-b'] })
    expect(MOCK_SPEECH_VOICES).toEqual(['mock-voice-a', 'mock-voice-b'])
  })

  it('passes the registry validation of provider definitions', () => {
    expect(() => validateProviderDefinition('mock', mockProvider)).not.toThrow()
  })

  it('maps efforts to the top-level reasoning option', () => {
    const model = mockModels()[1]!
    expect(mockProvider.reasoning?.('auto', model)).toBeUndefined()
    expect(mockProvider.reasoning?.('off', model)).toEqual({ reasoning: 'none' })
    expect(mockProvider.reasoning?.('medium', model)).toEqual({ reasoning: 'medium' })
    expect(mockProvider.reasoning?.('max', model)).toEqual({ reasoning: 'xhigh' })
  })

  it('maps the mock:error failure to auth_invalid, also inside a RetryError', () => {
    const expected = { code: 'auth_invalid', message: 'Mock authentication failure', status: 401, providerId: 'mock', action: 'configure-provider' }
    expect(mockProvider.mapError?.(mockAuthError())).toEqual(expected)
    const retry = new RetryError({ message: 'failed', reason: 'errorNotRetryable', errors: [mockAuthError()] })
    expect(mockProvider.mapError?.(retry)).toEqual(expected)
    expect(mockProvider.mapError?.(new Error('other'))).toBeUndefined()
  })

  it('creates a model per id', () => {
    const model = mockProvider.createLanguageModel('echo', { credentials: {}, fetch: globalThis.fetch })
    expect(model).toMatchObject({ specificationVersion: 'v4', provider: 'mock', modelId: 'echo' })
  })

  it('defines the plugin API 1.1.0 media members: image, transcription and speech models, imageParams, transcriptionOptions', async () => {
    const rt = { credentials: {}, fetch: globalThis.fetch }
    expect(mockProvider.createImageModel?.('image', rt)).toMatchObject({ specificationVersion: 'v4', provider: 'mock', modelId: 'image', maxImagesPerCall: 4 })
    expect(mockProvider.createTranscriptionModel?.('transcribe', rt)).toMatchObject({ specificationVersion: 'v4', provider: 'mock', modelId: 'transcribe' })
    expect(mockProvider.createSpeechModel?.('speech', rt)).toMatchObject({ specificationVersion: 'v4', provider: 'mock', modelId: 'speech' })
    const image = mockModels().find(model => model.id === 'image')!
    expect(mockProvider.imageParams?.({ n: 2, aspectRatio: '16:9', inputs: 0 }, image)).toEqual({ aspectRatio: '16:9', providerOptions: { mock: { aspectRatio: '16:9' } } })
    expect(mockProvider.imageParams?.({ n: 1, inputs: 0 }, image)).toBeUndefined()
    expect(mockProvider.transcriptionOptions?.({ language: 'de' })).toBeUndefined()
    expect(mockProvider.transcriptionOptions?.({})).toBeUndefined()
    expect(MOCK_TRANSCRIPT).toBe('This is a mock transcription.')
    expect(readWav(createMockWav('one two three four five')).durationMs).toBe(2000)
  })
})

describe('mock_approval_tool', () => {
  it('echoes its input and asks for approval', async () => {
    expect(mockApprovalTool).toMatchObject({ name: 'mock_approval_tool', policy: 'ask', description: 'Echoes its input. Mock tool that requires approval.' })
    const context = { chatId: 'c', modelRef: 'mock:tool-approval', toolCallId: 'mock_call_1', messages: [], signal: new AbortController().signal }
    await expect(mockApprovalTool.execute({ text: 'hi' }, context)).resolves.toEqual({ echoed: 'hi' })
  })
})
