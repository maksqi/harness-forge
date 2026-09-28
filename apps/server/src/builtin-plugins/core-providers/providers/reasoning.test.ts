import type { ModelInfo, ProviderDefinition, ReasoningEffort, ReasoningParams } from '@harness-forge/plugin-sdk'
import { describe, expect, it } from 'vitest'
import { supportsAdaptiveThinking } from './anthropic.ts'
import { googleReasoningEfforts } from './google.ts'
import { groqReasoningEfforts, usesParsedReasoningFormat } from './groq.ts'
import { PROVIDER_DEFINITIONS } from './index.ts'
import { minimaxReasoningEfforts } from './minimax.ts'
import { mistralReasoningEfforts } from './mistral.ts'
import { moonshotReasoningEfforts } from './moonshotai.ts'
import { ollamaReasoningEfforts } from './ollama.ts'
import { openaiReasoningEfforts } from './openai.ts'
import { openrouterReasoningEfforts } from './openrouter.ts'
import { xaiReasoningEfforts } from './xai.ts'
import { supportsZaiEffort, zaiReasoningEfforts } from './zai.ts'

type Mapping = Partial<Record<Exclude<ReasoningEffort, 'auto'>, ReasoningParams>>

function provider(id: string): ProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find(candidate => candidate.id === id)
  if (!definition)
    throw new Error(`Unknown provider "${id}"`)
  return definition
}

function model(id: string): ModelInfo {
  return { id, capabilities: { reasoning: true } }
}

function expectMapping(providerId: string, modelId: string, mapping: Mapping): void {
  const definition = provider(providerId)
  for (const [effort, params] of Object.entries(mapping) as [ReasoningEffort, ReasoningParams][])
    expect(definition.reasoning?.(effort, model(modelId)), `${providerId} ${modelId} ${effort}`).toEqual(params)
  expect(definition.reasoning?.('auto', model(modelId))).toBeUndefined()
}

function google(reasoning: ReasoningParams['reasoning']): ReasoningParams {
  return {
    reasoning,
    providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
  }
}

