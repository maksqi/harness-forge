// The 13 builtin provider definitions in the order of `BUILTIN_PROVIDER_IDS` (DECISIONS.md).
import type { ProviderDefinition } from '@harness-forge/plugin-sdk'
import { alibabaProvider } from './alibaba.ts'
import { anthropicProvider } from './anthropic.ts'
import { deepseekProvider } from './deepseek.ts'
import { googleProvider } from './google.ts'
import { groqProvider } from './groq.ts'
import { minimaxProvider } from './minimax.ts'
import { mistralProvider } from './mistral.ts'
import { moonshotaiProvider } from './moonshotai.ts'
import { ollamaProvider } from './ollama.ts'
import { openaiProvider } from './openai.ts'
import { openrouterProvider } from './openrouter.ts'
import { xaiProvider } from './xai.ts'
import { zaiProvider } from './zai.ts'

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  anthropicProvider,
  openaiProvider,
  googleProvider,
  xaiProvider,
  deepseekProvider,
  moonshotaiProvider,
  alibabaProvider,
  zaiProvider,
  minimaxProvider,
  mistralProvider,
  groqProvider,
  openrouterProvider,
  ollamaProvider,
]
