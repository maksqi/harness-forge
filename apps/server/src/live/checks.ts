// The checks of the live provider suite (PROVIDERS.md 12 "What it checks"), made through the HTTP API of one in-process
// app per provider (`createTestApp`: in-memory database, temp data directory, never `data/`):
//   1. test      `POST /providers/:id/test` answers `ok: true`;
//   2. models    a refresh succeeds and `GET /models` lists the model from the live listing;
//   3. chat      `POST /chat` in a chat with a user title (no title call): text deltas, finish usage > 0, persisted;
//   4. reasoning effort `low` (else the lowest effort the model offers) answers without an error (reasoning models);
//   5. tools     a `current_time` round trip in tool mode `auto` (tool-capable models);
//   6. badKey    a wrong key sent as `values.<keyField>` makes the test answer `ok: false` with `auth_invalid` (free);
//   7. logs      no captured log record contains the key.
// Cost and safety: a `chat.params` hook caps the output (256 tokens, 2048 when the model reasons) and `maxSteps` (3);
// every tool except `current_time` is disabled; the paid checks (3-5) are skipped once the budget is spent; a rate limit
// (`rate_limited`, HTTP 429) is a SKIP, not a FAIL. Chat requests carry no `parentId`: each check starts its own chat.
import type { HookMap } from '@harness-forge/plugin-sdk'
import type {
  CatalogModel,
  ChatDetail,
  ChatRequestBody,
  HarnessErrorInit,
  HarnessUIMessage,
  MessageMetadata,
  ReasoningEffort,
  ToolMode,
  UsageTotals,
} from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { TestApp } from '../testing/create-test-app.ts'
import type { LiveRunEntry } from './matrix.ts'
import type { LiveBudget, LiveCheckId, LiveCheckResult, LiveProviderReport } from './summary.ts'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createChatId,
  createMessageId,
  formatModelRef,
  harnessErrorEnvelopeSchema,
  isHarnessError,
  messageMetadataSchema,
} from '@harness-forge/shared'
import { createTestApp } from '../testing/create-test-app.ts'
import { budgetExhausted, formatUsd, maskSecrets, oneLine } from './summary.ts'

/** Owner id of the suite's direct registrations (unknown to the plugin host, so its hook always runs). */
export const LIVE_PLUGIN_ID = 'live-suite'
/** Caps applied by the suite's `chat.params` hook. */
export const LIVE_CAPS = { outputTokens: 256, reasoningOutputTokens: 2048, maxSteps: 3 } as const
/** The only tool left enabled: the tool check asks the model to call it. */
export const LIVE_TOOL = 'current_time'
/** A key no vendor issues; the bad-key check expects `auth_invalid` for it. */
export const LIVE_BAD_KEY = 'hf-live-invalid-key-0000000000000000'
/**
 * Prices (USD per 1M tokens) that count toward the budget when the catalog has none for the model: a mid-size model's
 * price, above every small model the suite uses, so an unknown price never lets the run overspend.
 */
export const FALLBACK_PRICE_PER_MILLION = { input: 3, output: 15 } as const
export const LIVE_PROMPTS = {
  chat: 'Reply with the single word "pong" and nothing else.',
  reasoning: 'What is 17 + 25? Reply with the number only.',
  tools: `Call the ${LIVE_TOOL} tool with the timezone "UTC", then reply with the current UTC date only, as YYYY-MM-DD.`,
} as const
/** Longest wait for one chat stream; the run is stopped after it. */
export const LIVE_STREAM_TIMEOUT_MS = 120_000
/** Longest wait for a finished run to be persisted and released. */
const RELEASE_TIMEOUT_MS = 20_000
/** Lowest priority: the caps run after every other `chat.params` handler, so they always win. */
const CAPS_PRIORITY = -1_000_000
/** Efforts tried by the reasoning check, cheapest first (`off` and `auto` are not reasoning requests). */
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max']

// ---------- caps ----------

/**
 * The `chat.params` handler of the suite: output capped at 256 tokens, or 2048 when the model reasons (a reasoning
 * model may think by default with `auto`, and thinking counts toward the output cap), and at most 3 steps.
 */
export function capChatParams(input: HookMap['chat.params'][0], output: HookMap['chat.params'][1]): void {
  const reasons = input.model.capabilities?.reasoning === true && input.reasoningEffort !== 'off'
  const cap = reasons ? LIVE_CAPS.reasoningOutputTokens : LIVE_CAPS.outputTokens
  output.maxOutputTokens = Math.min(output.maxOutputTokens ?? cap, cap)
  output.maxSteps = Math.min(output.maxSteps, LIVE_CAPS.maxSteps)
}

