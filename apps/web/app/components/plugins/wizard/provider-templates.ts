// Declarative provider templates of the wizard's API step (docs/PROVIDERS.md 9). Each one prefills the provider; every
// field stays editable. `id` is the suggested plugin id.
import type { ApiFormat, ReasoningStyle } from '@harness-forge/shared'

export type ProviderTemplateId = 'together-ai' | 'fireworks' | 'lmstudio' | 'vllm' | 'litellm'

export interface ProviderTemplate {
  /** Suggested plugin (and provider) id. */
  id: ProviderTemplateId
  /** Button label and provider name. */
  name: string
  /** One line under the button. */
  hint: string
  baseURL: string
  apiFormat: ApiFormat
  /** `bearer` with an `apiKey` field (required or optional), or `none` without credentials. */
  auth: 'bearer' | 'none'
  apiKeyRequired: boolean
  /** "Get a key" link (`helpUrl` of the `apiKey` field). */
  keyUrl?: string
  /** `exclude` filter of the runtime listing (JavaScript regular expression source, flag `i`). */
  listExclude?: string
  reasoningStyle: ReasoningStyle
  modelsDevId?: string
  /** LobeHub slug; none = monogram. */
  icon?: string
}

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'together-ai',
    name: 'Together AI',
    hint: 'Cloud, open models',
    baseURL: 'https://api.together.xyz/v1',
    apiFormat: 'openai-chat',
    auth: 'bearer',
    apiKeyRequired: true,
    keyUrl: 'https://api.together.ai/settings/api-keys',
    listExclude: 'embed|rerank|whisper|flux|stable-diffusion|tts|guard',
    reasoningStyle: 'openai-effort',
    modelsDevId: 'togetherai',
    icon: 'together',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    hint: 'Cloud inference',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    apiFormat: 'openai-chat',
    auth: 'bearer',
    apiKeyRequired: true,
    keyUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    reasoningStyle: 'openai-effort',
    modelsDevId: 'fireworks-ai',
    icon: 'fireworks',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    hint: 'Local, no key',
    baseURL: 'http://localhost:1234/v1',
    apiFormat: 'openai-chat',
    auth: 'none',
    apiKeyRequired: false,
    reasoningStyle: 'openai-effort',
    modelsDevId: 'lmstudio',
    icon: 'lmstudio',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    hint: 'Self-hosted',
    baseURL: 'http://localhost:8000/v1',
    apiFormat: 'openai-chat',
    auth: 'bearer',
    apiKeyRequired: false,
    reasoningStyle: 'openai-effort',
    icon: 'vllm',
  },
  {
    id: 'litellm',
    name: 'LiteLLM proxy',
    hint: 'Proxy gateway',
    baseURL: 'http://localhost:4000/v1',
    apiFormat: 'openai-chat',
    auth: 'bearer',
    apiKeyRequired: false,
    reasoningStyle: 'openai-effort',
  },
]

export function templateById(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find(template => template.id === id)
}
