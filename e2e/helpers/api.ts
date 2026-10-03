// API helpers for setup and teardown (docs/API.md). `HarnessApi.client` is the typed `createApiClient()` of
// @harness-forge/shared (every route of the route table, `client.<module>.<action>(input)`), sent through a
// Playwright `APIRequestContext`: requests show up in traces and share cookies with that context (use
// `page.request` / `context.request` to act as the logged-in browser). The class adds the few higher-level helpers the
// specs need. Keep the method names stable: plugin specs import them too (e2e/README.md).
import type { APIRequestContext } from '@playwright/test'
import type {
  ApiClient,
  ChatDetail,
  ChatSummary,
  CredentialValues,
  HarnessUIMessage,
  ImageOptions,
  ProviderSummary,
  ReasoningEffort,
  Settings,
  SettingsUpdate,
  ToolMode,
} from '../../packages/shared/src/index.ts'
import { expect, request as playwrightRequest } from '@playwright/test'
import { createApiClient, createChatId, createMessageId } from '../../packages/shared/src/index.ts'
import { apiBaseUrl, baseUrlFromEnv } from './env.ts'

type FetchInput = Parameters<typeof globalThis.fetch>[0]
type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>
type FetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>

/** Statuses whose `Response` must not have a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string')
    return input
  return input instanceof URL ? input.href : input.url
}

function requestHeaders(headers: FetchInit['headers']): Record<string, string> {
  if (headers === undefined)
    return {}
  if (headers instanceof Headers)
    return Object.fromEntries(headers.entries())
  if (Array.isArray(headers))
    return Object.fromEntries(headers)
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers))
    result[name] = typeof value === 'string' ? value : value.join(', ')
  return result
}

/**
 * A `fetch` backed by a Playwright `APIRequestContext` (for `createApiClient({ fetch })`): same cookies as the
 * context, no redirects followed, never throws on HTTP errors. Bodies are buffered (streams arrive complete).
 */
export function requestFetch(context: APIRequestContext): typeof globalThis.fetch {
  return async (input: FetchInput, init: FetchInit = {}) => {
    const options: FetchOptions = {
      method: init.method ?? 'GET',
      headers: requestHeaders(init.headers),
      failOnStatusCode: false,
      maxRedirects: 0,
    }
    if (init.body instanceof FormData)
      options.multipart = init.body
    else if (typeof init.body === 'string')
      options.data = init.body
    else if (init.body !== undefined && init.body !== null)
      throw new TypeError('requestFetch supports string and FormData bodies only.')
    const response = await context.fetch(requestUrl(input), options)
    const status = response.status()
    const body = NULL_BODY_STATUSES.has(status) ? null : new Uint8Array(await response.body())
    return new Response(body, {
      status,
      statusText: response.statusText(),
      headers: response.headersArray().map(({ name, value }) => [name, value] as [string, string]),
    })
  }
}

/** One event of an AI SDK UI message stream (`data: {...}` lines of `POST /api/chat`). */
export interface UiStreamChunk {
  type: string
  [key: string]: unknown
}

/** Parses the SSE body of a UI message stream into its JSON chunks (`[DONE]` is dropped). */
export function parseUiMessageStream(body: string): UiStreamChunk[] {
  const chunks: UiStreamChunk[] = []
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:'))
      continue
    const data = line.slice('data:'.length).trim()
    if (data === '' || data === '[DONE]')
      continue
    chunks.push(JSON.parse(data) as UiStreamChunk)
  }
  return chunks
}

/** Concatenated `text-delta` chunks of a UI message stream. */
export function streamText(chunks: readonly UiStreamChunk[]): string {
  return chunks.map(chunk => (chunk.type === 'text-delta' && typeof chunk.delta === 'string' ? chunk.delta : '')).join('')
}

export interface SendChatInput {
  /** Default: a new uuidv7 chat (the server creates it). */
  chatId?: string
  text: string
  /**
   * The parent of the new message (docs/API.md 6.2): omitted = the chat's active leaf, `null` = a first message. An
   * edit (a new version of a user message) sends the parent of the edited message.
   */
  parentId?: string | null
  /** Default `mock:echo`. */
  modelRef?: string
  /** Default `ask`. */
  toolMode?: ToolMode
  /** Default `auto`. */
  reasoningEffort?: ReasoningEffort
  /** Image options (docs/API.md 4.18): only for image models and chat models with image output. */
  imageOptions?: ImageOptions
  /** The project of a new chat (Phase 7, ADR-031): honored only when this request creates the chat. */
  projectId?: string
}

