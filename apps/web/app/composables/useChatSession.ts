// Chat sessions (docs/UI.md 7.6, 11.1; docs/API.md 6): one `@ai-sdk/vue` `useChat` instance per chat, kept in a
// registry inside detached effect scopes so route changes never stop a stream. The registry keeps the 8 most
// recently used sessions and never evicts one that is submitted, streaming, waiting for an approval or shown by a
// mounted component. `@ai-sdk/vue` 4 has no `resume` option: `resumeIfRunning()` calls `chat.resumeStream()` when the
// chat has an active run. Requests carry only the last UI message plus the composer state (`ChatRequestBody`);
// user message ids come from `createMessageId` (ADR-019). Run state is pushed into the chats store for the sidebar.
import type { UseChatHelpers } from '@ai-sdk/vue'
import type {
  ChatDetail,
  ChatRequestBody,
  ChatSummary,
  ChatTrigger,
  FileRef,
  HarnessUIMessage,
  ReasoningEffort,
  ToolMode,
} from '@harness-forge/shared'
import type { FileUIPart } from 'ai'
import type { ComputedRef, EffectScope, Ref, WritableComputedRef } from 'vue'
import type { ChatRunState as ChatListRunState } from '~/stores/chats'
import { useChat } from '@ai-sdk/vue'
import { createChatId, createMessageId, harnessDataSchemas, HarnessError, messageMetadataSchema } from '@harness-forge/shared'
import { DefaultChatTransport, isFileUIPart, isTextUIPart, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai'
import { computed, effectScope, getCurrentScope, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useApi, useApiFetch } from '~/composables/useApi'
import { useServerEvents } from '~/composables/useServerEvents'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useSettingsStore } from '~/stores/settings'
import { toHarnessError } from '~/utils/errors'

/** Sessions kept alive at once (the least recently used idle one is evicted first). */
export const MAX_CHAT_SESSIONS = 8

/** Endpoint of `POST /api/chat`; `GET {api}/{id}/stream` is the resume URL of `DefaultChatTransport`. */
export const CHAT_API = '/api/chat'

/** Lifecycle of a session as the UI sees it. */
export type ChatRunState = 'idle' | 'submitted' | 'streaming' | 'approval' | 'error'

export interface ChatSendInput {
  text: string
  /** Files already uploaded through `POST /api/files`. */
  files: FileRef[]
}

export interface ToolApprovalDecision {
  /** `approval.id` of the tool part. */
  id: string
  approved: boolean
  toolName: string
  /** "Always allow {tool}": also sets the tool override to `allow` (`PATCH /api/tools/:name`). */
  alwaysAllow: boolean
}

export interface ChatSession {
  id: string
  /** The `useChat` helpers: messages, status, error, sendMessage, regenerate, stop, resumeStream, ... */
  chat: UseChatHelpers<HarnessUIMessage>
  /** Composer state sent with every request; writing a value records the choice (and saves it on the chat). */
  modelRef: WritableComputedRef<string | null>
  reasoningEffort: WritableComputedRef<ReasoningEffort>
  toolMode: WritableComputedRef<ToolMode>
  /** History arrived (always true for a new chat). */
  loaded: Ref<boolean>
  /** `GET /api/chats/:id` answered 404. */
  notFound: Ref<boolean>
  /** Any other load failure. */
  loadError: Ref<HarnessError | null>
  /** The chat as the server last described it (title, running, ...); null for a new chat. */
  summary: Ref<ChatSummary | null>
  /** The server knows the chat (loaded, or a request of this session reached the model). */
  persisted: Ref<boolean>
  runState: ComputedRef<ChatRunState>
  /** A request is in flight (submitted or streaming). */
  busy: ComputedRef<boolean>
  send: (input: ChatSendInput) => Promise<void>
  edit: (messageId: string, text: string) => Promise<void>
  regenerate: (messageId?: string) => Promise<void>
  approve: (decision: ToolApprovalDecision) => Promise<void>
  /** `POST /api/chat/:id/stop`, then the client abort (a client abort alone only disconnects). */
  stop: () => Promise<void>
  /** Loads the history (`GET /api/chats/:id`). */
  load: () => Promise<void>
  /** Reloads the history unless a request is in flight. */
  refresh: () => Promise<void>
  /** Resumes the active run of the chat, if the server or the chats store says there is one. */
  resumeIfRunning: () => Promise<void>
}

export interface ChatSessionRegistry {
  get: (id: string) => ChatSession | undefined
  /** Session ids, most recently used first. */
  ids: Readonly<Ref<readonly string[]>>
}

