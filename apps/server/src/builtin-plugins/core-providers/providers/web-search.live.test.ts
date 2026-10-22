// Live checks of provider-native web search (W14.4-T6, ADR-062; PROVIDERS.md 12 "Web search checks (Phase 14)"): real,
// PAID requests through the harness (`createTestApp`: in-memory database, temp data directory, `HF_OFFLINE=1`, only the
// keys a check needs), never run by `pnpm test` (the server config excludes `*.live.test.ts`; the guard below skips the
// suite unless `HF_LIVE=1`, set by `vitest.live.config.ts`) and never by agents. Run it on purpose:
//   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... pnpm test:live
//   HF_LIVE_PROVIDERS=google pnpm test:live     (the comma list of the provider suite filters these checks too)
//   HF_LIVE_MAX_COST_USD=0 pnpm test:live       (a budget of 0 skips these checks: their search fees are not tracked)
// The checks (each a SKIP without its key; `webSearch: 'auto'`, tool mode `ask`, every tool off except `current_time`):
//   1. one native search per provider: Anthropic, OpenAI, Google with a Gemini 3 model (next to `current_time`) and a
//      Gemini 2.5 model on a turn with every function tool off (`exclusive`), xAI, OpenRouter, Groq gpt-oss. The reply
//      finishes without an error or a pending approval and the stored reply holds a provider-executed tool part or a
//      source (Groq: neither, by design; only the text is checked);
//   2. a two-turn replay on Anthropic and OpenAI: the second turn of the chat carries the first turn's provider-executed
//      parts (same provider) and still finishes;
//   3. a provider switch in one chat, Anthropic -> OpenAI -> Anthropic (both keys): every turn finishes (the history
//      stage removes the other provider's provider-executed parts) and the stored first reply keeps its parts.
// Cost: the suite's `chat.params` caps (256 output tokens, 2048 for reasoning models, 3 steps), prompts that ask for one
// search, at most `WEB_SEARCH_MAX_USES` searches per turn; about a dozen searches in a full run. No key, no log record
// and no report line ever contains a key value.
import type { ChatDetail, ChatRequestBody, HarnessUIMessage } from '@harness-forge/shared'
import type { ChatStreamResult } from '../../../live/checks.ts'
import type { LiveEnv } from '../../../live/matrix.ts'
import type { TestApp } from '../../../testing/create-test-app.ts'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { createChatId, createMessageId, formatModelRef, isProviderExecutedPart } from '@harness-forge/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { capChatParams, CAPS_PRIORITY, collectChunks, emptyStreamResult, errorEnvelope, LIVE_PLUGIN_ID, LIVE_STREAM_TIMEOUT_MS, LIVE_TOOL, parseSseEvent } from '../../../live/checks.ts'
import { findKey, liveEnvironment, liveProviderSpecs, parseLiveBudget, parseProviderFilter } from '../../../live/matrix.ts'
import { maskSecrets } from '../../../live/summary.ts'
import { createTestApp } from '../../../testing/create-test-app.ts'

/** One native search check: the provider, the model and whether every function tool is off for the turn. */
interface NativeCheck {
  readonly providerId: string
  readonly modelId: string
  readonly label: string
  /** Every function tool off (Gemini 2.5: Google Search drops function tools, so the turn must send none). */
  readonly noFunctionTools?: boolean
  /** The provider streams neither a tool part nor a source for its search (Groq `browser_search`). */
  readonly noCitations?: boolean
}

const NATIVE_CHECKS: readonly NativeCheck[] = [
  { providerId: 'anthropic', modelId: 'claude-haiku-4-5', label: 'web_search_20250305' },
  { providerId: 'openai', modelId: 'gpt-6-luna', label: 'web_search (Responses API)' },
  { providerId: 'google', modelId: 'gemini-3.5-flash-lite', label: 'Gemini 3: google_search next to a function tool' },
  { providerId: 'google', modelId: 'gemini-2.5-flash', label: 'Gemini 2.5: google_search on a turn without function tools', noFunctionTools: true },
  { providerId: 'xai', modelId: 'grok-4.3', label: 'web_search (Responses API)' },
  { providerId: 'openrouter', modelId: 'openai/gpt-6-luna', label: 'openrouter:web_search' },
  { providerId: 'groq', modelId: 'openai/gpt-oss-20b', label: 'browser_search', noCitations: true },
]

/** The providers of the two-turn replay and the first and second provider of the switch. */
const REPLAY_PROVIDERS = ['anthropic', 'openai'] as const

const PROMPTS = {
  first: 'Search the web once: what is the latest stable release of Node.js? Answer in one short sentence and cite the source.',
  second: 'Search the web once more: when was that release published? Answer in one short sentence.',
  third: 'Without searching again, summarize both answers in one sentence.',
} as const

/** Longest wait for a finished run to be released. */
const RELEASE_TIMEOUT_MS = 20_000
/** One check: up to three turns of at most two minutes each, plus the setup. */
const CHECK_TIMEOUT_MS = 8 * 60_000

interface Context {
  env: LiveEnv
  filter: ReadonlySet<string> | null
  budgetUsd: number
}

