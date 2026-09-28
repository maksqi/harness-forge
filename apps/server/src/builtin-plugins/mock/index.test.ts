import type { PluginContext, ProviderDefinition, ToolDefinition } from '@harness-forge/plugin-sdk'
import { modelInfoSchema, pluginManifestBaseSchema } from '@harness-forge/shared'
import { RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import { getBuiltinPlugins } from '../index.ts'
import mockPlugin, { manifest, mockApprovalTool, mockModels, mockProvider } from './index.ts'
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
  it('has no credentials, no icon, echo as small model and the four models as listing and seeds', async () => {
    expect(mockProvider).toMatchObject({ id: 'mock', name: 'Mock (dev only)', credentials: [], smallModelId: 'echo' })
    expect(mockProvider.icon).toBeUndefined()
    const listed = await mockProvider.listModels?.({ credentials: {}, fetch: globalThis.fetch })
    expect(listed?.map(model => model.id)).toEqual(['echo', 'reasoning', 'tool-approval', 'error'])
    expect(mockProvider.seedModels).toEqual(listed)
    for (const model of mockModels()) {
      expect(modelInfoSchema.parse(model)).toMatchObject({ contextWindow: 32_000, maxOutputTokens: 4096, cost: { input: 1, output: 2 } })
    }
    expect(mockModels()[0]?.capabilities).toMatchObject({ vision: true, pdf: true })
    expect(mockModels()[1]).toMatchObject({ capabilities: { reasoning: true }, reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'] })
    expect(mockModels()[2]?.capabilities).toMatchObject({ tools: true })
    await expect(mockProvider.validate?.({ credentials: {}, fetch: globalThis.fetch })).resolves.toBeUndefined()
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
})

describe('mock_approval_tool', () => {
  it('echoes its input and asks for approval', async () => {
    expect(mockApprovalTool).toMatchObject({ name: 'mock_approval_tool', policy: 'ask', description: 'Echoes its input. Mock tool that requires approval.' })
    const context = { chatId: 'c', modelRef: 'mock:tool-approval', toolCallId: 'mock_call_1', messages: [], signal: new AbortController().signal }
    await expect(mockApprovalTool.execute({ text: 'hi' }, context)).resolves.toEqual({ echoed: 'hi' })
  })
})
