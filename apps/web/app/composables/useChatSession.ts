// Chat sessions (docs/UI.md 7.5, 7.6, 11.1; docs/API.md 6): one `@ai-sdk/vue` `useChat` instance per chat, kept in a
// registry inside detached effect scopes so route changes never stop a stream. The registry keeps the 8 most
// recently used sessions and never evicts one that is submitted, streaming, waiting for an approval or shown by a
// mounted component. `@ai-sdk/vue` 4 has no `resume` option: `resumeIfRunning()` calls `chat.resumeStream()` when the
// chat has an active run. Requests carry only the last UI message plus the composer state (`ChatRequestBody`);
// user message ids come from `createMessageId` (ADR-019). Run state is pushed into the chats store for the sidebar.
//
// Branching (ADR-023): the transcript is the chat's active path and `branches` lists the versions of its messages. A
// new user message names its parent (the message before it on the shown path), an edit is a new user message under
// the edited message's parent (with the editor's files, S8), a regenerate names its target, `switchBranch()` shows
// another version and `deleteVersion()` removes one (ADR-030). A user message whose request failed with an HTTP error
// was never stored, so it is never named as a parent; a `404` means the shown path is stale and reloads it. Another tab
// that moves the active leaf is followed: `chat.updated` carries it, and an idle session whose path ends elsewhere
// reloads the path (`followActiveLeaf()`, S5). Image-capable models get the composer's image options (ADR-028).
import type { UseChatHelpers } from '@ai-sdk/vue'
import type {
  ChatDetail,
  ChatRequestBody,
  ChatSummary,
  ChatTrigger,
  ChatUpdatedData,
  FileRef,
  HarnessUIMessage,
  ImageOptions,
  MessageBranch,
  ReasoningEffort,
  ToolMode,
} from '@harness-forge/shared'
import type { FileUIPart } from 'ai'
import type { ComputedRef, EffectScope, Ref, WritableComputedRef } from 'vue'
import type { ChatRunState as ChatListRunState } from '~/stores/chats'
import { useChat } from '@ai-sdk/vue'
import { createChatId, createMessageId, harnessDataSchemas, HarnessError, messageMetadataSchema } from '@harness-forge/shared'
import {
  APICallError,
  DefaultChatTransport,
  isFileUIPart,
  isTextUIPart,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from 'ai'
import { computed, effectScope, getCurrentScope, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useApi, useApiFetch } from '~/composables/useApi'
import { useImageOptions } from '~/composables/useImageOptions'
import { useServerEvents } from '~/composables/useServerEvents'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useSettingsStore } from '~/stores/settings'
import { hasErrorCode, toHarnessError } from '~/utils/errors'

/** Sessions kept alive at once (the least recently used idle one is evicted first). */
export const MAX_CHAT_SESSIONS = 8

/** Endpoint of `POST /api/chat`; `GET {api}/{id}/stream` is the resume URL of `DefaultChatTransport`. */
export const CHAT_API = '/api/chat'

/**
 * Data-part schemas for `useChat`. AI SDK 7.0.116 looks them up by the full chunk type (`data-notice`) while its types
 * (and the server's `validateUIMessages`) key them by name (`notice`), so every schema is registered under both keys:
 * streamed notices are validated, and a malformed one fails the request instead of rendering.
 */
export const chatDataPartSchemas: typeof harnessDataSchemas = withStreamKeys(harnessDataSchemas)

function withStreamKeys<T extends Record<string, unknown>>(schemas: T): T {
  const keyed: Record<string, unknown> = { ...schemas }
  for (const [name, schema] of Object.entries(schemas))
    keyed[`data-${name}`] = schema
  return keyed as T
}

/**
 * Lifecycle of a session as the UI sees it. (Not named `ChatRunState`: the chats store exports that name for the
 * sidebar dot, and Nuxt auto-imports both files.)
 */
