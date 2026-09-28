// Call parameters of a run (ARCHITECTURE.md 6.1, PLUGINS.md 9 "Hooks"): global + chat instructions, the portable
// `reasoning` level and `providerOptions` from `provider.reasoning()`, then the `chat.params` and `chat.headers` hooks.
// Hook output is plugin data: every value is checked before it reaches `streamText`.
import type { ProviderOptions, ReasoningLevel, ReasoningParams } from '@harness-forge/plugin-sdk'
import type { ReasoningEffort, ToolMode } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { ResolvedModel } from '../providers/types.ts'
import type { Registry } from '../registry/types.ts'
import { HTTP_HEADER_NAME_PATTERN } from '@harness-forge/shared'

export interface RunParams {
  /** Undefined when empty. */
  instructions: string | undefined
  temperature?: number
  maxOutputTokens?: number
  maxSteps: number
  reasoning?: ReasoningLevel
  providerOptions: ProviderOptions
  headers: Record<string, string>
}

const REASONING_LEVELS: ReadonlySet<string> = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
const MAX_STEPS_LIMIT = 100
const HEADER_VALUE_MAX_CHARS = 8192

/** Global instructions, then chat instructions, separated by a blank line. */
export function joinInstructions(...parts: (string | undefined)[]): string {
  return parts.map(part => part?.trim() ?? '').filter(part => part !== '').join('\n\n')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isProviderOptions(value: unknown): value is ProviderOptions {
  return isPlainObject(value) && Object.values(value).every(isPlainObject)
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && REASONING_LEVELS.has(value)
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * `provider.reasoning(effort, model)` when the effort applies: not `auto`, the model reasons and the effort is offered
 * for it (an effort that is not offered is treated as `auto`). A throw or an invalid result is ignored.
 */
export function providerReasoning(resolved: ResolvedModel, effort: ReasoningEffort, logger: Logger): ReasoningParams | undefined {
  if (effort === 'auto' || !resolved.entry.capabilities.reasoning || !resolved.entry.reasoningEfforts.includes(effort))
    return undefined
  const definition = resolved.provider.definition
  if (definition.reasoning === undefined)
    return undefined
  let value: unknown
  try {
    value = definition.reasoning(effort, resolved.info)
  }
  catch (error) {
    logger.warn('provider reasoning() failed', { providerId: resolved.providerId, err: error })
    return undefined
  }
  if (!isPlainObject(value))
    return undefined
  const params: ReasoningParams = {}
  if (isReasoningLevel(value.reasoning))
    params.reasoning = value.reasoning
  if (isProviderOptions(value.providerOptions))
    params.providerOptions = value.providerOptions
  const maxOutputTokens = positiveInt(value.maxOutputTokens)
  if (maxOutputTokens !== undefined)
    params.maxOutputTokens = maxOutputTokens
  return params
}

export interface RunParamsInput {
  chatId: string
  modelRef: string
  resolved: ResolvedModel
  reasoningEffort: ReasoningEffort
  toolMode: ToolMode
  globalInstructions: string
  chatInstructions: string | undefined
  maxSteps: number
  registry: Pick<Registry, 'hooks'>
  logger: Logger
}

interface ParamsDraft {
  instructions: string
  temperature?: number
  maxOutputTokens?: number
  maxSteps: number
  reasoning?: ReasoningLevel
  providerOptions: ProviderOptions
}

/** Checks the `chat.params` output field by field; invalid values fall back to what the hooks received. */
function checkedParams(draft: ParamsDraft, original: ParamsDraft): ParamsDraft {
  const result: ParamsDraft = {
    instructions: typeof draft.instructions === 'string' ? draft.instructions : original.instructions,
    maxSteps: typeof draft.maxSteps === 'number' && Number.isInteger(draft.maxSteps)
      ? Math.min(MAX_STEPS_LIMIT, Math.max(1, draft.maxSteps))
      : original.maxSteps,
    providerOptions: isProviderOptions(draft.providerOptions) ? draft.providerOptions : original.providerOptions,
  }
  if (typeof draft.temperature === 'number' && Number.isFinite(draft.temperature))
    result.temperature = draft.temperature
  const maxOutputTokens = positiveInt(draft.maxOutputTokens) ?? (draft.maxOutputTokens === undefined ? undefined : original.maxOutputTokens)
  if (maxOutputTokens !== undefined)
    result.maxOutputTokens = maxOutputTokens
  if (isReasoningLevel(draft.reasoning))
    result.reasoning = draft.reasoning
  else if (draft.reasoning !== undefined && original.reasoning !== undefined)
    result.reasoning = original.reasoning
  return result
}

/** Valid header entries of the `chat.headers` output (names per RFC 7230, string values without line breaks). */
function checkedHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!isPlainObject(value))
    return headers
  for (const [name, header] of Object.entries(value)) {
    if (!HTTP_HEADER_NAME_PATTERN.test(name) || typeof header !== 'string' || /[\r\n\0]/.test(header) || header.length > HEADER_VALUE_MAX_CHARS)
      continue
    headers[name] = header
  }
  return headers
}

/** Instructions, reasoning and hook changes of one run. */
export async function buildRunParams(input: RunParamsInput): Promise<RunParams> {
  const reasoning = providerReasoning(input.resolved, input.reasoningEffort, input.logger)
  const original: ParamsDraft = {
    instructions: joinInstructions(input.globalInstructions, input.chatInstructions),
    maxSteps: input.maxSteps,
    providerOptions: reasoning?.providerOptions ?? {},
    ...(reasoning?.reasoning === undefined ? {} : { reasoning: reasoning.reasoning }),
    ...(reasoning?.maxOutputTokens === undefined ? {} : { maxOutputTokens: reasoning.maxOutputTokens }),
  }
  const context = { chatId: input.chatId, modelRef: input.modelRef }
  const draft: ParamsDraft = { ...original, providerOptions: structuredClone(original.providerOptions) }
  await input.registry.hooks.run(
    'chat.params',
    { ...context, model: input.resolved.info, reasoningEffort: input.reasoningEffort, toolMode: input.toolMode },
    draft,
  )
  const params = checkedParams(draft, original)
  const headersDraft: { headers: Record<string, string> } = { headers: {} }
  await input.registry.hooks.run('chat.headers', context, headersDraft)
  return {
    instructions: params.instructions.trim() === '' ? undefined : params.instructions,
    maxSteps: params.maxSteps,
    providerOptions: params.providerOptions,
    headers: checkedHeaders(headersDraft.headers),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
  }
}