/** The key of a provider (variable name and value), or null without one. */
function keyOf(context: Context, providerId: string): { name: string, value: string } | null {
  const spec = liveProviderSpecs().find(candidate => candidate.providerId === providerId)
  return spec === undefined ? null : findKey(spec.envVars, context.env)
}

/** Why a check needing `providerIds` does not run (filter, budget, a missing key), else null. */
function skipReason(context: Context, providerIds: readonly string[]): string | null {
  if (context.budgetUsd <= 0)
    return 'HF_LIVE_MAX_COST_USD is 0'
  for (const providerId of providerIds) {
    if (context.filter !== null && !context.filter.has(providerId))
      return `${providerId} is not in HF_LIVE_PROVIDERS`
    if (keyOf(context, providerId) === null)
      return `no key for ${providerId}`
  }
  return null
}

/** An app with only the keys of `providerIds` and the suite's caps; `run` gets it; always closed. */
async function withApp(context: Context, providerIds: readonly string[], run: (t: TestApp, secrets: string[]) => Promise<void>): Promise<void> {
  const env: Record<string, string> = { HF_OFFLINE: '1' }
  const secrets: string[] = []
  for (const providerId of providerIds) {
    const key = keyOf(context, providerId)
    if (key !== null) {
      env[key.name] = key.value
      secrets.push(key.value)
    }
  }
  const t = await createTestApp({ env })
  const caps = t.deps.registry.hooks.on(LIVE_PLUGIN_ID, 'chat.params', capChatParams, { priority: CAPS_PRIORITY })
  try {
    await run(t, secrets)
    for (const secret of secrets)
      expect(t.logs.text().includes(secret), 'a log record contains a key').toBe(false)
  }
  finally {
    caps.dispose()
    await t.close()
  }
}

/** Leaves only `keep` enabled among the registered tools (none for `null`). */
async function keepOnlyTool(t: TestApp, keep: string | null): Promise<void> {
  const { items } = await t.client.tools.list()
  for (const tool of items) {
    if (tool.name !== keep && tool.enabled)
      await t.client.tools.update({ params: { name: tool.name }, body: { enabled: false } })
  }
}

/** Refreshes the provider's listing; the catalog entry of `modelId` must be there with native search. */
async function requireNativeModel(t: TestApp, providerId: string, modelId: string, secrets: readonly string[]): Promise<void> {
  try {
    await t.client.models.refresh({ params: { id: providerId } })
  }
  catch (error) {
    throw new Error(`the model listing of ${providerId} failed: ${maskSecrets(error instanceof Error ? error.message : String(error), secrets)}`)
  }
  const entry = await t.deps.catalog.get(providerId, modelId)
  expect(entry, `${providerId}:${modelId} is not in the catalog`).not.toBeNull()
  expect(entry?.webSearch, `${providerId}:${modelId} has no native search in the catalog`).not.toBeNull()
}

/** `POST /api/chat` with a new user message at the active leaf (`webSearch: 'auto'`), read to the end and released. */
async function sendTurn(t: TestApp, chatId: string, modelRef: string, prompt: string): Promise<ChatStreamResult> {
  const body: ChatRequestBody = {
    chatId,
    message: { id: createMessageId(), role: 'user', parts: [{ type: 'text', text: prompt }] },
    trigger: 'submit-message',
    modelRef,
    reasoningEffort: 'auto',
    toolMode: 'ask',
    webSearch: 'auto',
  }
  const response = await t.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = emptyStreamResult()
  if (!response.ok) {
    result.error = errorEnvelope(await response.text(), response.status)
    return result
  }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, LIVE_STREAM_TIMEOUT_MS, null)
  })
  const text = await Promise.race([response.text(), timeout])
  clearTimeout(timer)
  if (text === null) {
    result.timedOut = true
    await t.deps.runs.stop(chatId)
  }
  else {
    const chunks = text.split('\n\n').map(parseSseEvent).filter(chunk => chunk !== null)
    collectChunks(chunks, result)
  }
  const deadline = Date.now() + RELEASE_TIMEOUT_MS
  while (t.deps.runs.hasRun(chatId) && Date.now() < deadline)
    await delay(50)
  return result
}

/** The stream finished without an error; the stored reply exists, has text and no pending approval. */
async function finishedReply(t: TestApp, chatId: string, stream: ChatStreamResult, secrets: readonly string[]): Promise<HarnessUIMessage> {
  const problem = stream.error === null ? null : maskSecrets(`${stream.error.code}: ${stream.error.message}`, secrets)
  expect(problem, 'the turn failed').toBeNull()
  expect(stream.timedOut, 'the turn did not end in time').toBe(false)
  expect(stream.finished, 'the stream ended without a finish chunk').toBe(true)
  const detail: ChatDetail = await t.client.chats.get({ params: { id: chatId } })
  const reply = detail.messages.find(message => message.role === 'assistant' && message.id === stream.messageId)
  expect(reply, 'the reply was not stored').toBeDefined()
  const parts = reply?.parts ?? []
  expect(parts.some(part => (part as { state?: unknown }).state === 'approval-requested'), 'a search asked for approval').toBe(false)
  expect(stream.text.trim(), 'the reply has no text').not.toBe('')
  return reply as HarnessUIMessage
}