export type ChatSessionRunState = 'idle' | 'submitted' | 'streaming' | 'approval' | 'error'

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
  /**
   * + Phase 7: "Accept all edits in this chat": `toolMode = 'edits'` is set (and saved on the chat) before the approval
   * is sent (W7.10).
   */
  acceptEdits?: boolean
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
  runState: ComputedRef<ChatSessionRunState>
  /** A request is in flight (submitted or streaming). */
  busy: ComputedRef<boolean>
  /** `ChatDetail.branches` of the shown path: the versions of every path message that has more than one. */
  branches: Ref<Record<string, MessageBranch>>
  /** A `switchBranch()` or `deleteVersion()` request is in flight. */
  switching: Ref<boolean>
  /** A new user message; its parent is the message before it on the shown path. */
  send: (input: ChatSendInput) => Promise<void>
  /**
   * A new version of a user message: the messages from it on are replaced by the new version and its reply. `files`
   * is the full new set of attachments (`[]` removes them all); omitted, the edited message keeps its files.
   */
  edit: (messageId: string, text: string, files?: readonly FileUIPart[]) => Promise<void>
  /**
   * Deletes a version of a message and everything after it (`DELETE /api/chats/:id/messages/:messageId`), then shows
   * the returned path, like `switchBranch()`: nothing while a request or a switch is in flight; `409 conflict`
   * (`run-active`) follows the running reply, `404` reloads the path; the `HarnessError` is thrown after handling.
   */
  deleteVersion: (messageId: string) => Promise<void>
  /**
   * Another tab moved the active leaf (`chat.updated`): reloads the path (`GET /api/chats/:id`, the shared prefix
   * kept) while the session is idle. Coalesced: calls during a reload share it.
   */
  followActiveLeaf: () => Promise<void>
  /**
   * A new version of a reply (default: the last message), or a first reply to a user message. A user message whose
   * request failed with an HTTP error (never stored) is sent again instead.
   */
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
  /**
   * Shows another version of a message (`POST /api/chats/:id/branch`): the path last shown under it (ADR-030; else
   * the most recent one). Does nothing while a request or another switch is in flight. Throws the `HarnessError` of a
   * refused switch after handling it: `409 conflict` follows the running reply, `404 not_found` reloads the path.
   */
  switchBranch: (messageId: string) => Promise<void>
  /** Refetches the chat after this session's own edit or regenerate, so the new version shows in `branches`. */
  refreshBranches: () => Promise<void>
  /**
   * Removes the user message whose request failed with an HTTP error (the server never stored it) from the transcript
   * and returns it, e.g. to put its text back into the composer; null when there is none.
   */
  takeBackUnstored: () => HarnessUIMessage | null
  /**
   * + Phase 7 (ADR-031): the chat's project. A new chat: the picker's choice, else the filter's project (when it names a
   * known project); a saved chat: `chats.byId(id)?.projectId ?? summary.projectId`. Skeleton (C15, P7-0b): always null
   * until W7.10 implements it.
   */
  projectId: ComputedRef<string | null>
  /**
   * + Phase 7: a new chat: local only (sent with the first request); a persisted chat: `PATCH /api/chats/:id
   * { projectId }` (throws `HarnessError` on 409 run-active / 404). Skeleton (C15, P7-0b): rejects with
   * `not_implemented` until W7.10 implements it.
   */
  setProject: (projectId: string | null) => Promise<void>
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

/** What a `POST /api/chat` asks for (docs/API.md 6.2): a new user message, a regenerate, or an approval continuation. */
export type ChatRequestKind = 'new' | 'regenerate' | 'continuation'

export function chatRequestKind(trigger: ChatTrigger, message: HarnessUIMessage): ChatRequestKind {
  if (trigger === 'regenerate-message')
    return 'regenerate'
  return message.role === 'user' ? 'new' : 'continuation'
}

/**
 * The request body of `POST /api/chat` (docs/API.md 6.2): only the last UI message plus the composer state. A new user
 * message (also an edit) names its parent: the message before it on the shown path, `null` for a first message. A
 * regenerate names its target (`messageId`; omitted = the active leaf). An approval continuation names neither (the
 * SDK passes the continued message's id, which the contract does not send).
 */
