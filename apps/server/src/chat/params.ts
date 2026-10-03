// Call parameters of a run (ARCHITECTURE.md 6.1 / 6.13, PLUGINS.md 9 "Hooks"): the instructions, the portable
// `reasoning` level and `providerOptions` from `provider.reasoning()` (deep-merged over the `imageParams()` provider
// options of a chat model with image output, ADR-028), then the `chat.params` and `chat.headers` hooks. Provider and
// hook output is plugin data: every value is checked before it reaches `streamText`.
// Instructions, in this order (Phase 7, ADR-031): global → the workspace block (project name, folder, OS, and rules
// built only from the workspace tools offered in this run) → the project file (`AGENTS.md`, else `CLAUDE.md`) → the
// project's own instructions → the chat instructions. Steps: `projectMaxSteps` for a chat with a project, else
// `maxSteps`; the `chat.params` output is clamped to 1..`LIMITS.stepsMax` (200).
import type { ProviderOptions, ReasoningLevel, ReasoningParams } from '@harness-forge/plugin-sdk'
import type { ImageAspectRatio, ReasoningEffort, Settings, ToolMode } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { ResolvedModelBase } from '../providers/types.ts'
import type { Registry } from '../registry/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import process from 'node:process'
import { HTTP_HEADER_NAME_PATTERN, LIMITS } from '@harness-forge/shared'

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
const MAX_STEPS_LIMIT = LIMITS.stepsMax
const HEADER_VALUE_MAX_CHARS = 8192

/** Instruction parts in order, trimmed, empty ones skipped, separated by a blank line. */
export function joinInstructions(...parts: (string | null | undefined)[]): string {
  return parts.map(part => part?.trim() ?? '').filter(part => part !== '').join('\n\n')
}

/** The step limit of a run: `projectMaxSteps` in a chat with a project, `maxSteps` otherwise. */
export function runMaxSteps(settings: Pick<Settings, 'maxSteps' | 'projectMaxSteps'>, projectId: string | null): number {
  return projectId === null ? settings.maxSteps : settings.projectMaxSteps
}

const OS_NAMES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  netbsd: 'NetBSD',
  sunos: 'SunOS',
  aix: 'AIX',
}

/** The operating system of the server host as named in the workspace block. */
export function osName(platform: NodeJS.Platform = process.platform): string {
  return OS_NAMES[platform] ?? platform
}

/**
 * The workspace block of the instructions: `Project "<name>", folder <root> (<OS>).`, then one rule per line, built only
 * from the offered workspace tools (`tools`: names of the tools of this run that declare workspace access): relative
 * paths (any workspace tool), read before edit (`read_file` with `edit_file` or `write_file`), the exact unique
 * `old_string` (`edit_file`), `edit_file` over `write_file` (both), the shell process rules (`shell`; Phase 8: the
 * working folder carries over between calls, environment variables do not). Without workspace tools only the first
 * line.
 */
export function workspaceBlock(workspace: Pick<OpenWorkspace, 'name' | 'root'>, tools: readonly string[], platform?: NodeJS.Platform): string {
  const offered = new Set(tools)
  const rules: string[] = []
  if (offered.size > 0)
    rules.push('Use paths relative to the project folder.')
  if (offered.has('read_file') && (offered.has('edit_file') || offered.has('write_file')))
    rules.push('Read a file with read_file before you change it.')
  if (offered.has('edit_file'))
    rules.push('edit_file: old_string must match the file exactly, including whitespace and indentation, and must be unique in it; add surrounding lines to make it unique, or set replace_all.')
  if (offered.has('edit_file') && offered.has('write_file'))
    rules.push('Prefer edit_file for changes to an existing file; use write_file to create a file or to replace all of its content.')
  if (offered.has('shell'))
    rules.push('Each shell call runs in a new process: the working folder carries over (cd persists inside the project folder), environment variables do not; there is no stdin (interactive commands cannot work), and background processes are stopped when the command ends.')
  const head = `Project ${JSON.stringify(workspace.name)}, folder ${workspace.root} (${osName(platform)}).`
  return [head, ...rules.map(rule => `- ${rule}`)].join('\n')
}