export interface AnswerApprovalsInput {
  chatId: string
  /** Allow (true) or deny (false) every pending approval of the chat's active leaf. */
  approved: boolean
  /** Default `mock:echo`; the model of the continuation (e.g. `mock:workspace`). */
  modelRef?: string
  /** Default `ask`. */
  toolMode?: ToolMode
}

export interface RegenerateChatInput {
  chatId: string
  /** The reply to regenerate (a new version of it), or a user message to answer; default: the active leaf. */
  messageId?: string
  /** Default `mock:echo`. */
  modelRef?: string
  /** Default `ask`. */
  toolMode?: ToolMode
  /** Default `auto`. */
  reasoningEffort?: ReasoningEffort
  /** Image options (docs/API.md 4.18): only for image models and chat models with image output. */
  imageOptions?: ImageOptions
}

export interface SendChatResult {
  chatId: string
  /** The client-generated id of the user message. */
  userMessageId: string
  /** Every chunk of the UI message stream (the run finished when this resolves). */
  chunks: UiStreamChunk[]
  /** The streamed assistant text. */
  text: string
}

/** A usable provider as the web sees it (`providers.hasUsableProvider`): enabled, configured, with models. */
export function isUsableProvider(provider: ProviderSummary): boolean {
  return provider.enabled && provider.status !== 'not_configured' && provider.modelCount > 0
}

export class HarnessApi {
  /** The typed client of @harness-forge/shared: `client.<module>.<action>(input)` for every route. */
  readonly client: ApiClient

  constructor(readonly context: APIRequestContext, readonly baseURL: string = baseUrlFromEnv()) {
    this.client = createApiClient({ baseUrl: apiBaseUrl(baseURL), fetch: requestFetch(context) })
  }

  /** An API bound to a new request context (for `beforeAll` / `afterAll`); `dispose()` it afterwards. */
  static async create(baseURL: string = baseUrlFromEnv()): Promise<HarnessApi> {
    return new HarnessApi(await playwrightRequest.newContext({ baseURL }), baseURL)
  }

  /** Disposes the request context (only for instances from `HarnessApi.create`). */
  async dispose(): Promise<void> {
    await this.context.dispose()
  }

  // ---------- settings ----------

  getSettings(): Promise<Settings> {
    return this.client.settings.get()
  }

  updateSettings(patch: SettingsUpdate): Promise<Settings> {
    return this.client.settings.update({ body: patch })
  }

  // ---------- providers ----------

  async listProviders(): Promise<ProviderSummary[]> {
    return (await this.client.providers.list()).items
  }

  async getProvider(id: string): Promise<ProviderSummary> {
    const provider = (await this.listProviders()).find(item => item.id === id)
    if (!provider)
      throw new Error(`Unknown provider "${id}".`)
    return provider
  }

  setProviderEnabled(id: string, enabled: boolean): Promise<ProviderSummary> {
    return this.client.providers.update({ params: { id }, body: { enabled } })
  }

  setCredentials(id: string, values: CredentialValues): Promise<ProviderSummary> {
    return this.client.credentials.set({ params: { id }, body: { values } })
  }

  clearCredentials(id: string): Promise<ProviderSummary> {
    return this.client.credentials.clear({ params: { id } })
  }

  /**
   * Disables every usable provider (see `isUsableProvider`), so the app shows the "Connect a provider" state.
   * Returns a function that re-enables exactly those providers; call it in `finally` / `afterEach`.
   */
  async disableUsableProviders(): Promise<() => Promise<void>> {
    const disabled: string[] = []
    for (const provider of await this.listProviders()) {
      if (!isUsableProvider(provider))
        continue
      await this.setProviderEnabled(provider.id, false)
      disabled.push(provider.id)
    }
    return async () => {
      for (const id of disabled)
        await this.setProviderEnabled(id, true)
    }
  }

  // ---------- chats ----------

  /** Creates an empty chat (a title set here counts as a user title; `projectId` puts it into a project, Phase 7). */
  createChat(input: { id?: string, title?: string, modelRef?: string, projectId?: string } = {}): Promise<ChatDetail> {
    const { id = createChatId(), ...rest } = input
    return this.client.chats.create({ body: { id, ...rest } })
  }

  getChat(id: string): Promise<ChatDetail> {
    return this.client.chats.get({ params: { id } })
  }

  async searchChats(q: string): Promise<ChatSummary[]> {
    return (await this.client.chats.list({ query: { q } })).items
  }

  /** Stops the run of a chat, if one is active (`POST /api/chat/:id/stop`); resolves to whether a run was stopped. */
  async stopChat(id: string): Promise<boolean> {
    try {
      return (await this.client.chat.stop({ params: { id } })).stopped
    }
    catch (error) {
      if ((error as { code?: unknown }).code === 'not_found')
        return false
      throw error
    }
  }