/** `low` when the model offers it, else its lowest effort above `off`; null without reasoning or effort control. */
export function pickReasoningEffort(model: Pick<CatalogModel, 'capabilities' | 'reasoningEfforts'>): ReasoningEffort | null {
  if (!model.capabilities.reasoning)
    return null
  return REASONING_EFFORTS.find(effort => model.reasoningEfforts.includes(effort)) ?? null
}

// ---------- results ----------

function isRateLimited(error: Pick<HarnessErrorInit, 'code' | 'status'>): boolean {
  return error.code === 'rate_limited' || error.status === 429
}

/** An error as a check result: SKIP for a rate limit (HTTP 429), FAIL otherwise. */
export function errorResult(error: Pick<HarnessErrorInit, 'code' | 'message' | 'status'>): LiveCheckResult {
  const text = `${error.code}${error.status === undefined ? '' : ` (HTTP ${error.status})`}: ${error.message}`
  return isRateLimited(error) ? { status: 'SKIP', detail: `rate limited, ${text}` } : { status: 'FAIL', detail: text }
}

/** A thrown error (a `HarnessError` from the API client, or anything else) as a check result. */
export function thrownResult(error: unknown): LiveCheckResult {
  if (isHarnessError(error))
    return errorResult(error)
  return { status: 'FAIL', detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
}

// ---------- the chat stream ----------

/** What a `POST /api/chat` request delivered. */
export interface ChatStreamResult {
  /** The error before the stream (JSON envelope) or inside it (`error` chunk). */
  error: HarnessErrorInit | null
  /** Assistant message id (`start` chunk). */
  messageId: string | null
  text: string
  reasoning: string
  /** `tool-input-available` chunks. */
  toolCalls: { toolCallId: string, toolName: string }[]
  /** Tool call ids with a `tool-output-available` chunk. */
  toolOutputs: string[]
  /** `tool-input-error` / `tool-output-error` texts. */
  toolErrors: string[]
  /** Metadata of the `finish` chunk (usage, cost, finish reason). */
  metadata: MessageMetadata | null
  finished: boolean
  /** The stream did not end within the timeout (the run was stopped). */
  timedOut: boolean
}

export function emptyStreamResult(): ChatStreamResult {
  return { error: null, messageId: null, text: '', reasoning: '', toolCalls: [], toolOutputs: [], toolErrors: [], metadata: null, finished: false, timedOut: false }
}

/** One SSE event block (`data: <json>`) as a UI message chunk; null for `[DONE]`, comments and invalid JSON. */
export function parseSseEvent(block: string): UIMessageChunk | null {
  const data = block
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
  if (data === '' || data === '[DONE]')
    return null
  try {
    return JSON.parse(data) as UIMessageChunk
  }
  catch {
    return null
  }
}

/** The error envelope inside an `error` chunk (run errors), else the text as an `internal_error`. */
function streamError(errorText: string): HarnessErrorInit {
  try {
    const parsed = harnessErrorEnvelopeSchema.safeParse(JSON.parse(errorText))
    if (parsed.success)
      return parsed.data.error
  }
  catch {
    // Not JSON: a plain error text.
  }
  return { code: 'internal_error', message: errorText }
}

/** Folds UI message chunks into `result`. */
export function collectChunks(chunks: readonly UIMessageChunk[], result: ChatStreamResult = emptyStreamResult()): ChatStreamResult {
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'start':
        result.messageId = chunk.messageId ?? result.messageId
        break
      case 'text-delta':
        result.text += chunk.delta
        break
      case 'reasoning-delta':
        result.reasoning += chunk.delta
        break
      case 'tool-input-available':
        result.toolCalls.push({ toolCallId: chunk.toolCallId, toolName: chunk.toolName })
        break
      case 'tool-output-available':
        result.toolOutputs.push(chunk.toolCallId)
        break
      case 'tool-input-error':
      case 'tool-output-error':
        result.toolErrors.push(chunk.errorText)
        break
      case 'error':
        result.error ??= streamError(chunk.errorText)
        break
      case 'finish': {
        result.finished = true
        const metadata = messageMetadataSchema.safeParse(chunk.messageMetadata)
        if (metadata.success)
          result.metadata = metadata.data
        break
      }
      default:
        break
    }
  }
  return result
}

