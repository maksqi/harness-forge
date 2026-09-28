// Model wrappers for always-on request options (PROVIDERS.md section 2) and the 1-token credential ping.
import type { LanguageModelV3, LanguageModelV4 } from '@ai-sdk/provider'
import type { ProviderOptions, ProviderRuntime } from '@harness-forge/plugin-sdk'
import { defaultSettingsMiddleware, generateText, wrapLanguageModel } from 'ai'
import { statusOf } from './http.ts'

/** Settings merged under every call of a wrapped model (call values win; provider options are deep-merged). */
export interface DefaultSettings {
  providerOptions?: ProviderOptions
  maxOutputTokens?: number
}

/**
 * `wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({ settings }) })`: keeps `provider` and `modelId`
 * of the wrapped model.
 */
export function withDefaultSettings(model: LanguageModelV4 | LanguageModelV3, settings: DefaultSettings): LanguageModelV4 {
  return wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({ settings }) })
}

/**
 * Credential test for providers whose model listing cannot prove the key: one tiny generation, no retries. Throws the
 * provider error (mapped by `mapError`) when the key is rejected.
 */
export async function pingModel(model: LanguageModelV4 | LanguageModelV3, rt: ProviderRuntime, providerOptions?: ProviderOptions): Promise<void> {
  await generateText({
    model,
    prompt: 'ping',
    maxOutputTokens: 16,
    maxRetries: 0,
    abortSignal: rt.signal,
    providerOptions,
  })
}

/**
 * Credential test through a cheap endpoint (`check`); when that endpoint does not exist behind the configured base URL
 * (HTTP 404 / 405, e.g. a proxy), `ping` proves the key instead. Every other failure is rethrown.
 */
export async function checkOrPing(check: () => Promise<unknown>, ping: () => Promise<void>): Promise<void> {
  try {
    await check()
  }
  catch (error) {
    const status = statusOf(error)
    if (status !== 404 && status !== 405)
      throw error
    await ping()
  }
}
