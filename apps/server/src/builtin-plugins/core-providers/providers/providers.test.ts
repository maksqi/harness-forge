import type { ModelInfo, ProviderDefinition, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { credentialFieldSchema, modelInfoSchema } from '@harness-forge/plugin-sdk'
import { BUILTIN_PROVIDER_IDS, modelInfoListSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { fakeRuntime } from '../testing.ts'
import { PROVIDER_DEFINITIONS } from './index.ts'

interface Expected {
  name: string
  /** `LanguageModelV4.provider` of the created model. */
  provider: string
  baseURL: string
  envVar?: string | string[]
  keyUrl: string
  /** Mono slug; `color` tells whether `<slug>-color.svg` exists. */
  icon: string
  color: boolean
  smallModelId?: string
}

// PROVIDERS.md sections 1, 2, 5 and 10.
const EXPECTED: Record<string, Expected> = {
  anthropic: { name: 'Anthropic (Claude)', provider: 'anthropic.messages', baseURL: 'https://api.anthropic.com/v1', envVar: 'ANTHROPIC_API_KEY', keyUrl: 'https://platform.claude.com/settings/keys', icon: 'claude', color: true, smallModelId: 'claude-haiku-4-5' },
  openai: { name: 'OpenAI (ChatGPT)', provider: 'openai.responses', baseURL: 'https://api.openai.com/v1', envVar: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys', icon: 'openai', color: false, smallModelId: 'gpt-6-luna' },
  google: { name: 'Google (Gemini)', provider: 'google.generative-ai', baseURL: 'https://generativelanguage.googleapis.com/v1beta', envVar: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'], keyUrl: 'https://aistudio.google.com/app/apikey', icon: 'gemini', color: true, smallModelId: 'gemini-3.5-flash-lite' },
  xai: { name: 'xAI (Grok)', provider: 'xai.responses', baseURL: 'https://api.x.ai/v1', envVar: 'XAI_API_KEY', keyUrl: 'https://console.x.ai/team/default/api-keys', icon: 'grok', color: false, smallModelId: 'grok-4.3' },
  deepseek: { name: 'DeepSeek', provider: 'deepseek.chat', baseURL: 'https://api.deepseek.com', envVar: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys', icon: 'deepseek', color: true, smallModelId: 'deepseek-flash' },
  moonshotai: { name: 'Moonshot AI (Kimi)', provider: 'moonshotai.chat', baseURL: 'https://api.moonshot.ai/v1', envVar: 'MOONSHOT_API_KEY', keyUrl: 'https://platform.kimi.ai/console/api-keys', icon: 'kimi', color: true, smallModelId: 'kimi-k2.6' },
  alibaba: { name: 'Alibaba (Qwen)', provider: 'alibaba.chat', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', envVar: ['ALIBABA_API_KEY', 'DASHSCOPE_API_KEY'], keyUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key', icon: 'qwen', color: true, smallModelId: 'qwen3.8-flash' },
  zai: { name: 'Z.ai (GLM)', provider: 'zai.chat', baseURL: 'https://api.z.ai/api/paas/v4', envVar: ['ZAI_API_KEY', 'ZHIPU_API_KEY'], keyUrl: 'https://z.ai/manage-apikey/apikey-list', icon: 'zai', color: false, smallModelId: 'glm-5.3-flash' },
  minimax: { name: 'MiniMax', provider: 'minimax.messages', baseURL: 'https://api.minimax.io/anthropic/v1', envVar: 'MINIMAX_API_KEY', keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key', icon: 'minimax', color: true, smallModelId: 'MiniMax-M3' },
  mistral: { name: 'Mistral', provider: 'mistral.chat', baseURL: 'https://api.mistral.ai/v1', envVar: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys', icon: 'mistral', color: true, smallModelId: 'mistral-small-latest' },
  groq: { name: 'Groq', provider: 'groq.chat', baseURL: 'https://api.groq.com/openai/v1', envVar: 'GROQ_API_KEY', keyUrl: 'https://console.groq.com/keys', icon: 'groq', color: false, smallModelId: 'openai/gpt-oss-20b' },
  openrouter: { name: 'OpenRouter', provider: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', envVar: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/settings/keys', icon: 'openrouter', color: true, smallModelId: 'openai/gpt-6-luna' },
  ollama: { name: 'Ollama (local)', provider: 'ollama.chat', baseURL: 'http://localhost:11434/v1', keyUrl: 'https://ollama.com/download', icon: 'ollama', color: false },
}

const EFFORTS: readonly ReasoningEffort[] = ['auto', 'off', 'low', 'medium', 'high', 'max']
const iconDir = join(dirname(createRequire(import.meta.url).resolve('@lobehub/icons-static-svg/package.json')), 'icons')

function expectedOf(definition: ProviderDefinition): Expected {
  const expected = EXPECTED[definition.id]
  if (!expected)
    throw new Error(`No expectation for provider "${definition.id}"`)
  return expected
}

/** Seeds plus a few ids per provider that exercise the model-specific branches of `reasoning()`. */
function sampleModels(definition: ProviderDefinition): ModelInfo[] {
  const extra = ['claude-sonnet-4-5', 'gemini-2.5-flash', 'kimi-k2.5', 'glm-4.6', 'openai/gpt-oss-20b', 'llama3:8b']
  return [...(definition.seedModels ?? []), ...extra.map(id => ({ id, capabilities: { reasoning: true } }))]
}

describe('builtin provider definitions', () => {
  it('registers exactly the builtin provider ids, in DECISIONS order', () => {
    expect(PROVIDER_DEFINITIONS.map(definition => definition.id)).toEqual([...BUILTIN_PROVIDER_IDS])
  })

  describe.each(PROVIDER_DEFINITIONS.map(definition => [definition.id, definition] as const))('%s', (id, definition) => {
    const expected = expectedOf(definition)

    it('has the UI name, key URL, small model and models.dev key of PROVIDERS.md', () => {
      expect(definition.name).toBe(expected.name)
      expect(definition.keyUrl).toBe(expected.keyUrl)
      expect(definition.smallModelId).toBe(expected.smallModelId)
      expect(definition.modelsDevId).toBe(id === 'ollama' ? undefined : id)
    })

    it('uses a bundled LobeHub brand icon', () => {
      if (typeof definition.icon === 'object') {
        // Explicit pair (mono and color slugs differ, e.g. Z.ai: color zhipu-color, mono zai).
        const slugs = [definition.icon.color, definition.icon.mono].filter((s): s is string => Boolean(s))
        expect(slugs.length).toBeGreaterThan(0)
        for (const ref of slugs) {
          expect(ref.startsWith('lobe:')).toBe(true)
          expect(existsSync(join(iconDir, `${ref.slice('lobe:'.length)}.svg`))).toBe(true)
        }
        return
      }
      expect(definition.icon).toBe(`lobe:${expected.icon}`)
      expect(existsSync(join(iconDir, `${expected.icon}.svg`))).toBe(true)
      expect(existsSync(join(iconDir, `${expected.icon}-color.svg`))).toBe(expected.color)
    })

    it('declares valid credential fields with the documented key, env fallbacks and base URL', () => {
      for (const field of definition.credentials)
        expect(credentialFieldSchema.safeParse(field).success, field.key).toBe(true)
      const apiKey = definition.credentials.find(field => field.key === 'apiKey')
      const baseURL = definition.credentials.find(field => field.key === 'baseURL')
      expect(apiKey?.type).toBe('secret')
      expect(baseURL).toMatchObject({ type: 'url', default: expected.baseURL })
      if (id === 'ollama') {
        expect(apiKey).toMatchObject({ required: false, advanced: true })
        expect(apiKey?.envVar).toBeUndefined()
        expect(baseURL).toMatchObject({ required: true })
        expect(baseURL?.advanced).toBeUndefined()
      }
      else {
        expect(apiKey).toMatchObject({ required: true, envVar: expected.envVar })
        expect(baseURL).toMatchObject({ advanced: true })
      }
    })

    it('has seed models that validate against modelInfoSchema', () => {
      const seeds = definition.seedModels ?? []
      expect(modelInfoListSchema.safeParse(seeds).success).toBe(true)
      for (const seed of seeds) {
        expect(modelInfoSchema.safeParse(seed).success, seed.id).toBe(true)
        if (seed.capabilities?.reasoning)
          expect(seed.reasoningEfforts, seed.id).toBeDefined()
      }
      if (id === 'openrouter' || id === 'ollama')
        expect(seeds).toEqual([])
      else
        expect(seeds.length).toBeGreaterThan(0)
    })

    it('creates a provider instance model without network access', () => {
      const { rt, requests } = fakeRuntime({ apiKey: 'test-key' })
      for (const modelId of [...(definition.seedModels ?? []).map(seed => seed.id), 'custom-model:latest']) {
        const model = definition.createLanguageModel(modelId, rt)
        expect(typeof model).toBe('object')
        expect(model.specificationVersion).toBe('v4')
        expect(model.provider).toBe(expected.provider)
        expect(model.modelId).toBe(modelId)
      }
      expect(requests).toEqual([])
    })

    it('honors a base URL override and an unresolved key without throwing', () => {
      const { rt } = fakeRuntime({ baseURL: 'https://proxy.example.com/v1/' })
      expect(definition.createLanguageModel('some-model', rt).modelId).toBe('some-model')
    })

    it('sends nothing for auto and maps every offered effort', () => {
      for (const model of sampleModels(definition)) {
        expect(definition.reasoning?.('auto', model), model.id).toBeUndefined()
        for (const effort of model.reasoningEfforts ?? [])
          expect(definition.reasoning?.(effort, model), `${model.id} ${effort}`).toBeDefined()
        for (const effort of EFFORTS.filter(effort => effort !== 'auto'))
          expect(() => definition.reasoning?.(effort, model)).not.toThrow()
      }
    })

    it('maps errors it does not recognize to undefined', () => {
      expect(definition.mapError?.(new Error('boom'))).toBeUndefined()
      expect(definition.mapError?.('boom')).toBeUndefined()
      expect(definition.mapError?.(undefined)).toBeUndefined()
    })
  })
})