/** Reads the SSE body until it ends or `timeoutMs` passes (then the reader is cancelled). */
async function readChunks(response: Response, timeoutMs: number): Promise<{ chunks: UIMessageChunk[], timedOut: boolean }> {
  const chunks: UIMessageChunk[] = []
  if (response.body === null)
    return { chunks, timedOut: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, 'timeout')
  })
  const drain = (): void => {
    let end = buffer.indexOf('\n\n')
    while (end !== -1) {
      const chunk = parseSseEvent(buffer.slice(0, end))
      if (chunk !== null)
        chunks.push(chunk)
      buffer = buffer.slice(end + 2)
      end = buffer.indexOf('\n\n')
    }
  }
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout])
      if (next === 'timeout') {
        await reader.cancel().catch(() => {})
        return { chunks, timedOut: true }
      }
      if (next.done)
        break
      buffer += decoder.decode(next.value, { stream: true })
      drain()
    }
    buffer += `${decoder.decode()}\n\n`
    drain()
    return { chunks, timedOut: false }
  }
  finally {
    clearTimeout(timer)
  }
}

async function envelopeOf(response: Response): Promise<HarnessErrorInit> {
  const text = await response.text()
  try {
    const parsed = harnessErrorEnvelopeSchema.safeParse(JSON.parse(text))
    if (parsed.success)
      return parsed.data.error
  }
  catch {
    // Not an error envelope.
  }
  return { code: 'internal_error', message: `HTTP ${response.status} without an error envelope` }
}

/** Waits until the chat's run is released (its message persisted); false after `timeoutMs`. */
async function waitReleased(t: TestApp, chatId: string, timeoutMs = RELEASE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (t.deps.runs.hasRun(chatId)) {
    if (Date.now() > deadline)
      return false
    await delay(50)
  }
  return true
}

export interface LiveChatRequest {
  chatId: string
  text: string
  modelRef: string
  reasoningEffort: ReasoningEffort
  toolMode: ToolMode
}

/** `POST /api/chat` with a new user message (no `parentId`), read to the end; returns once the run is released. */
export async function sendChat(t: TestApp, request: LiveChatRequest, timeoutMs = LIVE_STREAM_TIMEOUT_MS): Promise<ChatStreamResult> {
  const body: ChatRequestBody = {
    chatId: request.chatId,
    message: { id: createMessageId(), role: 'user', parts: [{ type: 'text', text: request.text }] },
    trigger: 'submit-message',
    modelRef: request.modelRef,
    reasoningEffort: request.reasoningEffort,
    toolMode: request.toolMode,
  }
  const response = await t.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = emptyStreamResult()
  if (!response.ok) {
    result.error = await envelopeOf(response)
    return result
  }
  const { chunks, timedOut } = await readChunks(response, timeoutMs)
  collectChunks(chunks, result)
  result.timedOut = timedOut
  if (timedOut)
    await t.deps.runs.stop(request.chatId)
  await waitReleased(t, request.chatId)
  return result
}

// ---------- evaluation ----------

function textOf(message: HarnessUIMessage | undefined): string {
  return message?.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('') ?? ''
}

function assistantOf(detail: ChatDetail, messageId: string | null): HarnessUIMessage | undefined {
  return detail.messages.find(message => message.role === 'assistant' && message.id === messageId)
}

function finishReason(stream: ChatStreamResult): string {
  return stream.metadata?.finishReason ?? 'unknown'
}

/** A failed or unfinished stream, else null. */
function streamProblem(stream: ChatStreamResult): LiveCheckResult | null {
  if (stream.error !== null)
    return errorResult(stream.error)
  if (stream.timedOut)
    return { status: 'FAIL', detail: `the stream did not end within ${LIVE_STREAM_TIMEOUT_MS / 1000} s (the run was stopped)` }
  if (!stream.finished)
    return { status: 'FAIL', detail: 'the stream ended without a finish chunk' }
  return null
}

