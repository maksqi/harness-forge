// Builtin plugin `mock` (PROVIDERS.md 8): the dev-only `mock` provider and the tool `mock_approval_tool` (policy `ask`),
// registered through `ctx` like any builtin. Loaded only with `HF_MOCK_PROVIDER=1` (`getBuiltinPlugins`). Every answer
// is deterministic, for e2e. Models: `mock:echo`, `mock:reasoning`, `mock:tool-approval`, `mock:error` (v1) and, since
// Phase 6 (plugin API 1.1.0), `mock:image` (an image model), `mock:image-chat` (image output), `mock:image-tool`
// (calls `generate_image`), `mock:transcribe` and `mock:speech` (./media.ts).
import type { HarnessErrorInit, ModelInfo, PluginManifest, ProviderDefinition, ReasoningLevel, ToolDefinition } from '@harness-forge/plugin-sdk'
import { APICallError } from '@ai-sdk/provider'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { z } from 'zod'
import {
  createMockImageModel,
  createMockSpeechModel,
  createMockTranscriptionModel,
  MOCK_IMAGE_MODEL_ID,
  MOCK_SPEECH_MODEL_ID,
  MOCK_SPEECH_VOICES,
  MOCK_TRANSCRIPTION_MODEL_ID,
  mockImageParams,
} from './media.ts'
import {
  createMockLanguageModel,
  MOCK_AUTH_FAILURE,
  MOCK_ERROR_URL,
  MOCK_PROVIDER_ID,
  MOCK_TOOL_NAME,
} from './models.ts'

export {
  createMockWav,
  MOCK_IMAGE_MODEL_ID,
  MOCK_IMAGE_TIMING,
  MOCK_SPEECH_MODEL_ID,
  MOCK_SPEECH_VOICES,
  MOCK_TRANSCRIPT,
  MOCK_TRANSCRIPTION_MODEL_ID,
} from './media.ts'
export { MOCK_MODEL_IDS, MOCK_PROVIDER_ID, MOCK_TIMING, MOCK_TOOL_NAME } from './models.ts'

export const manifest = {
  manifestVersion: 1,
  id: 'mock',
  name: 'Mock provider',
  version: '1.0.0',
  description: 'Deterministic mock models and a mock approval tool for development and end-to-end tests.',
  engines: { harness: '^1.1.0' },
  main: 'index.ts',
} satisfies PluginManifest

type MockCapability = 'tools' | 'vision' | 'pdf' | 'reasoning' | 'imageOutput'

const MOCK_COST = { input: 1, output: 2 } as const

/** Capabilities of a mock model: everything off except `capabilities`. */
function mockCapabilities(capabilities: Partial<Record<MockCapability, boolean>>): NonNullable<ModelInfo['capabilities']> {
  return { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false, ...capabilities }
}

/** A mock chat model: 32K context, 4096 output tokens, USD 1 / 2 per 1M tokens (so cost displays are non-zero). */
function mockModel(id: string, name: string, capabilities: Partial<Record<MockCapability, boolean>>, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name,
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    capabilities: mockCapabilities(capabilities),
    cost: { ...MOCK_COST },
    ...extra,
  }
}

/**
 * The nine mock models (listing and seeds): the four chat models of v1, then the Phase 6 models in the order of
 * PROVIDERS.md 8. The media models carry explicit kinds: `image` (vision, the same cost), `transcription` and `speech`
 * (with `voices`). `image-chat` and `image-tool` say `kind: 'chat'` explicitly: an explicit kind wins over `classify()`,
 * whose id fallback would take any id containing "image" for an image model and hide it from the picker.
 */
export function mockModels(): ModelInfo[] {
  return [
    mockModel('echo', 'Mock Echo', { vision: true, pdf: true }),
    mockModel('reasoning', 'Mock Reasoning', { reasoning: true }, { reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'] }),
    mockModel('tool-approval', 'Mock Tool Approval', { tools: true }),
    mockModel('error', 'Mock Error', {}),
    { id: MOCK_IMAGE_MODEL_ID, name: 'Mock Image', kind: 'image', capabilities: mockCapabilities({ vision: true }), cost: { ...MOCK_COST } },
    mockModel('image-chat', 'Mock Image Chat', { imageOutput: true }, { kind: 'chat' }),
    mockModel('image-tool', 'Mock Image Tool', { tools: true }, { kind: 'chat' }),
    { id: MOCK_TRANSCRIPTION_MODEL_ID, name: 'Mock Transcribe', kind: 'transcription' },
    { id: MOCK_SPEECH_MODEL_ID, name: 'Mock Speech', kind: 'speech', voices: [...MOCK_SPEECH_VOICES] },
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
  createImageModel(modelId) {
    return createMockImageModel(modelId)
  },
  imageParams(request) {
    return mockImageParams(request)
  },
  createTranscriptionModel(modelId) {
    return createMockTranscriptionModel(modelId)
  },
  createSpeechModel(modelId) {
    return createMockSpeechModel(modelId)
  },
  transcriptionOptions() {
    // The mock models detect nothing: a language hint is ignored (PROVIDERS.md 13).
    return undefined
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