interface SessionEntry {
  scope: EffectScope
  session: ChatSession
  lastUsed: number
  /** Mounted components currently showing the session (never evicted meanwhile). */
  holds: number
}

const entries = new Map<string, SessionEntry>()
const order = ref<string[]>([])
let clock = 0

// ---------- pure helpers (exported for tests) ----------

/** The request body of `POST /api/chat` (docs/API.md 6.2): only the last UI message plus the composer state. */
export function buildChatRequestBody(input: {
  chatId: string
  messages: readonly HarnessUIMessage[]
  trigger: ChatTrigger
  messageId: string | undefined
  modelRef: string | null
  reasoningEffort: ReasoningEffort
  toolMode: ToolMode
}): ChatRequestBody {
  const message = input.messages.at(-1)
  if (!message)
    throw new HarnessError({ code: 'validation_error', message: 'There is no message to send.' })
  if (!input.modelRef)
    throw new HarnessError({ code: 'validation_error', message: 'Choose a model first.' })
  const body: ChatRequestBody = {
    chatId: input.chatId,
    message,
    trigger: input.trigger,
    modelRef: input.modelRef,
    reasoningEffort: input.reasoningEffort,
    toolMode: input.toolMode,
  }
  // The SDK names the continued assistant message for approval continuations; the contract sends no id there.
  const continuation = input.trigger === 'submit-message' && message.role === 'assistant'
  if (input.messageId && !continuation)
    body.messageId = input.messageId
  return body
}

/** The last message is an assistant message with a tool call waiting for the user. */
export function hasPendingApproval(messages: readonly HarnessUIMessage[]): boolean {
  const last = messages.at(-1)
  return last?.role === 'assistant' && last.parts.some(part => isToolUIPart(part) && part.state === 'approval-requested')
}

/** The sidebar dot of a session state (`setRunState` of the chats store). */
export function toListRunState(state: ChatRunState): ChatListRunState | null {
  if (state === 'submitted' || state === 'streaming')
    return 'running'
  return state === 'approval' ? 'approval' : null
}

/** A `file` UI part for an uploaded file (docs/API.md 6.2). */
export function fileRefToPart(file: FileRef): FileUIPart {
  return { type: 'file', mediaType: file.mime, filename: file.name, url: file.url }
}

function summaryOf(chat: ChatDetail): ChatSummary {
  const { settings: _settings, messages: _messages, totals: _totals, ...summary } = chat
  return summary
}

function missingModel(): HarnessError {
  return new HarnessError({ code: 'validation_error', message: 'Choose a model first.' })
}

// ---------- session ----------

interface SessionDeps {
  api: ReturnType<typeof useApi>
  apiFetch: typeof globalThis.fetch
  chats: ReturnType<typeof useChatsStore>
  models: ReturnType<typeof useModelsStore>
  plugins: ReturnType<typeof usePluginsStore>
  settings: ReturnType<typeof useSettingsStore>
}

interface ChatChoices {
  modelRef?: string | null
  reasoningEffort?: ReasoningEffort
  toolMode?: ToolMode
}