/** Check 3: text deltas, finish usage with input and output tokens, the reply persisted. */
export function evaluateChat(stream: ChatStreamResult, detail: ChatDetail): LiveCheckResult {
  const problem = streamProblem(stream)
  if (problem !== null)
    return problem
  if (stream.text.trim() === '')
    return { status: 'FAIL', detail: `no text deltas (finish reason: ${finishReason(stream)})` }
  const usage = stream.metadata?.usage
  if ((usage?.inputTokens ?? 0) <= 0 || (usage?.outputTokens ?? 0) <= 0)
    return { status: 'FAIL', detail: `the finish usage lacks input or output tokens (${JSON.stringify(usage ?? {})})` }
  if (textOf(assistantOf(detail, stream.messageId)).trim() === '')
    return { status: 'FAIL', detail: 'the reply was not persisted' }
  return { status: 'PASS', detail: `in ${usage?.inputTokens} / out ${usage?.outputTokens} tokens, answer "${oneLine(stream.text, 40)}"` }
}

/** Check 4: the reasoning request answers without an error and the answer is persisted. */
export function evaluateReasoning(stream: ChatStreamResult, detail: ChatDetail, effort: ReasoningEffort): LiveCheckResult {
  const problem = streamProblem(stream)
  if (problem !== null)
    return problem
  if (stream.text.trim() === '')
    return { status: 'FAIL', detail: `effort ${effort}: no answer text within ${LIVE_CAPS.reasoningOutputTokens} output tokens (finish reason: ${finishReason(stream)})` }
  if (assistantOf(detail, stream.messageId) === undefined)
    return { status: 'FAIL', detail: `effort ${effort}: the reply was not persisted` }
  const reasoningTokens = stream.metadata?.usage?.reasoningTokens
  return {
    status: 'PASS',
    detail: `effort ${effort}, ${stream.reasoning.length} reasoning characters${reasoningTokens === undefined ? '' : `, ${reasoningTokens} reasoning tokens`}, answer "${oneLine(stream.text, 40)}"`,
  }
}

/** Check 5: `current_time` called and answered, then a text answer; the tool result persisted. */
export function evaluateTools(stream: ChatStreamResult, detail: ChatDetail): LiveCheckResult {
  const problem = streamProblem(stream)
  if (problem !== null)
    return problem
  const calls = stream.toolCalls.filter(call => call.toolName === LIVE_TOOL)
  if (calls.length === 0) {
    const other = stream.toolCalls.map(call => call.toolName).join(', ')
    return { status: 'FAIL', detail: `the model did not call ${LIVE_TOOL}${other === '' ? '' : ` (called: ${other})`}` }
  }
  if (stream.toolErrors.length > 0)
    return { status: 'FAIL', detail: `tool error: ${stream.toolErrors[0]}` }
  if (!calls.some(call => stream.toolOutputs.includes(call.toolCallId)))
    return { status: 'FAIL', detail: `no ${LIVE_TOOL} output in the stream` }
  if (stream.text.trim() === '')
    return { status: 'FAIL', detail: `no answer after the tool result (finish reason: ${finishReason(stream)})` }
  const stored = assistantOf(detail, stream.messageId)
  const storedResult = stored?.parts.some(part => part.type === `tool-${LIVE_TOOL}` && (part as { state?: unknown }).state === 'output-available')
  if (storedResult !== true)
    return { status: 'FAIL', detail: 'the tool result was not persisted' }
  return { status: 'PASS', detail: `${calls.length} ${LIVE_TOOL} call(s), answer "${oneLine(stream.text, 40)}"` }
}

/** The cost of a chat: the recorded one, else an estimate with `FALLBACK_PRICE_PER_MILLION`. */
export function chatCost(totals: Pick<UsageTotals, 'inputTokens' | 'outputTokens' | 'costUsd'>): { usd: number, estimated: boolean } {
  if (totals.costUsd !== null)
    return { usd: totals.costUsd, estimated: false }
  const usd = (totals.inputTokens * FALLBACK_PRICE_PER_MILLION.input + totals.outputTokens * FALLBACK_PRICE_PER_MILLION.output) / 1_000_000
  return { usd, estimated: usd > 0 }
}

// ---------- the checks ----------

/** What the checks run against. `key` is only used to assert that no log record contains it. */
export type LiveTarget = Omit<LiveRunEntry, 'status'>

/** Leaves only `name` enabled among the registered tools. */
async function keepOnlyTool(t: TestApp, name: string): Promise<void> {
  const { items } = await t.client.tools.list()
  for (const tool of items) {
    if (tool.name !== name && tool.enabled)
      await t.client.tools.update({ params: { name: tool.name }, body: { enabled: false } })
  }
}