/** The project file part of the instructions (`AGENTS.md` / `CLAUDE.md` from the project root), or '' when empty. */
export function projectFileInstructions(file: OpenWorkspace['projectFile']): string {
  const content = file?.content.trim() ?? ''
  return file === null || content === '' ? '' : `Instructions from ${file.name} in the project folder:\n\n${content}`
}

/**
 * The instructions before the `chat.params` hooks: global → workspace block → project file → project instructions →
 * chat instructions (each trimmed, empty parts skipped, separated by a blank line).
 */
export function runInstructions(input: Pick<RunParamsInput, 'globalInstructions' | 'chatInstructions' | 'workspace' | 'workspaceTools' | 'platform'>): string {
  const workspace = input.workspace ?? null
  return joinInstructions(
    input.globalInstructions,
    workspace === null ? undefined : workspaceBlock(workspace, input.workspaceTools ?? [], input.platform),
    workspace === null ? undefined : projectFileInstructions(workspace.projectFile),
    workspace?.instructions,
    input.chatInstructions,
  )
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

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (UNSAFE_KEYS.has(key))
      continue
    const current = merged[key]
    merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return merged
}

/** `override` deep-merged over `base` (objects merge key by key; arrays and other values of `override` win). */
export function mergeProviderOptions(base: ProviderOptions, override: ProviderOptions): ProviderOptions {
  return deepMerge(base, override) as ProviderOptions
}

/**
 * The provider options of `provider.imageParams({ n: 1, aspectRatio, inputs: 0 }, model)` for a chat model with
 * `capabilities.imageOutput` (ADR-028, e.g. `{ google: { responseModalities: ['TEXT', 'IMAGE'] } }`). A throw or an
 * invalid result is ignored (undefined).
 */
export function providerImageOptions(resolved: ResolvedModelBase, aspectRatio: ImageAspectRatio | undefined, logger: Logger): ProviderOptions | undefined {
  const definition = resolved.provider.definition
  if (definition.imageParams === undefined)
    return undefined
  let value: unknown
  try {
    value = definition.imageParams({ n: 1, inputs: 0, ...(aspectRatio === undefined ? {} : { aspectRatio }) }, resolved.info)
  }
  catch (error) {
    logger.warn('provider imageParams() failed', { providerId: resolved.providerId, err: error })
    return undefined
  }
  if (!isPlainObject(value) || !isProviderOptions(value.providerOptions))
    return undefined
  return value.providerOptions
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
export function providerReasoning(resolved: ResolvedModelBase, effort: ReasoningEffort, logger: Logger): ReasoningParams | undefined {
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
  resolved: ResolvedModelBase
  /** `providerImageOptions` of a chat model with image output: the base the reasoning options are merged over. */
  imageProviderOptions?: ProviderOptions
  reasoningEffort: ReasoningEffort
  toolMode: ToolMode
  globalInstructions: string
  chatInstructions: string | undefined
  /**
   * The open project folder of the run (Phase 7): adds the workspace block, the project file and the project
   * instructions after the global instructions. Null or absent = none (no project, or the folder is not available).
   */
  workspace?: Pick<OpenWorkspace, 'name' | 'root' | 'instructions' | 'projectFile'> | null
  /** Names of the offered tools with workspace access (the rules of the workspace block); default none. */
  workspaceTools?: readonly string[]
  /** The OS named in the workspace block; default `process.platform`. */
  platform?: NodeJS.Platform
  /** The step limit before the hooks (`runMaxSteps`). */
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
    instructions: runInstructions(input),
    maxSteps: input.maxSteps,
    providerOptions: mergeProviderOptions(input.imageProviderOptions ?? {}, reasoning?.providerOptions ?? {}),
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