function createSession(id: string, isNew: boolean, deps: SessionDeps): ChatSession {
  const { api, apiFetch, chats, models, plugins, settings } = deps
  // Watchers created later (resume, stop) belong to the session, not to whichever component is active then.
  const sessionScope = getCurrentScope()
  function inSession<T>(create: () => T): T {
    return sessionScope ? sessionScope.run(create) as T : create()
  }

  const loaded = ref(isNew)
  const notFound = ref(false)
  const loadError = shallowRef<HarnessError | null>(null)
  const summary = shallowRef<ChatSummary | null>(null)
  const persisted = ref(!isNew)

  // Composer state: the user's pick wins, then what the chat stored, then the global defaults.
  const stored = shallowRef<ChatChoices>({})
  const picked = shallowRef<ChatChoices>({})

  function persistChoice(patch: ChatChoices) {
    if (!persisted.value)
      return
    const body = patch.modelRef !== undefined
      ? { modelRef: patch.modelRef }
      : { settings: { ...(patch.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}), ...(patch.toolMode ? { toolMode: patch.toolMode } : {}) } }
    // Best effort: the next request stores the choice anyway.
    chats.update(id, body).catch(() => {})
  }

  const modelRef = computed<string | null>({
    get: () => (picked.value.modelRef !== undefined ? picked.value.modelRef : stored.value.modelRef ?? models.defaultRef),
    set: (value) => {
      picked.value = { ...picked.value, modelRef: value }
      if (value)
        persistChoice({ modelRef: value })
    },
  })
  const reasoningEffort = computed<ReasoningEffort>({
    get: () => picked.value.reasoningEffort ?? stored.value.reasoningEffort ?? settings.resolved.defaultReasoningEffort,
    set: (value) => {
      picked.value = { ...picked.value, reasoningEffort: value }
      persistChoice({ reasoningEffort: value })
    },
  })
  const toolMode = computed<ToolMode>({
    get: () => picked.value.toolMode ?? stored.value.toolMode ?? settings.resolved.defaultToolMode,
    set: (value) => {
      picked.value = { ...picked.value, toolMode: value }
      persistChoice({ toolMode: value })
    },
  })

  /** Requests use the values of the moment they were sent; later default changes must not move this chat. */
  function pinChoices() {
    stored.value = { modelRef: modelRef.value, reasoningEffort: reasoningEffort.value, toolMode: toolMode.value }
  }

  // Assistant messages this session streamed itself (not replayed): their run.finished needs no reload.
  const ownMessageIds = new Set<string>()
  let resuming: Promise<void> | null = null
  /** A run of this chat finished while a request was in flight (handled once it settles). */
  let finishedWhileBusy: { messageId: string, outcome: string } | null = null

  const transport = new DefaultChatTransport<HarnessUIMessage>({
    api: CHAT_API,
    fetch: apiFetch,
    prepareSendMessagesRequest: ({ id: chatId, messages, trigger, messageId }) => ({
      body: buildChatRequestBody({
        chatId,
        messages,
        trigger,
        messageId,
        modelRef: modelRef.value,
        reasoningEffort: reasoningEffort.value,
        toolMode: toolMode.value,
      }),
    }),
  })

  const chat = useChat<HarnessUIMessage>({
    id,
    messages: [],
    throttle: 50,
    generateId: createMessageId,
    messageMetadataSchema,
    dataPartSchemas: harnessDataSchemas,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: ({ message }) => {
      if (!resuming && message.role === 'assistant')
        ownMessageIds.add(message.id)
    },
  })

  const busy = computed(() => chat.status.value === 'submitted' || chat.status.value === 'streaming')
  const runState = computed<ChatRunState>(() => {
    const status = chat.status.value
    if (status === 'submitted' || status === 'streaming')
      return status
    if (status === 'error')
      return 'error'
    return hasPendingApproval(chat.messages.value) ? 'approval' : 'idle'
  })

  // The sidebar reads one source: push every change (not the initial idle state, which would clear a dot the
  // server reported for a run this session does not stream).
  watch(runState, state => chats.setRunState(id, toListRunState(state)))
  watch(() => chat.status.value, (status) => {
    if (status === 'streaming')
      persisted.value = true
  })
  watch(runState, () => scheduleTrim())

  function applyDetail(detail: ChatDetail) {
    summary.value = summaryOf(detail)
    stored.value = {
      modelRef: detail.modelRef ?? undefined,
      reasoningEffort: detail.settings.reasoningEffort,
      toolMode: detail.settings.toolMode,
    }
    if (!busy.value)
      chat.messages.value = detail.messages
  }

  let pendingLoad: Promise<void> | null = null
  function load(): Promise<void> {
    pendingLoad ??= (async () => {
      loadError.value = null
      try {
        const detail = await chats.get(id)
        applyDetail(detail)
        loaded.value = true
        notFound.value = false
        persisted.value = true
      }
      catch (error) {
        const failure = toHarnessError(error)
        if (failure.code === 'not_found' && !loaded.value)
          notFound.value = true
        else
          loadError.value = failure
      }
      finally {
        pendingLoad = null
      }
    })()
    return pendingLoad.then(() => resumeIfRunning())
  }

  async function refresh(): Promise<void> {
    if (busy.value || !persisted.value)
      return
    const before = chat.messages.value
    try {
      const detail = await chats.get(id)
      // A request started meanwhile, or the transcript changed: the newer local state wins.
      if (busy.value || chat.messages.value !== before)
        return
      applyDetail(detail)
      loaded.value = true
    }
    catch {
      // Keep the local transcript; the next event or visit reloads it.
    }
  }

  function resumeIfRunning(): Promise<void> {
    if (resuming)
      return resuming
    if (busy.value || !loaded.value || notFound.value)
      return Promise.resolve()
    const running = chats.runState[id] === 'running' || summary.value?.running === true
    if (!running)
      return Promise.resolve()
    let streamed = false
    const stopWatching = inSession(() => watch(() => chat.status.value, (status) => {
      if (status === 'submitted' || status === 'streaming')
        streamed = true
    }, { flush: 'sync' }))
    resuming = (async () => {
      try {
        await chat.resumeStream()
      }
      finally {
        stopWatching()
        resuming = null
      }
      if (summary.value?.running)
        summary.value = { ...summary.value, running: false }
      const finished = finishedWhileBusy
      finishedWhileBusy = null
      if (!streamed) {
        // 204: nothing runs any more; drop a stale running dot.
        chats.setRunState(id, toListRunState(runState.value))
      }
      // A replay rebuilds only what the run streamed (an approval continuation lacks the earlier parts), and a run
      // that finished meanwhile is only in the database: reload either way.
      if (streamed || finished)
        await refresh()
    })()
    return resuming
  }

  // ---------- server events ----------

  function onRunFinished(finished: { messageId: string, outcome: string }) {
    if (finished.outcome === 'completed' && ownMessageIds.has(finished.messageId))
      return
    void refresh()
  }
  const events = useServerEvents()
  events.on('run.finished', (event) => {
    if (event.data.chatId !== id)
      return
    if (busy.value || resuming)
      finishedWhileBusy = event.data
    else
      onRunFinished(event.data)
  })
  events.on('chat.updated', (event) => {
    if (event.data.id === id)
      summary.value = event.data
  })
  events.on('chat.created', (event) => {
    if (event.data.id === id) {
      summary.value = event.data
      persisted.value = true
    }
  })
  events.on('chat.deleted', (event) => {
    if (event.data.id === id)
      queueMicrotask(() => forgetChatSession(id))
  })
  watch(busy, (isBusy) => {
    if (isBusy || resuming || !finishedWhileBusy)
      return
    const finished = finishedWhileBusy
    finishedWhileBusy = null
    onRunFinished(finished)
  })

  // ---------- actions ----------

  async function send(input: ChatSendInput): Promise<void> {
    const text = input.text
    const files = input.files.map(fileRefToPart)
    if (!text.trim() && files.length === 0)
      return
    if (!modelRef.value)
      throw missingModel()
    pinChoices()
    models.touchRecent(modelRef.value)
    await chat.sendMessage(text.trim() ? { text, files } : { files })
  }

  async function edit(messageId: string, text: string): Promise<void> {
    const message = chat.messages.value.find(item => item.id === messageId && item.role === 'user')
    if (!message)
      return
    const files = message.parts.filter(isFileUIPart)
    if (!text.trim() && files.length === 0)
      return
    if (!modelRef.value)
      throw missingModel()
    pinChoices()
    await chat.sendMessage(text.trim() ? { text, files, messageId } : { files, messageId })
  }

  async function regenerate(messageId?: string): Promise<void> {
    if (!modelRef.value)
      throw missingModel()
    pinChoices()
    const messages = chat.messages.value
    const last = messages.at(-1)
    if (!messageId && last?.role === 'user') {
      // The request failed before any reply existed (the server never stored this message): send it again.
      const text = last.parts.filter(isTextUIPart).map(part => part.text).join('\n\n')
      const files = last.parts.filter(isFileUIPart)
      chat.messages.value = messages.slice(0, -1)
      await chat.sendMessage(text.trim() ? { text, files } : { files })
      return
    }
    await chat.regenerate(messageId ? { messageId } : {})
  }

  async function approve(decision: ToolApprovalDecision): Promise<void> {
    const preference = decision.approved && decision.alwaysAllow
      ? plugins.setToolPref(decision.toolName, { override: 'allow' })
      : null
    await chat.addToolApprovalResponse({ id: decision.id, approved: decision.approved })
    if (preference)
      await preference
  }

  function markAborted(messageId: string) {
    chat.messages.value = chat.messages.value.map((message) => {
      if (message.id !== messageId || !message.metadata)
        return message
      return { ...message, metadata: { ...message.metadata, aborted: true } }
    })
  }

  /** Resolves once no request is in flight (or after `timeoutMs`). */
  function whenIdle(timeoutMs = 2000): Promise<void> {
    if (!busy.value)
      return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs)
      const stopWatching = inSession(() => watch(busy, (isBusy) => {
        if (!isBusy)
          done()
      }))
      function done() {
        clearTimeout(timer)
        stopWatching()
        resolve()
      }
    })
  }

  async function stop(): Promise<void> {
    const wasBusy = busy.value || resuming !== null
    try {
      await api.chat.stop({ params: { id } })
    }
    catch {
      // No run on the server (or it is gone): the client abort below still ends the local request.
    }
    await chat.stop()
    if (!wasBusy)
      return
    await whenIdle()
    // The partial reply stays; mark it like the server persists it (`metadata.aborted`).
    const last = chat.messages.value.at(-1)
    if (last?.role === 'assistant')
      markAborted(last.id)
  }

  return {
    id,
    chat,
    modelRef,
    reasoningEffort,
    toolMode,
    loaded,
    notFound,
    loadError,
    summary,
    persisted,
    runState,
    busy,
    send,
    edit,
    regenerate,
    approve,
    stop,
    load,
    refresh,
    resumeIfRunning,
  }
}