// PROVIDERS.md section 4, "Effort -> request mapping".
describe('effort -> request mapping', () => {
  it('anthropic: top-level levels; max is explicit adaptive effort on adaptive models, xhigh budget otherwise', () => {
    const adaptiveMax = { providerOptions: { anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'max' } } }
    expectMapping('anthropic', 'claude-sonnet-5', {
      off: { reasoning: 'none' },
      low: { reasoning: 'low' },
      medium: { reasoning: 'medium' },
      high: { reasoning: 'high' },
      max: adaptiveMax,
    })
    expectMapping('anthropic', 'claude-opus-5-5', { max: adaptiveMax })
    expectMapping('anthropic', 'claude-haiku-4-5', { high: { reasoning: 'high' }, max: { reasoning: 'xhigh' } })
    expectMapping('anthropic', 'claude-sonnet-4-5-20250929', { max: { reasoning: 'xhigh' } })
  })

  it('openai: top-level levels, max via providerOptions', () => {
    expectMapping('openai', 'gpt-6-sol', {
      off: { reasoning: 'none' },
      low: { reasoning: 'low' },
      medium: { reasoning: 'medium' },
      high: { reasoning: 'high' },
      max: { providerOptions: { openai: { reasoningEffort: 'max' } } },
    })
  })

  it('google: top-level levels plus includeThoughts; off is plain none', () => {
    expectMapping('google', 'gemini-2.5-flash', {
      off: { reasoning: 'none' },
      low: google('low'),
      medium: google('medium'),
      high: google('high'),
      max: google('xhigh'),
    })
  })

  it.each(['xai', 'deepseek', 'moonshotai', 'alibaba'])('%s: portable top-level levels (max -> xhigh)', (id) => {
    expectMapping(id, 'any-model', {
      off: { reasoning: 'none' },
      low: { reasoning: 'low' },
      high: { reasoning: 'high' },
      max: { reasoning: 'xhigh' },
    })
  })

  it('xai, moonshotai and alibaba pass medium through; deepseek maps it to high', () => {
    expect(provider('xai').reasoning?.('medium', model('grok-4.3'))).toEqual({ reasoning: 'medium' })
    expect(provider('alibaba').reasoning?.('medium', model('qwen3.8-max'))).toEqual({ reasoning: 'medium' })
    expect(provider('deepseek').reasoning?.('medium', model('deepseek-flash'))).toEqual({ reasoning: 'high' })
  })

  it('zai: thinking + reasoningEffort on GLM-5.2+, thinking only before', () => {
    expectMapping('zai', 'glm-5.3', {
      off: { providerOptions: { zai: { thinking: { type: 'disabled' } } } },
      low: { providerOptions: { zai: { thinking: { type: 'enabled' }, reasoningEffort: 'low' } } },
      medium: { providerOptions: { zai: { thinking: { type: 'enabled' }, reasoningEffort: 'medium' } } },
      high: { providerOptions: { zai: { thinking: { type: 'enabled' }, reasoningEffort: 'high' } } },
      max: { providerOptions: { zai: { thinking: { type: 'enabled' }, reasoningEffort: 'max' } } },
    })
    expectMapping('zai', 'glm-4.6', {
      off: { providerOptions: { zai: { thinking: { type: 'disabled' } } } },
      high: { providerOptions: { zai: { thinking: { type: 'enabled' } } } },
    })
  })

  it('minimax: always providerOptions (disabled / adaptive)', () => {
    expectMapping('minimax', 'MiniMax-M3', {
      off: { providerOptions: { minimax: { thinking: { type: 'disabled' } } } },
      high: { providerOptions: { minimax: { thinking: { type: 'adaptive' } } } },
    })
  })

  it('mistral: none / high only', () => {
    expectMapping('mistral', 'mistral-medium-2604', {
      off: { reasoning: 'none' },
      low: { reasoning: 'high' },
      high: { reasoning: 'high' },
    })
  })

  it('groq: off via providerOptions, levels top-level', () => {
    expectMapping('groq', 'qwen/qwen3.8-27b', {
      off: { providerOptions: { groq: { reasoningEffort: 'none' } } },
      low: { reasoning: 'low' },
      medium: { reasoning: 'medium' },
      high: { reasoning: 'high' },
    })
  })

  it('openrouter: always providerOptions.openrouter.reasoning.effort', () => {
    expectMapping('openrouter', 'openai/gpt-6-luna', {
      off: { providerOptions: { openrouter: { reasoning: { effort: 'none' } } } },
      low: { providerOptions: { openrouter: { reasoning: { effort: 'low' } } } },
      medium: { providerOptions: { openrouter: { reasoning: { effort: 'medium' } } } },
      high: { providerOptions: { openrouter: { reasoning: { effort: 'high' } } } },
      max: { providerOptions: { openrouter: { reasoning: { effort: 'xhigh' } } } },
    })
  })

  it('ollama: top-level levels, max via providerOptions', () => {
    expectMapping('ollama', 'gpt-oss:20b', {
      off: { reasoning: 'none' },
      low: { reasoning: 'low' },
      medium: { reasoning: 'medium' },
      high: { reasoning: 'high' },
      max: { providerOptions: { ollama: { reasoningEffort: 'max' } } },
    })
  })
})

