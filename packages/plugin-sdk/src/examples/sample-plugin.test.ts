import type {
  CommandDefinition,
  Disposable,
  HookHandler,
  HookMap,
  HookName,
  KV,
  PluginContext,
  ProviderDefinition,
  ToolCallContext,
  ToolDefinition,
} from '../index.ts'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { isPluginNamespacedId, modelInfoSchema, pluginManifestSchema } from '@harness-forge/shared'
import { generateText, jsonSchema, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import samplePlugin, { manifest } from './sample-plugin.ts'

function memoryKv<V>(): KV<V> {
  const values = new Map<string, V>()
  return {
    async get<T extends V = V>(key: string) {
      return values.get(key) as T | undefined
    },
    async set(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      values.delete(key)
    },
    async list(prefix = '') {
      return [...values.keys()].filter(key => key.startsWith(prefix))
    },
  }
}

function fakeContext() {
  const disposable: Disposable = { dispose() {} }
  const providers: ProviderDefinition[] = []
  const tools: ToolDefinition[] = []
  const commands: CommandDefinition[] = []
  const hooks: { name: HookName, fn: (...args: never[]) => unknown, priority: number }[] = []
  const logs: string[] = []
  const log = (message: string) => {
    logs.push(message)
  }
  const ctx: PluginContext = {
    plugin: { id: manifest.id, version: manifest.version, dir: '/plugins/sample-kit', dataDir: '/data/plugins/.data/sample-kit' },
    logger: { debug: log, info: log, warn: log, error: log },
    signal: new AbortController().signal,
    settings: {
      get: <T>() => ({ signature: 'Be brief.' }) as T,
      onChange: () => disposable,
    },
    secrets: memoryKv<string>(),
    storage: memoryKv(),
    providers: { register: (definition) => {
      providers.push(definition)
      return disposable
    } },
    models: {
      register: () => disposable,
      resolve: async () => {
        throw new Error('not used')
      },
    },
    tools: { register: (definition) => {
      tools.push(definition)
      return disposable
    } },
    mcp: { register: () => disposable },
    commands: { register: (definition) => {
      commands.push(definition)
      return disposable
    } },
    hooks: { on: (name, fn, options) => {
      hooks.push({ name, fn, priority: options?.priority ?? 0 })
      return disposable
    } },
    ai: { z, tool, jsonSchema, generateText, createOpenAICompatible, createAnthropic, createOpenAI, createGoogleGenerativeAI },
    fetch: globalThis.fetch,
    images: {
      generate: async () => {
        throw new Error('not used')
      },
    },
  }
  return { ctx, providers, tools, commands, hooks, logs }
}

const call: ToolCallContext = {
  chatId: '0199a8f0-0000-7000-8000-000000000001',
  modelRef: 'sample-kit:sample-small',
  toolCallId: 'call_1',
  messages: [],
  signal: new AbortController().signal,
}

describe('sample plugin', () => {
  it('has a valid manifest', () => {
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it('registers a provider, tools, commands and hooks', async () => {
    const { ctx, providers, tools, commands, hooks } = fakeContext()
    await samplePlugin.setup(ctx)
    expect(providers.map(provider => provider.id)).toEqual(['sample-kit'])
    expect(providers.every(provider => isPluginNamespacedId(manifest.id, provider.id))).toBe(true)
    expect(tools.map(definition => definition.name)).toEqual(['sample_word_count', 'sample_echo'])
    expect(commands.map(command => command.name)).toEqual(['sample-tldr', 'sample-count'])
    expect(hooks.map(hook => [hook.name, hook.priority])).toEqual([['chat.params', 10], ['message.completed', 0]])
  })

  it('creates provider instances without network access and maps reasoning', async () => {
    const { ctx, providers } = fakeContext()
    await samplePlugin.setup(ctx)
    const provider = providers[0]!
    const model = provider.createLanguageModel('sample-large', { credentials: { apiKey: 'k' }, fetch: globalThis.fetch })
    expect(model.modelId).toBe('sample-large')
    expect(model.specificationVersion).toBe('v4')
    const info = modelInfoSchema.parse(provider.seedModels?.[0])
    expect(provider.reasoning?.('auto', info)).toBeUndefined()
    expect(provider.reasoning?.('max', info)).toEqual({ reasoning: 'xhigh' })
    expect(provider.mapError?.(Object.assign(new Error('Payment required'), { statusCode: 402 }))).toMatchObject({ code: 'rate_limited' })
    expect(provider.mapError?.(new Error('other'))).toBeUndefined()
  })

  it('creates image model instances and maps image and transcription requests (plugin API 1.1.0)', async () => {
    const { ctx, providers } = fakeContext()
    await samplePlugin.setup(ctx)
    const provider = providers[0]!
    const image = provider.createImageModel?.('sample-image', { credentials: { apiKey: 'k' }, fetch: globalThis.fetch })
    expect(image?.modelId).toBe('sample-image')
    expect(image?.specificationVersion).toBe('v4')
    const info = modelInfoSchema.parse(provider.seedModels?.find(model => model.kind === 'image'))
    expect(provider.imageParams?.({ n: 1, inputs: 0 }, info)).toBeUndefined()
    expect(provider.imageParams?.({ n: 2, aspectRatio: '1:1', inputs: 0 }, info)).toEqual({ size: '1024x1024' })
    expect(provider.imageParams?.({ n: 1, aspectRatio: '16:9', inputs: 1 }, info)).toEqual({ size: '1536x1024' })
    expect(provider.imageParams?.({ n: 1, aspectRatio: '2:3', inputs: 0 }, info)).toEqual({ size: '1024x1536' })
    expect(provider.transcriptionOptions?.({})).toBeUndefined()
    expect(provider.transcriptionOptions?.({ language: 'de' })).toEqual({ 'sample-kit': { language: 'de' } })
    expect(provider.createTranscriptionModel).toBeUndefined()
    expect(provider.createSpeechModel).toBeUndefined()
  })

  it('runs its tools, commands and hooks', async () => {
    const { ctx, tools, commands, hooks } = fakeContext()
    await samplePlugin.setup(ctx)
    const [wordCount, echo] = tools
    await expect(wordCount!.execute({ text: ' one two  three ' }, call)).resolves.toEqual({ words: 3 })
    await expect(echo!.execute({ text: 'hi' }, call)).resolves.toEqual({ echoed: 'hi' })
    const policy = echo!.policy
    expect(typeof policy === 'function' ? await policy({ text: 'x'.repeat(1001) }, call) : policy).toBe('always')
    expect(await commands[1]!.run!({ input: 'a b', chatId: call.chatId, signal: call.signal })).toEqual({ type: 'reply', markdown: '**2** words' })

    const output: HookMap['chat.params'][1] = { instructions: 'Base', maxSteps: 20, providerOptions: {} }
    const input: HookMap['chat.params'][0] = {
      chatId: call.chatId,
      modelRef: call.modelRef,
      model: { id: 'sample-small' },
      reasoningEffort: 'auto',
      toolMode: 'ask',
    }
    const handler = hooks[0]!.fn as HookHandler<'chat.params'>
    handler(input, output)
    expect(output.instructions).toBe('Base\n\nBe brief.')
  })
})