  /** Deletes a chat; a chat that is already gone is fine. */
  async deleteChat(id: string): Promise<void> {
    try {
      await this.client.chats.remove({ params: { id } })
    }
    catch (error) {
      if ((error as { code?: unknown }).code !== 'not_found')
        throw error
    }
  }

  /** Stops the chat's run if it still has one, then deletes the chat (a chat that is already gone is fine). */
  async removeChat(id: string): Promise<void> {
    await this.stopChat(id)
    await this.deleteChat(id)
  }

  /** Sends one user message through `POST /api/chat` and waits until its run finished. */
  async sendChat(input: SendChatInput): Promise<SendChatResult> {
    const chatId = input.chatId ?? createChatId()
    const userMessageId = createMessageId()
    const response = await this.client.chat.send({
      body: {
        chatId,
        message: { id: userMessageId, role: 'user', parts: [{ type: 'text', text: input.text }] },
        trigger: 'submit-message',
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        modelRef: input.modelRef ?? 'mock:echo',
        reasoningEffort: input.reasoningEffort ?? 'auto',
        toolMode: input.toolMode ?? 'ask',
        ...(input.imageOptions === undefined ? {} : { imageOptions: input.imageOptions }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      },
    })
    const chunks = parseUiMessageStream(await response.text())
    return { chatId, userMessageId, chunks, text: streamText(chunks) }
  }

  /**
   * Answers every pending tool approval of the chat's active leaf (the client side of `addToolApprovalResponse`, docs/API.md
   * 6.2): the leaf assistant message goes back with its `approval-requested` parts marked `approval-responded`, as an
   * approval continuation, and this resolves when the continued run finished (`userMessageId` = the answered message).
   */
  async answerApprovals(input: AnswerApprovalsInput): Promise<SendChatResult> {
    const { chatId, approved } = input
    const leaf = (await this.getChat(chatId)).messages.at(-1)
    if (!leaf || leaf.role !== 'assistant')
      throw new Error(`Chat ${chatId} does not end with an assistant message.`)
    let pending = 0
    const parts = leaf.parts.map((part) => {
      const value = part as unknown as Record<string, unknown>
      if (value.state !== 'approval-requested')
        return part
      pending += 1
      return { ...value, state: 'approval-responded', approval: { ...(value.approval as object), approved } } as unknown as typeof part
    })
    if (pending === 0)
      throw new Error(`Chat ${chatId} has no pending approval.`)
    const message: HarnessUIMessage = { ...leaf, parts }
    const response = await this.client.chat.send({
      body: {
        chatId,
        message,
        trigger: 'submit-message',
        modelRef: input.modelRef ?? 'mock:echo',
        reasoningEffort: 'auto',
        toolMode: input.toolMode ?? 'ask',
      },
    })
    const chunks = parseUiMessageStream(await response.text())
    return { chatId, userMessageId: leaf.id, chunks, text: streamText(chunks) }
  }

  /**
   * Regenerates a reply through `POST /api/chat` (`regenerate-message`: a new version of the reply under the same user
   * message) and waits until its run finished. `userMessageId` of the result is the answered user message.
   */
  async regenerateChat(input: RegenerateChatInput): Promise<SendChatResult> {
    const { chatId, messageId } = input
    // The request carries the last UI message of the shown path (the answered user message); the server reads only
    // `messageId` (default: the active leaf).
    const path = (await this.getChat(chatId)).messages
    const target = messageId === undefined ? path.length - 1 : path.findIndex(message => message.id === messageId)
    const answered = path.slice(0, target + 1).findLast(message => message.role === 'user')
    if (target < 0 || !answered)
      throw new Error(`Chat ${chatId} has no user message to answer${messageId ? ` for ${messageId}` : ''} on its active path.`)
    const response = await this.client.chat.send({
      body: {
        chatId,
        message: answered,
        trigger: 'regenerate-message',
        ...(messageId === undefined ? {} : { messageId }),
        modelRef: input.modelRef ?? 'mock:echo',
        reasoningEffort: input.reasoningEffort ?? 'auto',
        toolMode: input.toolMode ?? 'ask',
        ...(input.imageOptions === undefined ? {} : { imageOptions: input.imageOptions }),
      },
    })
    const chunks = parseUiMessageStream(await response.text())
    return { chatId, userMessageId: answered.id, chunks, text: streamText(chunks) }
  }

  /** Waits until the chat has a title (auto titles arrive shortly after the first reply) and returns it. */
  async waitForChatTitle(id: string, timeout = 15_000): Promise<string> {
    await expect.poll(async () => (await this.getChat(id)).title, { timeout, message: `chat ${id} has a title` }).not.toBeNull()
    return (await this.getChat(id)).title ?? ''
  }
}
