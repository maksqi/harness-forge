// `POST /plugins/drafts/test` (API.md 5.17): a temporary provider built from the draft through the host's declarative
// adapter (nothing is registered or stored), the supplied credentials for this call only, and one action within 15 s:
// `list-models` (the live listing, also for drafts with `listModels: false`) or `ping` (a 1-token generation). A failed
// test is `ok: false` with a mapped error, never an HTTP error. Owner: W3.3.
import type { DeclarativeProvider, ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { DraftTestRequest, DraftTestResult, HarnessErrorInit } from '@harness-forge/shared'
import type { LanguageModelInstance } from '../../providers/types.ts'
import type { AppDeps } from '../../types.ts'
import { performance } from 'node:perf_hooks'
import { draftTestRequestSchema, HarnessError, isHarnessError, validationError } from '@harness-forge/shared'
import { generateText } from 'ai'
import { sanitizeListing } from '../../catalog/listing.ts'
import { defaultProviderError } from '../../providers/errors.ts'
import { createProviderRuntime, VALIDATE_TIMEOUT_MS, withTimeout } from '../../providers/runtime.ts'
import { checkCredentialValues, resolveDraftCredentials } from './credentials.ts'

/** Output budget of the ping: one token, except for the OpenAI Responses API, which rejects less than 16. */
export function pingMaxOutputTokens(provider: Pick<DeclarativeProvider, 'apiFormat'>): number {
  return provider.apiFormat === 'openai-responses' ? 16 : 1
}

/** Characters of the generated text returned by a ping. */
const OUTPUT_MAX_CHARS = 200

export interface DraftTestOptions {
  /** Base fetch of the temporary provider (default `globalThis.fetch`, read at call time). */
  fetch?: typeof globalThis.fetch
  /** Default 15 s (API.md 5.17). */
  timeoutMs?: number
}

function isLanguageModel(value: unknown): value is LanguageModelInstance {
  if (typeof value !== 'object' || value === null)
    return false
  const model = value as Record<string, unknown>
  return typeof model.doGenerate === 'function' && typeof model.doStream === 'function'
}

/** The error of a failed test, in the words of the wizard (no settings actions: the wizard is where it is fixed). */
function testError(deps: AppDeps, provider: DeclarativeProvider, request: DraftTestRequest, error: unknown): HarnessErrorInit {
  if (isHarnessError(error)) {
    const init = HarnessError.from(error).toJSON().error
    return { ...init, message: deps.redactor.redactText(init.message), providerId: provider.id }
  }
  const init = defaultProviderError(error, {
    providerId: provider.id,
    providerName: provider.name,
    redactText: text => deps.redactor.redactText(text),
  })
  const { action: _action, ...rest } = init
  const status = init.status === undefined ? '' : ` (HTTP ${init.status})`
  switch (init.code) {
    case 'auth_invalid':
      return { ...rest, message: `${provider.name} rejected the credentials${status}. Check the key and the auth style.` }
    case 'model_not_found':
      return request.action === 'ping'
        ? { ...rest, message: `${provider.name} does not know the model "${request.modelId ?? ''}"${status}. Check the model id.` }
        : { ...rest, message: `${provider.name} has no model list at this address${status}. Check the base URL or add the models by hand.` }
    case 'provider_unreachable':
      return { ...rest, action: 'retry' }
    default:
      return rest
  }
}

/** Runs one draft test. Throws `validation_error` for an invalid request (unknown credential keys, missing model id). */
export async function runDraftTest(deps: AppDeps, request: DraftTestRequest, options: DraftTestOptions = {}): Promise<DraftTestResult> {
  const parsed = draftTestRequestSchema.safeParse(request)
  if (!parsed.success)
    throw validationError(parsed.error)
  const { provider, action } = parsed.data
  // "Fetch models" must work for a draft that turns the runtime listing off.
  const candidate: DeclarativeProvider = action === 'list-models' && provider.listModels === false ? { ...provider, listModels: true } : provider
  const definition: ProviderDefinition = deps.plugins.declarativeProvider(provider.id, candidate)
  const supplied = checkCredentialValues(definition.credentials, parsed.data.credentials ?? {}, ['credentials'])
  const { values, missing } = resolveDraftCredentials(definition.credentials, supplied)
  if (missing.length > 0) {
    return {
      ok: false,
      latencyMs: 0,
      error: {
        code: 'provider_not_configured',
        message: `Enter ${missing.map(field => field.label).join(', ')} to test the connection.`,
        providerId: provider.id,
      },
    }
  }

  const logger = deps.logger.child({ component: 'plugin-drafts' })
  const started = performance.now()
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - started))
  try {
    const outcome = await withTimeout(options.timeoutMs ?? VALIDATE_TIMEOUT_MS, async (signal): Promise<Pick<DraftTestResult, 'models' | 'output'>> => {
      const rt = createProviderRuntime({ definition, values, signal, logger, redactor: deps.redactor, fetch: options.fetch })
      if (action === 'list-models') {
        if (definition.listModels === undefined)
          throw new HarnessError({ code: 'provider_error', message: `${provider.name} has no model listing.`, providerId: provider.id })
        return { models: sanitizeListing(await definition.listModels(rt)) }
      }
      const model: unknown = definition.createLanguageModel(parsed.data.modelId ?? '', rt)
      if (!isLanguageModel(model))
        throw new HarnessError({ code: 'plugin_error', message: 'The provider did not return a language model.', providerId: provider.id })
      const result = await generateText({
        model,
        prompt: 'ping',
        maxOutputTokens: pingMaxOutputTokens(provider),
        maxRetries: 0,
        abortSignal: signal,
      })
      return { output: result.text.trim().slice(0, OUTPUT_MAX_CHARS) }
    })
    return { ok: true, latencyMs: elapsed(), ...outcome }
  }
  catch (error) {
    logger.debug('draft test failed', { providerId: provider.id, action, err: error })
    return { ok: false, latencyMs: elapsed(), error: testError(deps, provider, parsed.data, error) }
  }
}