async function checkProviderTest(t: TestApp, providerId: string): Promise<LiveCheckResult> {
  const result = await t.client.providers.test({ params: { id: providerId } })
  if (result.ok)
    return { status: 'PASS', detail: `${result.modelCount === undefined ? '' : `${result.modelCount} models, `}${Math.round(result.latencyMs)} ms` }
  return result.error === undefined ? { status: 'FAIL', detail: 'ok: false without an error' } : errorResult(result.error)
}

async function checkModels(t: TestApp, target: LiveTarget): Promise<{ result: LiveCheckResult, entry: CatalogModel | null }> {
  let refreshFailure: LiveCheckResult | null = null
  try {
    await t.client.models.refresh({ params: { id: target.providerId } })
  }
  catch (error) {
    refreshFailure = thrownResult(error)
  }
  const { items } = await t.client.models.list({ query: { providerId: target.providerId, includeHidden: true } })
  const entry = items.find(model => model.id === target.modelId) ?? null
  if (refreshFailure !== null)
    return { result: refreshFailure, entry }
  const visible = items.filter(model => !model.hidden).length
  if (entry === null)
    return { result: { status: 'FAIL', detail: `"${target.modelId}" is not in the listing (${visible} visible models)` }, entry }
  if (entry.source !== 'live')
    return { result: { status: 'FAIL', detail: `"${target.modelId}" comes from the ${entry.source} models, not from the live listing` }, entry }
  if (entry.hidden)
    return { result: { status: 'FAIL', detail: `"${target.modelId}" is listed but hidden` }, entry }
  const efforts = entry.reasoningEfforts.filter(effort => effort !== 'auto').join('/') || 'none'
  return { result: { status: 'PASS', detail: `${visible} visible models; ${target.modelId}: tools ${entry.capabilities.tools ? 'yes' : 'no'}, efforts ${efforts}` }, entry }
}

async function checkBadKey(t: TestApp, target: LiveTarget): Promise<LiveCheckResult> {
  if (target.keyField === null)
    return { status: 'SKIP', detail: 'keyless provider' }
  const result = await t.client.providers.test({ params: { id: target.providerId }, body: { values: { [target.keyField]: LIVE_BAD_KEY } } })
  if (result.ok)
    return { status: 'FAIL', detail: 'a wrong key was accepted' }
  if (result.error === undefined)
    return { status: 'FAIL', detail: 'ok: false without an error' }
  if (result.error.code === 'auth_invalid')
    return { status: 'PASS', detail: `auth_invalid${result.error.status === undefined ? '' : ` (HTTP ${result.error.status})`}` }
  const mapped = errorResult(result.error)
  return mapped.status === 'SKIP' ? mapped : { status: 'FAIL', detail: `expected auth_invalid, got ${mapped.detail}` }
}

function checkLogs(t: TestApp, key: string | null): LiveCheckResult {
  if (key === null)
    return { status: 'SKIP', detail: 'no key' }
  if (t.logs.text().includes(key))
    return { status: 'FAIL', detail: 'a log record contains the key' }
  return { status: 'PASS', detail: `${t.logs.records.length} log records checked` }
}

interface ChatCheck {
  effort: ReasoningEffort
  toolMode: ToolMode
  prompt: string
  evaluate: (stream: ChatStreamResult, detail: ChatDetail) => LiveCheckResult
}

/** One paid check in its own chat with a user title (no title call); returns the result and what it cost. */
async function runChatCheck(t: TestApp, target: LiveTarget, check: ChatCheck): Promise<{ result: LiveCheckResult, cost: { usd: number, estimated: boolean } }> {
  const chatId = createChatId()
  await t.client.chats.create({ body: { id: chatId, title: `Live check (${target.providerId})` } })
  const stream = await sendChat(t, {
    chatId,
    text: check.prompt,
    modelRef: formatModelRef(target.providerId, target.modelId),
    reasoningEffort: check.effort,
    toolMode: check.toolMode,
  })
  const detail = await t.client.chats.get({ params: { id: chatId } })
  const cost = chatCost(detail.totals)
  const result = check.evaluate(stream, detail)
  const spent = `${cost.estimated ? '~' : ''}${formatUsd(cost.usd)}`
  return { result: { ...result, detail: result.detail === undefined ? spent : `${result.detail}; ${spent}` }, cost }
}

/**
 * Runs the checks of one provider on an app that has its key (and only its key). Adds the spending to `budget`; never
 * throws for a failing check (a thrown error becomes that check's FAIL).
 */
