// Z.ai (GLM): `@ai-sdk/zai` (PROVIDERS.md sections 1-6). General keys and GLM Coding Plan keys use different base URLs
// and are not interchangeable.
import type { ModelInfo, ProviderDefinition, ProviderRuntime, ReasoningEffort } from '@harness-forge/plugin-sdk'
import type { ErrorRule } from '../lib/errors.ts'
import { createZai } from '@ai-sdk/zai'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapped, mapProviderError, retryAfterMs } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { recordOf, stringOf } from '../lib/json.ts'
import { checkOrPing, pingModel } from '../lib/language-model.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { ON_OFF_EFFORTS } from '../lib/reasoning.ts'

const PROVIDER = { id: 'zai', name: 'Z.ai' }
export const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4'
const SMALL_MODEL_ID = 'glm-5.3-flash'
const GLM_VERSION = /glm-(\d+)(?:\.(\d+))?/i

/** `reasoningEffort` applies to GLM-5.2 and later; earlier GLM models only switch thinking on and off. */
export function supportsZaiEffort(modelId: string): boolean {
  const match = modelId.match(GLM_VERSION)
  if (!match)
    return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 5 || (major === 5 && minor >= 2)
}

/** Efforts offered for a GLM model id; `undefined` for other ids. */
export function zaiReasoningEfforts(modelId: string): ReasoningEffort[] | undefined {
  if (!GLM_VERSION.test(modelId))
    return undefined
  return supportsZaiEffort(modelId) ? ['off', 'low', 'medium', 'high', 'max'] : [...ON_OFF_EFFORTS]
}

/** Business error codes of the Z.ai API (`error.code`), sent with HTTP 400 / 401 / 429. */
const zaiCodeRule: ErrorRule = (facts, provider) => {
  const has = (...codes: string[]) => codes.some(code => facts.codes.has(code))
  if (has('1000', '1001', '1002', '1003', '1004')) {
    return mapped(facts, provider, {
      code: 'auth_invalid',
      message: 'The Z.ai API key was rejected. General keys and GLM Coding Plan keys use different base URLs.',
      action: 'configure-provider',
    })
  }
  if (has('1113'))
    return mapped(facts, provider, { code: 'provider_error', message: 'The Z.ai account balance is insufficient. Top up the account and try again.' })
  if (has('1211'))
    return mapped(facts, provider, { code: 'model_not_found', message: facts.modelId ? `The model "${facts.modelId}" does not exist at Z.ai.` : 'The model does not exist at Z.ai.', action: 'refresh-models' })
  if (has('1261'))
    return mapped(facts, provider, { code: 'context_overflow', message: 'The request is too long for the context window of this model. Shorten the conversation or remove attachments.' })
  if (has('1302', '1303', '1305'))
    return mapped(facts, provider, { code: 'rate_limited', message: 'Z.ai rate limit reached. Try again shortly.', action: 'retry', retryAfterMs: retryAfterMs(facts) })
  if (has('1304', '1308', '1310'))
    return mapped(facts, provider, { code: 'provider_error', message: 'The Z.ai usage limit of this key or plan is reached.' })
  return undefined
}

function createZaiModel(modelId: string, rt: ProviderRuntime) {
  return createZai({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, ZAI_BASE_URL), fetch: rt.fetch })(modelId)
}

async function listZaiModels(rt: ProviderRuntime): Promise<ModelInfo[]> {
  const body = recordOf(await requestJson(rt, `${baseUrlOf(rt, ZAI_BASE_URL)}/models`, {
    headers: { authorization: `Bearer ${apiKeyOf(rt)}` },
  }))
  if (!body || !Array.isArray(body.data))
    throw unexpectedListing(PROVIDER.name)
  const models: ModelInfo[] = []
  for (const entry of body.data) {
    const id = stringOf(recordOf(entry)?.id)
    if (!id)
      continue
    const efforts = zaiReasoningEfforts(id)
    models.push(modelInfo({ id, capabilities: { reasoning: efforts ? true : undefined }, reasoningEfforts: efforts }))
  }
  return finalizeListing(models)
}

export const zaiProvider: ProviderDefinition = {
  id: 'zai',
  name: 'Z.ai (GLM)',
  icon: { color: 'lobe:zhipu-color', mono: 'lobe:zai' },
  credentials: [apiKeyField(['ZAI_API_KEY', 'ZHIPU_API_KEY']), baseUrlField(ZAI_BASE_URL)],
  modelsDevId: 'zai',
  keyUrl: 'https://z.ai/manage-apikey/apikey-list',
  smallModelId: SMALL_MODEL_ID,
  seedModels: [
    {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      capabilities: { tools: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'],
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26 },
    },
    {
      id: 'glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'],
      cost: { input: 0.15, output: 0.5, cacheRead: 0.03 },
    },
  ],
  createLanguageModel: createZaiModel,
  listModels: listZaiModels,
  validate(rt) {
    // `/models` is documented for the Coding Plan endpoint only; without it, a tiny call proves the key.
    return checkOrPing(
      () => listZaiModels(rt),
      () => pingModel(createZaiModel(SMALL_MODEL_ID, rt), rt, { zai: { thinking: { type: 'disabled' } } }),
    )
  },
  reasoning(effort, model) {
    if (effort === 'auto')
      return undefined
    if (effort === 'off')
      return { providerOptions: { zai: { thinking: { type: 'disabled' } } } }
    if (!supportsZaiEffort(model.id))
      return { providerOptions: { zai: { thinking: { type: 'enabled' } } } }
    return { providerOptions: { zai: { thinking: { type: 'enabled' }, reasoningEffort: effort } } }
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER, [zaiCodeRule])
  },
}