// ---------- registry ----------

function syncOrder() {
  order.value = [...entries.entries()].sort(([, a], [, b]) => b.lastUsed - a.lastUsed).map(([id]) => id)
}

function isEvictable(entry: SessionEntry): boolean {
  const state = entry.session.runState.value
  return entry.holds === 0 && state !== 'submitted' && state !== 'streaming' && state !== 'approval'
}

function disposeEntry(id: string) {
  const entry = entries.get(id)
  if (!entry)
    return
  entries.delete(id)
  entry.scope.stop()
}

/** Evicts the least recently used idle sessions above the limit (`keep` is never evicted). */
function trim(keep?: string) {
  if (entries.size <= MAX_CHAT_SESSIONS)
    return
  const candidates = [...entries.entries()].sort(([, a], [, b]) => a.lastUsed - b.lastUsed)
  for (const [id, entry] of candidates) {
    if (entries.size <= MAX_CHAT_SESSIONS)
      break
    if (id !== keep && isEvictable(entry))
      disposeEntry(id)
  }
  syncOrder()
}

let trimQueued = false
function scheduleTrim() {
  if (trimQueued)
    return
  trimQueued = true
  queueMicrotask(() => {
    trimQueued = false
    trim()
  })
}

/**
 * The session of chat `id`, created on first use (history loads unless `isNew`). Called from a component setup, the
 * session is held (never evicted) until that component unmounts.
 */
