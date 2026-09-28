// Builtin plugin `mock` (PROVIDERS.md 8): the dev-only `mock` provider (`mock:echo`, `mock:reasoning`,
// `mock:tool-approval`, `mock:error`) and the tool `mock_approval_tool` (policy `ask`), registered through `ctx` like
// any builtin. Loaded only with `HF_MOCK_PROVIDER=1` (`getBuiltinPlugins`). Every answer is deterministic, for e2e.
import type { HarnessErrorInit, ModelInfo, PluginManifest, ProviderDefinition, ReasoningLevel, ToolDefinition } from '@harness-forge/plugin-sdk'
import { APICallError } from '@ai-sdk/provider'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { z } from 'zod'
import {
  createMockLanguageModel,
  MOCK_AUTH_FAILURE,
  MOCK_ERROR_URL,
  MOCK_PROVIDER_ID,
  MOCK_TOOL_NAME,
} from './models.ts'

export { MOCK_MODEL_IDS, MOCK_PROVIDER_ID, MOCK_TIMING, MOCK_TOOL_NAME } from './models.ts'

export const manifest = {
  manifestVersion: 1,
  id: 'mock',
  name: 'Mock provider',
  version: '1.0.0',
  description: 'Deterministic mock models and a mock approval tool for development and end-to-end tests.',
  engines: { harness: '^1.0.0' },
  main: 'index.ts',
} satisfies PluginManifest

/** A mock model: 32K context, 4096 output tokens, USD 1 / 2 per 1M tokens (so cost displays are non-zero). */
function mockModel(id: string, name: string, capabilities: Partial<Record<'tools' | 'vision' | 'pdf' | 'reasoning', boolean>>, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name,
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    capabilities: { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, ...capabilities },
    cost: { input: 1, output: 2 },
    ...extra,
  }
}

/** The four mock models (listing and seeds). */
export function mockModels(): ModelInfo[] {
  return [
    mockModel('echo', 'Mock Echo', { vision: true, pdf: true }),
    mockModel('reasoning', 'Mock Reasoning', { reasoning: true }, { reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'] }),
    mockModel('tool-approval', 'Mock Tool Approval', { tools: true }),
    mockModel('error', 'Mock Error', {}),
  ]
}

/** `off` -> `none`, `low` / `medium` / `high` -> same, `max` -> `xhigh`; `auto` sends nothing. */
const REASONING_LEVELS: Readonly<Record<'off' | 'low' | 'medium' | 'high' | 'max', ReasoningLevel>> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
}

/** The `APICallError` of `mock:error` wherever it sits in the error chain (a `RetryError` wraps it). */
function isMockAuthError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    if (APICallError.isInstance(current) && current.url === MOCK_ERROR_URL)
      return true
    const record = current as { lastError?: unknown, cause?: unknown }
    current = record.lastError ?? record.cause
  }
  return false
}

export const mockProvider: ProviderDefinition = {
  id: MOCK_PROVIDER_ID,
  name: 'Mock (dev only)',
  credentials: [],
  smallModelId: 'echo',
  seedModels: mockModels(),
  createLanguageModel(modelId) {
    return createMockLanguageModel(modelId)
  },
  async listModels() {
    return mockModels()
  },
  async validate() {},
  reasoning(effort) {
    return effort === 'auto' ? undefined : { reasoning: REASONING_LEVELS[effort] }
  },
  mapError(error): HarnessErrorInit | undefined {
    if (!isMockAuthError(error))
      return undefined
    return { code: 'auth_invalid', message: MOCK_AUTH_FAILURE, status: 401, providerId: MOCK_PROVIDER_ID, action: 'configure-provider' }
  },
}

const mockToolInputSchema = z.object({ text: z.string() })

export const mockApprovalTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  name: MOCK_TOOL_NAME,
  description: 'Echoes its input. Mock tool that requires approval.',
  inputSchema: mockToolInputSchema,
  policy: 'ask',
  async execute(input) {
    return { echoed: input.text }
  },
}

export default definePlugin({
  setup(ctx) {
    ctx.providers.register(mockProvider)
    ctx.tools.register(mockApprovalTool)
  },
})