export function buildChatRequestBody(input: {
  chatId: string
  messages: readonly HarnessUIMessage[]
  trigger: ChatTrigger
  messageId: string | undefined
  modelRef: string | null
  reasoningEffort: ReasoningEffort
  toolMode: ToolMode
  /** `useImageOptions().forModel(model)`: set only for image models and chat models with image output (ADR-028). */
  imageOptions?: ImageOptions
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
  const kind = chatRequestKind(input.trigger, message)
  if (kind === 'new')
    body.parentId = input.messages.at(-2)?.id ?? null
  else if (kind === 'regenerate' && input.messageId)
    body.messageId = input.messageId
  if (input.imageOptions)
    body.imageOptions = input.imageOptions
  return body
}

/**
 * A chat request answered with an HTTP error before its stream started (`APICallError` with a status): the server
 * stored nothing (docs/API.md 6.2).
 */
export function isHttpError(error: unknown): boolean {
  return APICallError.isInstance(error) && typeof error.statusCode === 'number'
}

function conflictReason(error: unknown): unknown {
  const failure = toHarnessError(error)
  return failure.code === 'conflict' ? (failure.details as { reason?: unknown } | undefined)?.reason ?? null : undefined
}

/** `409 conflict` because a run holds the chat (reason `run-active`, or none given): docs/UI.md 7.4. */
export function isRunActiveConflict(error: unknown): boolean {
  const reason = conflictReason(error)
  return reason === null || reason === 'run-active'
}

/** The server stored nothing for a new user message whose request failed this way. */
function isUnstoredFailure(error: unknown): boolean {
  // Except `409 conflict` reason `exists`: a message with that id is already stored.
  return isHttpError(error) && conflictReason(error) !== 'exists'
}

/**
 * The next shown path, keeping the message objects of the prefix whose ids did not change, so the memoized transcript
 * rows of that prefix do not render again (docs/UI.md 11.1).
 */
export function mergePath(current: readonly HarnessUIMessage[], next: readonly HarnessUIMessage[]): HarnessUIMessage[] {
  let shared = 0
  while (shared < current.length && shared < next.length && current[shared]!.id === next[shared]!.id)
    shared += 1
  return [...current.slice(0, shared), ...next.slice(shared)]
}

/**
 * The chat's active leaf is not the end of the shown path (docs/UI.md 7.5, 11.1; ADR-030): true when the last stored
 * message shown is not `leaf`. A trailing message the server never stored (`unstoredId`, and anything after it) is
 * ignored.
 */
export function leafMovedElsewhere(messages: readonly HarnessUIMessage[], leaf: string | null, unstoredId: string | null): boolean {
  const unstored = unstoredId === null ? -1 : messages.findIndex(message => message.id === unstoredId)
  const stored = unstored === -1 ? messages : messages.slice(0, unstored)
  return (stored.at(-1)?.id ?? null) !== leaf
}

/** Both paths show the same messages (ids, in order). */
export function samePathIds(a: readonly HarnessUIMessage[], b: readonly HarnessUIMessage[]): boolean {
  return a.length === b.length && a.every((message, index) => message.id === b[index]!.id)
}

/** The last message is an assistant message with a tool call waiting for the user. */
export function hasPendingApproval(messages: readonly HarnessUIMessage[]): boolean {
  const last = messages.at(-1)
  return last?.role === 'assistant' && last.parts.some(part => isToolUIPart(part) && part.state === 'approval-requested')
}

/** The sidebar dot of a session state (`setRunState` of the chats store). */
export function toListRunState(state: ChatSessionRunState): ChatListRunState | null {
  if (state === 'submitted' || state === 'streaming')
    return 'running'
  return state === 'approval' ? 'approval' : null
}

/** A `file` UI part for an uploaded file (docs/API.md 6.2). */
export function fileRefToPart(file: FileRef): FileUIPart {
  return { type: 'file', mediaType: file.mime, filename: file.name, url: file.url }
}

function summaryOf(chat: ChatDetail): ChatSummary {
  const { settings: _settings, messages: _messages, branches: _branches, totals: _totals, ...summary } = chat
  return summary
}

/** The summary part of `chat.updated` data (the active leaf is not a summary field). */
function summaryOfUpdate(data: ChatUpdatedData): ChatSummary {
  const { activeLeafId: _activeLeafId, ...summary } = data
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
  imageOptions: ReturnType<typeof useImageOptions>
}

interface ChatChoices {
  modelRef?: string | null
  reasoningEffort?: ReasoningEffort
  toolMode?: ToolMode
}

function createSession(id: string, isNew: boolean, deps: SessionDeps): ChatSession {
  const { api, apiFetch, chats, models, plugins, settings, imageOptions } = deps
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

  // ---------- branching state (ADR-023) ----------

  const branches = shallowRef<Record<string, MessageBranch>>({})
  const switching = ref(false)
  /** The switch in flight: a new request waits for it, so it starts from the path the switch shows. */
  let pendingSwitch: Promise<void> | null = null
  /** The chat request in flight, from the moment its body is built until it ends. */
  let request: { kind: ChatRequestKind, userMessageId: string | null } | null = null
  /** The user message whose request failed with an HTTP error: the server never stored it. */
  let unstoredMessageId: string | null = null
  /** The request that just ended was answered `404`: the shown path is stale. */
  let stalePath = false
  /** This session's edit or regenerate added a version: `branches` is refetched once its run finished. */
  let branchesStale = false

  // ---------- other tabs (ADR-030) ----------

  /** The active leaf named by the latest `chat.updated` of this chat (undefined before the first one). */
  let latestLeaf: string | null | undefined
  /** The `followActiveLeaf()` reload in flight. */
  let following: Promise<void> | null = null
  /** Another `chat.updated` arrived while the reload ran: check the path again once it ends. */
  let followAgain = false
  /**
   * A leaf the last reload could not reach: the stored leaf can be null or dangling while the server shows its newest
   * path. Events that repeat it (a rename, a pin) are not followed again until another leaf is announced.
   */
  let unreachableLeaf: string | null | undefined

  const transport = new DefaultChatTransport<HarnessUIMessage>({
    api: CHAT_API,
    fetch: apiFetch,
    prepareSendMessagesRequest: ({ id: chatId, messages, trigger, messageId }) => {
      const body = buildChatRequestBody({
        chatId,
        messages,
        trigger,
        messageId,
        modelRef: modelRef.value,
        reasoningEffort: reasoningEffort.value,
        toolMode: toolMode.value,
        imageOptions: imageOptions.forModel(modelRef.value ? models.byRef(modelRef.value) : null),
      })
      const kind = chatRequestKind(trigger, body.message)
      request = { kind, userMessageId: kind === 'new' ? body.message.id : null }
      return { body }
    },
  })

  const chat = useChat<HarnessUIMessage>({
    id,
    messages: [],
    throttle: 50,
    generateId: createMessageId,
    messageMetadataSchema,
    dataPartSchemas: chatDataPartSchemas,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    // Called before `chat.error` is set, only for the requests of this session (a failed resume has no `request`).
    onError: (error) => {
      if (!request)
        return
      if (request.kind === 'new' && isUnstoredFailure(error))
        unstoredMessageId = request.userMessageId
      if (hasErrorCode(error, 'not_found'))
        stalePath = true
    },
    onFinish: ({ message }) => {
      request = null
      if (!resuming && message.role === 'assistant')
        ownMessageIds.add(message.id)
      if (stalePath) {
        stalePath = false
        // After the views reacted to the error (the unstored message may go back into the composer), not before.
        void nextTick().then(recoverStalePath)
      }
    },
  })

  const busy = computed(() => chat.status.value === 'submitted' || chat.status.value === 'streaming')
  const runState = computed<ChatSessionRunState>(() => {
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

  /**
   * Shows a chat detail from the server: the summary and stored choices, and (unless a request is in flight) its
   * path and versions. `keepPrefix` keeps the message objects of the unchanged prefix (a switch, a branch refresh).
   */
  function applyDetail(detail: ChatDetail, options: { keepPrefix?: boolean } = {}) {
    summary.value = summaryOf(detail)
    stored.value = {
      modelRef: detail.modelRef ?? undefined,
      reasoningEffort: detail.settings.reasoningEffort,
      toolMode: detail.settings.toolMode,
    }
    if (busy.value)
      return
    chat.messages.value = options.keepPrefix ? mergePath(chat.messages.value, detail.messages) : [...detail.messages]
    branches.value = detail.branches
    branchesStale = false
    // The server never had it, so it is not on the path it sent.
    unstoredMessageId = null
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

  /**
   * After this session's own edit or regenerate: the transcript already shows the new version, only its siblings are
   * unknown. The same path replaces only `branches`; another path (the chat changed elsewhere) is applied whole.
   */
  async function refreshBranches(): Promise<void> {
    if (busy.value || !persisted.value)
      return
    const before = chat.messages.value
    try {
      const detail = await chats.get(id)
      if (busy.value || switching.value)
        return
      if (samePathIds(chat.messages.value, detail.messages)) {
        summary.value = summaryOf(detail)
        branches.value = detail.branches
        branchesStale = false
      }
      else if (chat.messages.value === before) {
        applyDetail(detail, { keepPrefix: true })
      }
    }
    catch {
      // The versions show on the next load.
    }
  }

  /** A request was answered `404` (an unknown parent or target): the shown path is stale, so reload it. */
  async function recoverStalePath(): Promise<void> {
    await refresh()
    if (chat.status.value === 'error' && hasErrorCode(chat.error.value, 'not_found'))
      chat.clearError()
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
    if (ownMessageIds.has(finished.messageId)) {
      // This session streamed the reply, so its transcript is current; an edit or a regenerate added a version.
      if (branchesStale) {
        void refreshBranches()
        return
      }
      if (finished.outcome === 'completed')
        return
    }
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
    if (event.data.id !== id)
      return
    summary.value = summaryOfUpdate(event.data)
    const leaf = event.data.activeLeafId
    latestLeaf = leaf
    if (leaf !== unreachableLeaf)
      unreachableLeaf = undefined
    if (following) {
      followAgain = true
      return
    }
    // A switch or deletion in another tab; this session's own changes end at that leaf already.
    if (unreachableLeaf === undefined && isIdle() && leafMovedElsewhere(chat.messages.value, leaf, unstoredMessageId))
      void followActiveLeaf()
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

  /** The tracked unstored user message, while the transcript still shows it. */
  function unstoredMessage(): HarnessUIMessage | null {
    if (!unstoredMessageId)
      return null
    const message = chat.messages.value.find(item => item.id === unstoredMessageId)
    if (!message)
      unstoredMessageId = null
    return message ?? null
  }

  function takeBackUnstored(): HarnessUIMessage | null {
    const message = unstoredMessage()
    if (!message)
      return null
    unstoredMessageId = null
    const messages = chat.messages.value
    // Anything after it was never stored either.
    chat.messages.value = messages.slice(0, messages.indexOf(message))
    return message
  }

  async function send(input: ChatSendInput): Promise<void> {
    const text = input.text
    const files = input.files.map(fileRefToPart)
    if (!text.trim() && files.length === 0)
      return
    if (!modelRef.value)
      throw missingModel()
    if (pendingSwitch)
      await pendingSwitch.catch(() => {})
    pinChoices()
    models.touchRecent(modelRef.value)
    // `parentId` never names a message the server did not store.
    takeBackUnstored()
    await chat.sendMessage(text.trim() ? { text, files } : { files })
  }

  async function edit(messageId: string, text: string, nextFiles?: readonly FileUIPart[]): Promise<void> {
    if (busy.value)
      return
    if (pendingSwitch)
      await pendingSwitch.catch(() => {})
    const messages = chat.messages.value
    const index = messages.findIndex(item => item.id === messageId && item.role === 'user')
    if (index === -1)
      return
    // The editor's full new set (`[]` removes every attachment); omitted, the edited message keeps its files.
    const files = nextFiles ? [...nextFiles] : messages[index]!.parts.filter(isFileUIPart)
    if (!text.trim() && files.length === 0)
      return
    if (!modelRef.value)
      throw missingModel()
    pinChoices()
    // A new version: the SDK gives the new message a new id, and its parent is the edited message's parent (the
    // message before it). The old version and everything after it stay on the server.
    chat.messages.value = messages.slice(0, index)
    // Forgets an unstored message the cut removed.
    unstoredMessage()
    branchesStale = true
    await chat.sendMessage(text.trim() ? { text, files } : { files })
  }

  async function regenerate(messageId?: string): Promise<void> {
    if (busy.value)
      return
    if (!modelRef.value)
      throw missingModel()
    if (pendingSwitch)
      await pendingSwitch.catch(() => {})
    const unstored = unstoredMessage()
    if (unstored && (messageId === undefined || messageId === unstored.id)) {
      // Its request failed before the server stored it (the Retry of docs/UI.md 7.4): send it again as a new message.
      pinChoices()
      takeBackUnstored()
      // It may have been an edit, whose parent has other versions.
      branchesStale = true
      const text = unstored.parts.filter(isTextUIPart).map(part => part.text).join('\n\n')
      const files = unstored.parts.filter(isFileUIPart)
      await chat.sendMessage(text.trim() ? { text, files } : { files })
      return
    }
    const messages = chat.messages.value
    const target = messageId === undefined ? messages.at(-1) : messages.find(item => item.id === messageId)
    if (!target)
      return
    pinChoices()
    branchesStale = true
    // A reply gets a new version under its user message; a user message without a reply is answered. The last reply
    // is named by the active leaf (its id may be local when its stream failed early).
    await chat.regenerate(messageId !== undefined || target.role === 'user' ? { messageId: target.id } : {})
  }

  function followRun() {
    chats.setRunState(id, 'running')
    // The run may belong to another version: show the path it started from, then follow the reply on top of it.
    void refresh().then(() => resumeIfRunning())
  }

  /**
   * Shows the path a version switch or deletion answers with, keeping the shared prefix objects. Does nothing while a
   * request or another switch is in flight; `409 conflict` (`run-active`) follows the running reply, `404` reloads the
   * path, and the `HarnessError` is thrown after handling it.
   */
  function changePath(request: () => Promise<ChatDetail>): Promise<void> {
    if (busy.value || switching.value || resuming || !persisted.value)
      return Promise.resolve()
    switching.value = true
    const task = (async () => {
      try {
        const detail = await request()
        applyDetail(detail, { keepPrefix: true })
      }
      catch (error) {
        const failure = toHarnessError(error)
        if (isRunActiveConflict(failure))
          followRun()
        else if (failure.code === 'not_found')
          void refresh()
        throw failure
      }
      finally {
        switching.value = false
      }
    })()
    pendingSwitch = task
    void task.catch(() => {}).then(() => {
      if (pendingSwitch === task)
        pendingSwitch = null
    })
    return task
  }

  function switchBranch(messageId: string): Promise<void> {
    return changePath(() => api.chats.switchBranch({ params: { id }, body: { messageId } }))
  }

  function deleteVersion(messageId: string): Promise<void> {
    return changePath(() => api.chats.deleteMessage({ params: { id, messageId } }))
  }

  /** Loaded, known to the server, and nothing runs: no request, switch or resume in flight. */
  function isIdle(): boolean {
    return loaded.value && persisted.value && !busy.value && !switching.value && !pendingSwitch && !resuming
  }

  /**
   * One reload of the path while idle; dropped when the transcript changed meanwhile (the newer local state wins).
   * True when the server's path was applied.
   */
  async function followOnce(): Promise<boolean> {
    if (!isIdle())
      return false
    const before = chat.messages.value
    try {
      const detail = await chats.get(id)
      if (!isIdle() || chat.messages.value !== before)
        return false
      applyDetail(detail, { keepPrefix: true })
      return true
    }
    catch {
      // Keep the transcript; the next event or visit reloads it.
      return false
    }
  }

  function followActiveLeaf(): Promise<void> {
    if (following) {
      followAgain = true
      return following
    }
    const task = (async () => {
      try {
        for (;;) {
          followAgain = false
          const applied = await followOnce()
          const leaf = latestLeaf
          if (leaf === undefined || !isIdle() || !leafMovedElsewhere(chat.messages.value, leaf, unstoredMessageId))
            break
          // A leaf announced during the reload that the path does not end at yet: one more reload.
          if (followAgain)
            continue
          // The server's own path does not end at the leaf it announced: not again for that leaf.
          if (applied)
            unreachableLeaf = leaf
          break
        }
      }
      finally {
        following = null
        followAgain = false
      }
    })()
    following = task
    return task
  }

  // Phase 7 skeleton (C15, P7-0b): W7.10 implements the project of the session.
  const projectId = computed<string | null>(() => null)

  async function setProject(_projectId: string | null): Promise<void> {
    throw new HarnessError({ code: 'not_implemented', message: 'Moving a chat to a project is not implemented yet.' })
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
    branches,
    switching,
    send,
    edit,
    deleteVersion,
    followActiveLeaf,
    regenerate,
    approve,
    stop,
    load,
    refresh,
    resumeIfRunning,
    switchBranch,
    refreshBranches,
    takeBackUnstored,
    projectId,
    setProject,
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
      imageOptions: useImageOptions(),
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