export function useChatSession(id: string, options: { isNew?: boolean } = {}): ChatSession {
  let entry = entries.get(id)
  if (!entry) {
    const deps: SessionDeps = {
      api: useApi(),
      apiFetch: useApiFetch(),
      chats: useChatsStore(),
      models: useModelsStore(),
      plugins: usePluginsStore(),
      settings: useSettingsStore(),
    }
    const scope = effectScope(true)
    const session = scope.run(() => createSession(id, options.isNew === true, deps))!
    entry = { scope, session, lastUsed: 0, holds: 0 }
    entries.set(id, entry)
  }
  entry.lastUsed = ++clock
  const held = entry
  if (getCurrentScope()) {
    held.holds += 1
    onScopeDispose(() => {
      held.holds = Math.max(0, held.holds - 1)
      scheduleTrim()
    })
  }
  trim(id)
  syncOrder()
  const session = entry.session
  if (!session.loaded.value && !options.isNew)
    void session.load()
  else
    void session.resumeIfRunning()
  return session
}

/** Read access to the live sessions (e.g. to keep a new chat's stream when its page changes). */
export function useChatSessionRegistry(): ChatSessionRegistry {
  return {
    get: id => entries.get(id)?.session,
    ids: computed(() => order.value),
  }
}

/** Drops the session of a deleted chat (its stream is stopped first). */
export function forgetChatSession(id: string): void {
  const entry = entries.get(id)
  if (!entry)
    return
  void entry.session.chat.stop()
  disposeEntry(id)
  syncOrder()
}

let draftChatId: string | null = null

/**
 * The chat id of the `/` page: a fresh uuidv7 that stays the same until a message was sent with it, so an unsent
 * draft (kept per chat id by the composer) survives leaving and coming back.
 */
export function useDraftChatId(): string {
  draftChatId ??= createChatId()
  return draftChatId
}

/** The draft id was used by a first send: the next visit of `/` gets a new one. */
export function releaseDraftChatId(id: string): void {
  if (draftChatId === id)
    draftChatId = null
}

/** Test helper: disposes every session. */
export function resetChatSessions(): void {
  for (const id of [...entries.keys()])
    disposeEntry(id)
  clock = 0
  draftChatId = null
  syncOrder()
}