export async function runProviderChecks(t: TestApp, target: LiveTarget, budget: LiveBudget): Promise<LiveProviderReport> {
  const checks: Partial<Record<LiveCheckId, LiveCheckResult>> = {}
  const spent = { usd: 0, estimated: false }
  const record = (id: LiveCheckId, result: LiveCheckResult): void => {
    checks[id] = result.detail === undefined ? result : { ...result, detail: maskSecrets(result.detail, [target.key]) }
  }
  const guarded = async (id: LiveCheckId, run: () => Promise<LiveCheckResult>): Promise<void> => {
    try {
      record(id, await run())
    }
    catch (error) {
      record(id, thrownResult(error))
    }
  }
  const paid = async (id: LiveCheckId, skipReason: string | null, check: () => ChatCheck): Promise<void> => {
    if (skipReason !== null) {
      record(id, { status: 'SKIP', detail: skipReason })
      return
    }
    if (budgetExhausted(budget)) {
      record(id, { status: 'SKIP', detail: `the budget of ${formatUsd(budget.limitUsd)} is spent (HF_LIVE_MAX_COST_USD)` })
      return
    }
    await guarded(id, async () => {
      const { result, cost } = await runChatCheck(t, target, check())
      spent.usd += cost.usd
      spent.estimated ||= cost.estimated
      budget.spentUsd += cost.usd
      budget.estimated ||= cost.estimated
      return result
    })
  }

  const caps = t.deps.registry.hooks.on(LIVE_PLUGIN_ID, 'chat.params', capChatParams, { priority: CAPS_PRIORITY })
  try {
    await keepOnlyTool(t, LIVE_TOOL)
    await guarded('test', () => checkProviderTest(t, target.providerId))
    const catalog: { entry: CatalogModel | null } = { entry: null }
    await guarded('models', async () => {
      const models = await checkModels(t, target)
      catalog.entry = models.entry
      return models.result
    })
    const model = catalog.entry
    const missing = model === null ? `"${target.modelId}" is not in the catalog` : null
    await paid('chat', missing, () => ({ effort: 'auto', toolMode: 'off', prompt: LIVE_PROMPTS.chat, evaluate: evaluateChat }))
    const effort = model === null ? null : pickReasoningEffort(model)
    await paid('reasoning', missing ?? (effort === null ? 'not a reasoning model (or no effort control)' : null), () => ({
      effort: effort ?? 'auto',
      toolMode: 'off',
      prompt: LIVE_PROMPTS.reasoning,
      evaluate: (stream, detail) => evaluateReasoning(stream, detail, effort ?? 'auto'),
    }))
    await paid('tools', missing ?? (model?.capabilities.tools === true ? null : 'the model has no tool support'), () => ({
      effort: 'auto',
      toolMode: 'auto',
      prompt: LIVE_PROMPTS.tools,
      evaluate: evaluateTools,
    }))
    await guarded('badKey', () => checkBadKey(t, target))
  }
  catch (error) {
    // Setup failed (the tool preferences): every check that has not run yet reports it.
    const failure = thrownResult(error)
    for (const id of ['test', 'models', 'chat', 'reasoning', 'tools', 'badKey'] as const)
      checks[id] ??= failure
  }
  finally {
    caps.dispose()
  }
  record('logs', checkLogs(t, target.key))
  return {
    providerId: target.providerId,
    envVars: target.envVars,
    envVar: target.envVar,
    modelId: target.modelId,
    checks,
    costUsd: spent.usd,
    costEstimated: spent.estimated,
  }
}

/**
 * One provider end to end: an app with only its key (`HF_OFFLINE=1`, in-memory database), the checks, then close. An
 * app that cannot start is reported as a FAIL of the first check, so the provider still gets its summary row.
 */
export async function runLiveProvider(entry: LiveRunEntry, budget: LiveBudget): Promise<LiveProviderReport> {
  const env: Record<string, string> = { HF_OFFLINE: '1' }
  if (entry.envVar !== null && entry.key !== null)
    env[entry.envVar] = entry.key
  let t: TestApp
  try {
    t = await createTestApp({ env })
  }
  catch (error) {
    const failure = thrownResult(error)
    const detail = `the test app did not start: ${maskSecrets(failure.detail ?? '', [entry.key])}`
    return { providerId: entry.providerId, envVars: entry.envVars, envVar: entry.envVar, modelId: entry.modelId, checks: { test: { status: 'FAIL', detail } }, costUsd: 0, costEstimated: false }
  }
  try {
    return await runProviderChecks(t, entry, budget)
  }
  finally {
    await t.close()
  }
}