/** True when the reply holds a provider-executed tool part or a source. */
function searched(reply: HarnessUIMessage): boolean {
  return reply.parts.some(part => isProviderExecutedPart(part) || part.type === 'source-url')
}

describe.runIf(process.env.HF_LIVE === '1')('live native web search', () => {
  let context: Context | undefined

  beforeAll(() => {
    const env = liveEnvironment()
    context = {
      env,
      filter: parseProviderFilter(env.HF_LIVE_PROVIDERS, liveProviderSpecs().map(spec => spec.providerId)),
      budgetUsd: parseLiveBudget(env.HF_LIVE_MAX_COST_USD),
    }
  })

  for (const check of NATIVE_CHECKS) {
    it(`native search: ${check.providerId} ${check.modelId} (${check.label})`, async (ctx) => {
      if (context === undefined)
        throw new Error('The live environment was not read (see the beforeAll error).')
      const reason = skipReason(context, [check.providerId])
      if (reason !== null) {
        ctx.skip(reason)
        return
      }
      await withApp(context, [check.providerId], async (t, secrets) => {
        await keepOnlyTool(t, check.noFunctionTools === true ? null : LIVE_TOOL)
        await requireNativeModel(t, check.providerId, check.modelId, secrets)
        const chatId = createChatId()
        await t.client.chats.create({ body: { id: chatId, title: `Live web search (${check.providerId})` } })
        const stream = await sendTurn(t, chatId, formatModelRef(check.providerId, check.modelId), PROMPTS.first)
        const reply = await finishedReply(t, chatId, stream, secrets)
        if (check.noCitations !== true)
          expect(searched(reply), 'the reply holds no provider-executed search part and no source').toBe(true)
      })
    }, CHECK_TIMEOUT_MS)
  }

  for (const providerId of REPLAY_PROVIDERS) {
    it(`two-turn replay: ${providerId}`, async (ctx) => {
      if (context === undefined)
        throw new Error('The live environment was not read (see the beforeAll error).')
      const reason = skipReason(context, [providerId])
      if (reason !== null) {
        ctx.skip(reason)
        return
      }
      const check = NATIVE_CHECKS.find(candidate => candidate.providerId === providerId) as NativeCheck
      await withApp(context, [providerId], async (t, secrets) => {
        await keepOnlyTool(t, LIVE_TOOL)
        await requireNativeModel(t, providerId, check.modelId, secrets)
        const modelRef = formatModelRef(providerId, check.modelId)
        const chatId = createChatId()
        await t.client.chats.create({ body: { id: chatId, title: `Live web search replay (${providerId})` } })
        const first = await finishedReply(t, chatId, await sendTurn(t, chatId, modelRef, PROMPTS.first), secrets)
        expect(searched(first), 'the first turn did not search').toBe(true)
        await finishedReply(t, chatId, await sendTurn(t, chatId, modelRef, PROMPTS.second), secrets)
      })
    }, CHECK_TIMEOUT_MS)
  }

  it('provider switch in one chat: anthropic -> openai -> anthropic', async (ctx) => {
    if (context === undefined)
      throw new Error('The live environment was not read (see the beforeAll error).')
    const reason = skipReason(context, REPLAY_PROVIDERS)
    if (reason !== null) {
      ctx.skip(reason)
      return
    }
    const [first, second] = REPLAY_PROVIDERS.map(providerId => NATIVE_CHECKS.find(candidate => candidate.providerId === providerId) as NativeCheck)
    await withApp(context, REPLAY_PROVIDERS, async (t, secrets) => {
      await keepOnlyTool(t, LIVE_TOOL)
      for (const check of [first, second] as NativeCheck[])
        await requireNativeModel(t, check.providerId, check.modelId, secrets)
      const anthropicRef = formatModelRef(first?.providerId ?? 'anthropic', first?.modelId ?? '')
      const openaiRef = formatModelRef(second?.providerId ?? 'openai', second?.modelId ?? '')
      const chatId = createChatId()
      await t.client.chats.create({ body: { id: chatId, title: 'Live web search provider switch' } })
      const one = await finishedReply(t, chatId, await sendTurn(t, chatId, anthropicRef, PROMPTS.first), secrets)
      await finishedReply(t, chatId, await sendTurn(t, chatId, openaiRef, PROMPTS.second), secrets)
      await finishedReply(t, chatId, await sendTurn(t, chatId, anthropicRef, PROMPTS.third), secrets)
      // The history stage changes only the copy sent to the model: the stored first reply keeps its parts.
      const detail = await t.client.chats.get({ params: { id: chatId } })
      const stored = detail.messages.find(message => message.id === one.id)
      expect(stored?.parts.filter(part => isProviderExecutedPart(part)).length).toBe(one.parts.filter(part => isProviderExecutedPart(part)).length)
    })
  }, 3 * CHECK_TIMEOUT_MS)
})
