// Chat titles (ARCHITECTURE.md 6.1): generated in parallel with the first reply of a chat that has no title yet. Model:
// `titleModelRef`, else the chat provider's `smallModelId`, else the chat model (the first one that resolves). At most
// 8 words, 10 s for the whole attempt; on failure or timeout the first 60 characters of the message are used. A title
// set by the user is never overwritten (`ChatsService.setTitle`), which also emits `chat.updated`. An image turn
// (ADR-028) never asks its image model: `titleModelRef`, else the provider's `smallModelId`; without either the default
// title stays (nothing is stored).
import type { ChatSummary } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { ProviderService, ResolvedModel, ResolvedModelBase } from '../providers/types.ts'
import type { ChatsService } from '../services/chats/types.ts'
import type { SettingsService } from '../services/settings/types.ts'
import { generateText } from 'ai'
import { providerReasoning } from './params.ts'
import { catalogCost } from './usage.ts'

export const TITLE_TIMEOUT_MS = 10_000
export const TITLE_MAX_WORDS = 8
export const TITLE_FALLBACK_CHARS = 60
/** Characters of the message sent to the title model. */
const TITLE_PROMPT_MAX_CHARS = 2000
const TITLE_MAX_OUTPUT_TOKENS = 64

export const TITLE_INSTRUCTIONS = [
  'You name chat conversations.',
  `Reply with a short title of at most ${TITLE_MAX_WORDS} words for a conversation that starts with the user message below.`,
  'Reply with the title only: no quotes, no markdown, no trailing punctuation.',
].join(' ')

/** Collapses whitespace and control characters to single spaces. */
function flatten(text: string): string {
  return text.replace(/[\s\p{Cc}]+/gu, ' ').trim()
}

/** A model answer as a title: first line, without markdown, quotes or a `Title:` prefix, at most 8 words. */
export function cleanTitle(text: string): string | null {
  const line = text.split(/\r?\n/).map(value => value.trim()).find(value => value !== '') ?? ''
  const unwrapped = line
    .replace(/^#+\s*/, '')
    .replace(/[*_`]+/g, '')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["'‘“«]+|["'’”»]+$/g, '')
  const words = flatten(unwrapped).split(' ').filter(word => word !== '').slice(0, TITLE_MAX_WORDS)
  const title = words.join(' ').replace(/[\s.,;:!?-]+$/, '').trim()
  return title === '' ? null : title
}

/** The first 60 characters of the message text (code points, whitespace collapsed), or null when it is empty. */
export function fallbackTitle(text: string): string | null {
  const flat = flatten(text)
  if (flat === '')
    return null
  const chars = Array.from(flat)
  return chars.length <= TITLE_FALLBACK_CHARS ? flat : chars.slice(0, TITLE_FALLBACK_CHARS).join('').trim()
}

export interface TitleServices {
  settings: Pick<SettingsService, 'get'>
  providers: Pick<ProviderService, 'resolveModel'>
  chats: Pick<ChatsService, 'setTitle' | 'addUsage'>
}

export interface TitleInput {
  chatId: string
  /** Text of the first user message. */
  text: string
  /** The model of the run: its provider's `smallModelId` is a candidate, and the model itself unless excluded. */
  chatModel: ResolvedModelBase
  /** The run model is the last candidate (default true); false for an image turn (never titled by its image model). */
  includeRunModel?: boolean
  logger: Logger
  /** Aborts the attempt (shutdown); the fallback is not stored then. */
  signal?: AbortSignal
}

/** Model refs to try, in order, without duplicates. */
export function titleModelCandidates(titleModelRef: string | null, chatModel: ResolvedModelBase, includeRunModel = true): string[] {
  const refs = [titleModelRef]
  const small = chatModel.provider.definition.smallModelId
  if (small !== undefined && small !== '')
    refs.push(`${chatModel.providerId}:${small}`)
  if (includeRunModel)
    refs.push(chatModel.modelRef)
  return [...new Set(refs.filter((ref): ref is string => typeof ref === 'string' && ref !== ''))]
}

async function resolveFirst(services: TitleServices, refs: readonly string[], signal: AbortSignal, logger: Logger): Promise<ResolvedModel | null> {
  for (const ref of refs) {
    try {
      return await services.providers.resolveModel(ref, { signal })
    }
    catch (error) {
      logger.debug('title model not usable', { modelRef: ref, err: error })
    }
  }
  return null
}

async function modelTitle(services: TitleServices, input: TitleInput, candidates: readonly string[], signal: AbortSignal): Promise<string | null> {
  const resolved = await resolveFirst(services, candidates, signal, input.logger)
  if (resolved === null)
    return null
  const reasoning = providerReasoning(resolved, 'off', input.logger)
  const result = await generateText({
    model: resolved.model,
    instructions: TITLE_INSTRUCTIONS,
    prompt: input.text.slice(0, TITLE_PROMPT_MAX_CHARS),
    maxOutputTokens: reasoning?.maxOutputTokens ?? TITLE_MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    abortSignal: signal,
    ...(reasoning?.reasoning === undefined ? {} : { reasoning: reasoning.reasoning }),
    ...(reasoning?.providerOptions === undefined ? {} : { providerOptions: reasoning.providerOptions }),
  })
  const usage = result.usage
  services.chats.addUsage({
    chatId: input.chatId,
    messageId: null,
    purpose: 'title',
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    costUsd: catalogCost(usage, resolved.entry.cost) ?? null,
  }).catch((error: unknown) => input.logger.warn('cannot store the title usage', { err: error }))
  return cleanTitle(result.text)
}

/**
 * Generates and stores the title of a chat. Resolves with the updated summary, or null when nothing was stored (empty
 * text, a user title, or an aborted attempt). Never throws.
 */
export async function generateChatTitle(services: TitleServices, input: TitleInput, timeoutMs: number = TITLE_TIMEOUT_MS): Promise<ChatSummary | null> {
  const fallback = fallbackTitle(input.text)
  if (fallback === null)
    return null
  let titleModelRef: string | null = null
  try {
    titleModelRef = (await services.settings.get()).titleModelRef
  }
  catch (error) {
    input.logger.debug('cannot read the title model setting', { err: error })
  }
  const candidates = titleModelCandidates(titleModelRef, input.chatModel, input.includeRunModel ?? true)
  // An image turn without a title model: the default title stays.
  if (candidates.length === 0)
    return null
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('The title model did not answer in time.', 'TimeoutError'))
      resolve(null)
    }, timeoutMs)
  })
  let title: string | null = null
  try {
    title = await Promise.race([modelTitle(services, input, candidates, controller.signal), expired])
  }
  catch (error) {
    input.logger.debug('title generation failed, using the fallback', { err: error })
  }
  finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
  if (input.signal?.aborted)
    return null
  try {
    return await services.chats.setTitle(input.chatId, title ?? fallback, title === null ? 'fallback' : 'auto')
  }
  catch (error) {
    input.logger.warn('cannot store the chat title', { err: error })
    return null
  }
}
