import type { HarnessErrorInit, ProviderDefinition } from '@harness-forge/plugin-sdk'
import { HarnessError, harnessErrorInitSchema } from '@harness-forge/shared'
import { RetryError, StreamProviderError } from 'ai'
import { describe, expect, it } from 'vitest'
import { apiError } from '../testing.ts'
import { PROVIDER_DEFINITIONS } from './index.ts'

function provider(id: string): ProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find(candidate => candidate.id === id)
  if (!definition)
    throw new Error(`Unknown provider "${id}"`)
  return definition
}

function refused(url: string, code = 'ECONNREFUSED'): unknown {
  const cause = new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) })
  return apiError({ message: 'Cannot connect to API: fetch failed', url, cause })
}

type Case = [providerId: string, label: string, error: unknown, expected: Partial<HarnessErrorInit>]

const CASES: Case[] = [
  // anthropic
  ['anthropic', '401 authentication_error', apiError({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'API key is invalid.' } } }), { code: 'auth_invalid', status: 401, action: 'configure-provider' }],
  ['anthropic', '529 overloaded_error', apiError({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }), { code: 'provider_error', status: 529, action: 'retry' }],
  ['anthropic', '429 with retry-after', apiError({ status: 429, headers: { 'retry-after': '17' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } } }), { code: 'rate_limited', retryAfterMs: 17_000, action: 'retry' }],
  ['anthropic', 'prompt is too long', apiError({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } } }), { code: 'context_overflow', status: 400 }],
  ['anthropic', '404 unknown model', apiError({ status: 404, model: 'claude-nope', body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope' } } }), { code: 'model_not_found', action: 'refresh-models' }],
  ['anthropic', 'credit balance too low', apiError({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }), { code: 'provider_error' }],
  ['anthropic', 'in-stream overloaded error', new StreamProviderError({ message: 'Overloaded', type: 'overloaded_error', statusCode: 529, isRetryable: true }), { code: 'provider_error', action: 'retry' }],
  ['anthropic', 'DNS failure', refused('https://api.anthropic.com/v1/messages', 'ENOTFOUND'), { code: 'provider_unreachable', message: 'Cannot reach Anthropic at https://api.anthropic.com. Check the network connection and the base URL.' }],
  // openai
  ['openai', '401 invalid_api_key', apiError({ status: 401, body: { error: { message: 'Incorrect API key provided: sk-inval*******-key. You can find your API key at https://platform.openai.com/account/api-keys.', type: 'invalid_request_error', code: 'invalid_api_key' } } }), { code: 'auth_invalid' }],
  ['openai', '429 insufficient_quota is billing, not a rate limit', apiError({ status: 429, body: { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } } }), { code: 'provider_error', status: 429 }],
  ['openai', '429 with retry-after-ms', apiError({ status: 429, headers: { 'retry-after-ms': '1500' }, body: { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } } }), { code: 'rate_limited', retryAfterMs: 1500 }],
  ['openai', 'context_length_exceeded', apiError({ status: 400, body: { error: { message: 'Your input exceeds the context window of this model.', type: 'invalid_request_error', code: 'context_length_exceeded' } } }), { code: 'context_overflow' }],
  ['openai', '404 model_not_found', apiError({ status: 404, model: 'gpt-7', body: { error: { message: 'The model `gpt-7` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } } }), { code: 'model_not_found', message: 'The model "gpt-7" was not found at OpenAI. Refresh the model list or pick another model.' }],
  ['openai', 'retries exhausted', new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [apiError({ status: 500 }), apiError({ status: 429, headers: { 'retry-after': '2' } })] }), { code: 'rate_limited', retryAfterMs: 2000 }],
  // google
  ['google', '400 API_KEY_INVALID', apiError({ status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', 'reason': 'API_KEY_INVALID', 'domain': 'googleapis.com' }] } } }), { code: 'auth_invalid', status: 400, action: 'configure-provider' }],
  ['google', '429 RESOURCE_EXHAUSTED with RetryInfo', apiError({ status: 429, body: { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '34s' }] } } }), { code: 'rate_limited', retryAfterMs: 34_000 }],
  ['google', '404 unknown model', apiError({ status: 404, body: { error: { code: 404, message: 'models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.', status: 'NOT_FOUND' } } }), { code: 'model_not_found' }],
  ['google', 'input token count exceeds', apiError({ status: 400, body: { error: { code: 400, message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } } }), { code: 'context_overflow' }],
  // xai
  ['xai', '400 incorrect API key', apiError({ status: 400, body: { code: 'invalid-argument', error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' } }), { code: 'auth_invalid', status: 400 }],
  ['xai', '403 without credits', apiError({ status: 403, body: { code: 'permission-denied', error: 'Your newly created team doesn\'t have any credits yet.' } }), { code: 'provider_error', status: 403 }],
  // deepseek
  ['deepseek', '402 insufficient balance', apiError({ status: 402, body: { error: { message: 'Insufficient Balance', type: 'unknown_error' } } }), { code: 'provider_error', message: 'DeepSeek account balance is insufficient. Top up the account and try again.' }],
  ['deepseek', '401 authentication fails', apiError({ status: 401, body: { error: { message: 'Authentication Fails, Your api key: ****-key is invalid', type: 'authentication_error', code: 'invalid_request_error' } } }), { code: 'auth_invalid' }],
  // moonshotai
  ['moonshotai', '429 exceeded_current_quota_error', apiError({ status: 429, body: { error: { message: 'Your account is suspended, please check your plan and billing details', type: 'exceeded_current_quota_error' } } }), { code: 'provider_error' }],
  ['moonshotai', 'model token limit', apiError({ status: 400, body: { error: { message: 'Invalid request: Your request exceeded model token limit: 262144', type: 'invalid_request_error' } } }), { code: 'context_overflow' }],
  ['moonshotai', '429 engine_overloaded_error', apiError({ status: 429, body: { error: { message: 'The engine is currently overloaded, please try again later', type: 'engine_overloaded_error' } } }), { code: 'rate_limited' }],
  // alibaba
  ['alibaba', '401 invalid_api_key', apiError({ status: 401, body: { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } } }), { code: 'auth_invalid' }],
  ['alibaba', 'Arrearage', apiError({ status: 400, body: { error: { code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' } } }), { code: 'provider_error' }],
  ['alibaba', 'input length range', apiError({ status: 400, body: { error: { code: 'InvalidParameter', message: 'Range of input length should be [1, 129024]' } } }), { code: 'context_overflow' }],
  // zai
  ['zai', '1211 model does not exist', apiError({ status: 400, model: 'glm-9', body: { error: { code: '1211', message: 'Unknown Model, please check the model code.' } } }), { code: 'model_not_found', message: 'The model "glm-9" does not exist at Z.ai.', action: 'refresh-models' }],
  ['zai', '1113 balance', apiError({ status: 429, body: { error: { code: '1113', message: 'Insufficient balance or no resource package.' } } }), { code: 'provider_error' }],
  ['zai', '1302 rate limit', apiError({ status: 429, body: { error: { code: '1302', message: 'High concurrency usage of this API.' } } }), { code: 'rate_limited' }],
  ['zai', '1261 prompt too long', apiError({ status: 400, body: { error: { code: '1261', message: 'Prompt exceeds max length' } } }), { code: 'context_overflow' }],
  ['zai', '401 token expired or incorrect', apiError({ status: 401, body: { error: { code: '401', message: 'token expired or incorrect' } } }), { code: 'auth_invalid' }],
  // minimax
  ['minimax', '401 login fail', apiError({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'login fail: Please carry the API secret key in the \'X-Api-Key\' field of the request header' } } }), { code: 'auth_invalid' }],
  ['minimax', 'base_resp 1008', apiError({ status: 400, body: { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } } }), { code: 'provider_error', message: 'The MiniMax account balance is insufficient. Top up the account and try again.' }],
  ['minimax', '529 overloaded', apiError({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }), { code: 'provider_error', action: 'retry' }],
  // mistral
  ['mistral', '401 detail', apiError({ status: 401, body: { detail: 'Invalid API Key' } }), { code: 'auth_invalid' }],
  ['mistral', 'invalid model', apiError({ status: 400, body: { object: 'error', message: 'Invalid model: mistral-nope', type: 'invalid_model', param: null, code: '1500' } }), { code: 'model_not_found' }],
  // groq
  ['groq', '413 request too large (TPM)', apiError({ status: 413, body: { error: { message: 'Request too large for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 12000, Requested 30000, please reduce your message size and try again.', type: 'tokens', code: 'rate_limit_exceeded' } } }), { code: 'context_overflow', status: 413 }],
  ['groq', '429 with retry-after', apiError({ status: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } } }), { code: 'rate_limited', retryAfterMs: 7000 }],
  // openrouter
  ['openrouter', '402 no credits', apiError({ status: 402, body: { error: { message: 'Insufficient credits', code: 402 } } }), { code: 'provider_error', message: 'OpenRouter credits are exhausted. Add credits and try again.' }],
  ['openrouter', 'not a valid model ID', apiError({ status: 400, body: { error: { message: 'openai/gpt-nope is not a valid model ID', code: 400 } } }), { code: 'model_not_found' }],
  ['openrouter', '401 user not found', apiError({ status: 401, body: { error: { message: 'User not found.', code: 401 } } }), { code: 'auth_invalid' }],
  // ollama
  ['ollama', 'connection refused', refused('http://localhost:11434/v1/chat/completions'), { code: 'provider_unreachable', message: 'Cannot reach Ollama at http://localhost:11434. Is Ollama running?', action: 'retry' }],
  ['ollama', 'model not pulled', apiError({ status: 404, model: 'llama9:8b', body: { error: { message: 'model "llama9:8b" not found, try pulling it first', type: 'api_error' } } }), { code: 'model_not_found', message: 'The model "llama9:8b" is not installed in Ollama. Run "ollama pull llama9:8b" on the Ollama host.' }],
]

describe('mapError', () => {
  it.each(CASES)('%s: %s', (providerId, _label, error, expected) => {
    const result = provider(providerId).mapError?.(error)
    expect(result).toMatchObject({ providerId, ...expected })
    expect(harnessErrorInitSchema.safeParse(result).success).toBe(true)
  })

  it('never copies key fragments from vendor messages', () => {
    const result = provider('openai').mapError?.(CASES[8]?.[2])
    expect(result?.message).not.toContain('sk-')
    expect(JSON.stringify(result)).not.toContain('sk-inval')
    expect(result?.details).toEqual({ upstream: expect.stringContaining('[redacted]') })
  })

  it('leaves server errors, unknown errors and HarnessErrors to the default mapping', () => {
    for (const definition of PROVIDER_DEFINITIONS) {
      expect(definition.mapError?.(apiError({ status: 500, body: { error: { message: 'Internal error' } } })), definition.id).toBeUndefined()
      expect(definition.mapError?.(apiError({ status: 503, body: { error: { message: 'The model `x` is currently not available due to high demand.' } } })), definition.id).toBeUndefined()
      expect(definition.mapError?.(new HarnessError({ code: 'provider_not_configured', message: 'Not configured.' })), definition.id).toBeUndefined()
      expect(definition.mapError?.(new DOMException('The operation was aborted.', 'AbortError')), definition.id).toBeUndefined()
    }
  })
})
