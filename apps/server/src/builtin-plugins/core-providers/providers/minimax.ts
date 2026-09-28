// MiniMax: `@ai-sdk/minimax` on the Anthropic-compatible endpoint (PROVIDERS.md sections 1-6). The package reuses the
// Anthropic internals, whose top-level `reasoning` would request budget thinking, so reasoning always goes through
// `providerOptions.minimax` (MiniMax accepts only `adaptive` / `disabled`).
import type { ModelInfo, ProviderDefinition, ReasoningEffort } from '@harness-forge/plugin-sdk'
import type { ErrorRule } from '../lib/errors.ts'
import type { JsonRecord } from '../lib/json.ts'
import { createMiniMax } from '@ai-sdk/minimax'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapped, mapProviderError, overloadedRule, retryAfterMs } from '../lib/errors.ts'
import { stringOf } from '../lib/json.ts'
import { withDefaultSettings } from '../lib/language-model.ts'
import { modelInfo } from '../lib/models.ts'
import { ON_OFF_EFFORTS } from '../lib/reasoning.ts'
import { ANTHROPIC_VERSION, listAnthropicShapedModels } from './anthropic.ts'

const PROVIDER = { id: 'minimax', name: 'MiniMax' }
export const MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic/v1'

const M3_FAMILY = /^minimax-m3(?:$|[-.])/i
/** M3.1 and later always think (depth via `output_config.effort`, not mapped); `disabled` is rejected with HTTP 400. */
const ALWAYS_THINKING_M3 = /^minimax-m3\.\d/i
/** M2.x models always think; `disabled` is accepted but ignored. */
const M2_FAMILY = /^minimax-m2(?:$|[-.])/i

/**
 * Default `max_tokens` (the MiniMax recommendation): 128K for the M3 family, 64K for the others. The Anthropic
 * internals would otherwise cap unknown (non-Claude) models at 4096 output tokens, thinking included. A call value
 * still wins.
 */
export function minimaxDefaultMaxOutputTokens(modelId: string): number {
  return M3_FAMILY.test(modelId) ? 131_072 : 65_536
}

/** Efforts offered for a model id: MiniMax-M3 switches thinking on (`adaptive`) and off; M3.1+ and M2.x always think. */
export function minimaxReasoningEfforts(modelId: string): ReasoningEffort[] | undefined {
  if (ALWAYS_THINKING_M3.test(modelId) || M2_FAMILY.test(modelId))
    return []
  if (M3_FAMILY.test(modelId))
    return [...ON_OFF_EFFORTS]
  return undefined
}

/** `base_resp.status_code` values of the MiniMax API. */
const minimaxCodeRule: ErrorRule = (facts, provider) => {
  const has = (...codes: string[]) => codes.some(code => facts.codes.has(code))
  if (has('1004', '2049'))
    return mapped(facts, provider, { code: 'auth_invalid', message: 'The MiniMax API key was rejected. Check the key in Settings > Providers.', action: 'configure-provider' })
  if (has('1008'))
    return mapped(facts, provider, { code: 'provider_error', message: 'The MiniMax account balance is insufficient. Top up the account and try again.' })
  if (has('2056'))
    return mapped(facts, provider, { code: 'rate_limited', message: 'The MiniMax usage limit is reached. Wait for the next usage window.', action: 'retry', retryAfterMs: retryAfterMs(facts) })
  if (has('1002', '1039', '1041', '2045'))
    return mapped(facts, provider, { code: 'rate_limited', message: 'MiniMax rate limit reached. Try again shortly.', action: 'retry', retryAfterMs: retryAfterMs(facts) })
  return undefined
}

function toModelInfo(entry: JsonRecord): ModelInfo | undefined {
  const id = stringOf(entry.id)
  if (!id)
    return undefined
  const efforts = minimaxReasoningEfforts(id)
  return modelInfo({
    id,
    name: stringOf(entry.display_name),
    capabilities: {
      tools: true,
      vision: M3_FAMILY.test(id) ? true : M2_FAMILY.test(id) ? false : undefined,
      reasoning: efforts ? true : undefined,
    },
    reasoningEfforts: efforts,
  })
}

export const minimaxProvider: ProviderDefinition = {
  id: 'minimax',
  name: 'MiniMax',
  icon: 'lobe:minimax',
  credentials: [apiKeyField('MINIMAX_API_KEY'), baseUrlField(MINIMAX_BASE_URL)],
  modelsDevId: 'minimax',
  keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  smallModelId: 'MiniMax-M3',
  seedModels: [
    {
      id: 'MiniMax-M3',
      name: 'MiniMax-M3',
      contextWindow: 1_000_000,
      maxOutputTokens: 524_288,
      capabilities: { tools: true, vision: true, reasoning: true },
      reasoningEfforts: ['off', 'high'],
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06 },
    },
  ],
  createLanguageModel(modelId, rt) {
    const model = createMiniMax({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, MINIMAX_BASE_URL), fetch: rt.fetch })(modelId)
    return withDefaultSettings(model, { maxOutputTokens: minimaxDefaultMaxOutputTokens(modelId) })
  },
  listModels(rt) {
    return listAnthropicShapedModels(rt, {
      providerName: PROVIDER.name,
      baseUrl: baseUrlOf(rt, MINIMAX_BASE_URL),
      headers: { 'x-api-key': apiKeyOf(rt), 'anthropic-version': ANTHROPIC_VERSION },
      map: toModelInfo,
    })
  },
  reasoning(effort) {
    if (effort === 'auto')
      return undefined
    // Only `off` and `high` are offered; any other level also means "thinking on".
    return { providerOptions: { minimax: { thinking: { type: effort === 'off' ? 'disabled' : 'adaptive' } } } }
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER, [overloadedRule, minimaxCodeRule])
  },
}