describe('efforts offered per model', () => {
  it('anthropic: adaptive thinking follows the package model rules', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-future-9'])
      expect(supportsAdaptiveThinking(id), id).toBe(true)
    for (const id of ['claude-haiku-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'my-proxy-model'])
      expect(supportsAdaptiveThinking(id), id).toBe(false)
  })

  it('openai: by model id', () => {
    expect(openaiReasoningEfforts('gpt-6-sol')).toEqual(['off', 'low', 'medium', 'high', 'max'])
    expect(openaiReasoningEfforts('gpt-6-astra')).toEqual(['low', 'medium', 'high', 'max'])
    expect(openaiReasoningEfforts('gpt-5.6')).toEqual(['off', 'low', 'medium', 'high', 'max'])
    expect(openaiReasoningEfforts('gpt-5.2')).toEqual(['off', 'low', 'medium', 'high'])
    expect(openaiReasoningEfforts('gpt-5-mini')).toEqual(['low', 'medium', 'high'])
    expect(openaiReasoningEfforts('o4-mini')).toEqual(['low', 'medium', 'high'])
    expect(openaiReasoningEfforts('gpt-5-chat-latest')).toBeUndefined()
    expect(openaiReasoningEfforts('gpt-4.1')).toBeUndefined()
  })

  it('google: Gemini 3+ cannot disable thinking; 2.5 Pro cannot use budget 0', () => {
    expect(googleReasoningEfforts('gemini-3.8-flash')).toEqual(['low', 'medium', 'high'])
    expect(googleReasoningEfforts('gemini-flash-latest')).toEqual(['low', 'medium', 'high'])
    expect(googleReasoningEfforts('gemini-2.5-flash')).toEqual(['off', 'low', 'medium', 'high', 'max'])
    expect(googleReasoningEfforts('gemini-2.5-pro')).toEqual(['low', 'medium', 'high', 'max'])
    expect(googleReasoningEfforts('gemini-2.0-flash')).toBeUndefined()
    expect(googleReasoningEfforts('gemma-3-27b-it')).toBeUndefined()
  })

  it('xai: per model; grok-4.20 variants have no effort', () => {
    expect(xaiReasoningEfforts('grok-4.3')).toEqual(['off', 'low', 'medium', 'high'])
    expect(xaiReasoningEfforts('grok-4.6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(xaiReasoningEfforts('grok-4.20-reasoning')).toEqual([])
    expect(xaiReasoningEfforts('grok-4.20-0309-non-reasoning')).toBeUndefined()
  })

  it('moonshotai, zai, minimax, mistral, groq: per model id', () => {
    expect(moonshotReasoningEfforts('kimi-k3')).toEqual(['low', 'high', 'max'])
    expect(moonshotReasoningEfforts('kimi-k2.6')).toEqual(['off', 'high'])
    expect(moonshotReasoningEfforts('kimi-k2.7-code')).toEqual([])
    expect(moonshotReasoningEfforts('moonshot-v1-8k')).toBeUndefined()
    expect(supportsZaiEffort('glm-5.2')).toBe(true)
    expect(supportsZaiEffort('glm-5-turbo')).toBe(false)
    expect(zaiReasoningEfforts('glm-4.5-air')).toEqual(['off', 'high'])
    expect(minimaxReasoningEfforts('MiniMax-M3')).toEqual(['off', 'high'])
    expect(minimaxReasoningEfforts('MiniMax-M3.1-Flash-Preview')).toEqual([])
    expect(minimaxReasoningEfforts('MiniMax-M2.7')).toEqual([])
    expect(mistralReasoningEfforts('magistral-medium-latest')).toEqual(['off', 'high'])
    expect(mistralReasoningEfforts('mistral-large-2512')).toBeUndefined()
    expect(groqReasoningEfforts('openai/gpt-oss-120b')).toEqual(['low', 'medium', 'high'])
    expect(groqReasoningEfforts('qwen/qwen3.8-27b')).toEqual(['off', 'low', 'medium', 'high'])
    expect(usesParsedReasoningFormat('qwen/qwen3-32b')).toBe(true)
    expect(usesParsedReasoningFormat('openai/gpt-oss-120b')).toBe(false)
    expect(usesParsedReasoningFormat('llama-3.3-70b-versatile')).toBe(false)
  })

  it('openrouter: from reasoning.supported_efforts, else the PROVIDERS.md default', () => {
    expect(openrouterReasoningEfforts(undefined)).toEqual(['off', 'low', 'medium', 'high'])
    expect(openrouterReasoningEfforts({ supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'] })).toEqual(['off', 'low', 'medium', 'high', 'max'])
    expect(openrouterReasoningEfforts({ mandatory: true, supported_efforts: ['high', 'medium', 'low', 'none'] })).toEqual(['low', 'medium', 'high'])
  })

  it('ollama: from /api/show thinking.values', () => {
    expect(ollamaReasoningEfforts([])).toBeUndefined()
    expect(ollamaReasoningEfforts([false, true])).toEqual(['off', 'high'])
    expect(ollamaReasoningEfforts([true])).toEqual([])
    expect(ollamaReasoningEfforts(['low', 'medium', 'high'])).toEqual(['low', 'medium', 'high'])
    expect(ollamaReasoningEfforts([false, 'low', 'high', 'max'])).toEqual(['off', 'low', 'high', 'max'])
  })
})
