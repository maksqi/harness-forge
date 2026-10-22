import type { ElicitationRequest, ElicitResult } from '@ai-sdk/mcp'
// Frozen interface of MCP elicitation (Phase 14, ADR-060; API.md 4.37 / 5.38, ARCHITECTURE.md 6.40): the first live wait
// of a run. An MCP server asks the user for structured input in the middle of a tool call (`elicitation/create`); the
// broker attributes the request to one MCP tool call in flight, the call's generator shows the form card as its
// preliminary output (`McpToolProgress`), and the user's answer (`POST /chat/:id/elicitations/:elicitationId`) resolves
// the request. Implementation: `createElicitationBroker(deps, options?)` in `mcp/elicitation/broker.ts` (C50 stub: no
// request is ever attributed, every request is declined `not-interactive`; W14.3 implements the broker). Consumers: the
// MCP managers (`mcp/index.ts`, `mcp/project.ts`: `handler(runtimeKey)` registered with `onElicitationRequest`), the MCP
// tool generator (`mcp/mcp-tools.ts`: `begin` / `end` around `callTool`), the `chatElicitations` route, the chats routes
// (`awaitingInput` = `pendingCount(id) > 0`) and shutdown (`stopDeps`: `stop()` right after the import plans, before the
// runs). Test double: `createFakeElicitationBroker` (`testing/fake-elicitations.ts`), installed with
// `createTestApp({ elicitations: 'fake' })`.
//
// Rules: attribution per MCP client — every call in flight from one chat and from its main agent → the oldest call gets
// the request; calls of several chats → `decline` `ambiguous`; a sub-agent or background call in flight, or no call →
// `decline` `not-interactive`; a schema outside the supported subset (`parseElicitationForm`) or URL mode → `decline`
// `unsupported`. Every wait is bounded (`LIMITS.mcpElicitationWaitMs`, 480 s → `cancel` `timeout`; the test-only
// `HF_TEST_ELICITATION_WAIT_MS` through `options.waitMs`) and cancelled (`cancel` `stopped`) by the call's signal (Stop),
// chat deletion, key rotation and shutdown. The values the user enters go only to the MCP server: never stored, logged
// or put into an error; the records keep the message, the field names, the action and the reason. State is memory only
// (ids `eli_…`), keyed by chat and runtime, bounded; timers `unref()`-ed and cleared in `stop()`.
import type { McpElicitation, McpElicitationAnswerBody, McpElicitationAnswerResult, McpElicitationRecord } from '@harness-forge/shared'

/** One MCP tool call in flight (`ElicitationBroker.begin`). */
export interface ElicitationCall {
  /**
   * The MCP client the call runs on (the key `handler(runtimeKey)` was registered with): a global server's runtime, or a
   * project server's (project id + server id + generation, as the project manager builds it).
   */
  readonly runtimeKey: string
  /** `ToolCallContext.chatId`. */
  readonly chatId: string
  /** `ToolCallContext.toolCallId`. */
  readonly toolCallId: string
  readonly serverId: string
  /** The server's display name (the card: "Share only what you would give {server}."). */
  readonly serverName: string
  /**
   * True when the call runs in the chat's main agent (`agentScopeOf(c) !== null`); false for sub-agents and background
   * tasks, which never elicit (a request is declined `not-interactive`).
   */
  readonly interactive: boolean
  /** The tool call's signal: an abort (Stop, the tool timeout) cancels a pending request (`cancel`, `stopped`). */
  readonly signal: AbortSignal
}

/**
 * The broker's view of one call in flight, for the MCP tool generator: it yields `{ status: 'input-required',
 * elicitation: pending() }` while a request waits (again every 25 s as a keep-alive) and `{ status: 'running' }` after it
 * settled; its active budget pauses while `waiting()` is true. Read-only except `end()`.
 */
export interface ElicitationCallHandle {
  /** The request waiting for the user on this call, or null. */
  readonly pending: () => McpElicitation | null
  /** True while a request of this call waits for the user (the call's active budget is paused then). */
  readonly waiting: () => boolean
  /**
   * Calls `listener` after every change of this call (a request attributed to it, a request settled); returns the
   * unsubscribe function. Listeners never receive a value the user entered.
   */
  readonly onChange: (listener: () => void) => () => void
  /** The settled requests of this call, oldest first (the final tool output's `elicitations`; never a value). */
  readonly records: () => McpElicitationRecord[]
  /**
   * Removes the call from the client's registry (the generator's `finally`); a request still pending is cancelled
   * (`cancel`, `stopped`). Idempotent.
   */
  readonly end: () => void
}

/** The `onElicitationRequest` handler of one MCP client (`client.onElicitationRequest(ElicitationRequestSchema, …)`). */
export type ElicitationHandler = (request: ElicitationRequest) => Promise<ElicitResult>

/** Options of `createElicitationBroker`. */
export interface ElicitationBrokerOptions {
  /**
   * How long one request waits for the user before `cancel` `timeout` (default `LIMITS.mcpElicitationWaitMs`, 480 s;
   * `deps.ts` passes the test-only `HF_TEST_ELICITATION_WAIT_MS` when it is honored; unit tests pass small values with
   * fake timers).
   */
  readonly waitMs?: number
}

/**
 * `deps.elicitations`. Errors are `HarnessError`s the routes pass through (API.md 2 / 5.38). Lazy: no boot step;
 * `stop()` is a shutdown step before the runs, so every wait answers and the runs can finish.
 */
export interface ElicitationBroker {
  /** Registers an MCP tool call in flight on its client (before `callTool`); the handle's `end()` removes it. */
  readonly begin: (call: ElicitationCall) => ElicitationCallHandle
  /**
   * The elicitation handler of one MCP client: attributes the request (see the rules above), waits for the answer, the
   * timeout or a cancellation, and answers the MCP server `{ action, content? }` (`content` only with `accept`). Never
   * rejects for a user-side reason (a refusal is an answer).
   */
  readonly handler: (runtimeKey: string) => ElicitationHandler
  /**
   * `POST /chat/:id/elicitations/:elicitationId` (body validated by the route with `mcpElicitationAnswerBodySchema`):
   * validates `content` against the request's form (`validateElicitationAnswer`) and resolves the request. Answers `{
   * action }`. Throws `not_found` (an unknown id, or another chat's), `conflict` `stale` (already answered, expired, its
   * run ended) and `validation_error` with the field issues.
   */
  readonly answer: (chatId: string, elicitationId: string, body: McpElicitationAnswerBody) => Promise<McpElicitationAnswerResult>
  /** How many requests of the chat wait for the user (`ChatSummary.awaitingInput` = `pendingCount(chatId) > 0`). */
  readonly pendingCount: (chatId: string) => number
  /** Cancels every pending request of the chat (`cancel`, `stopped`): chat deletion, key rotation. Never throws. */
  readonly cancelChat: (chatId: string) => void
  /**
   * Shutdown (right after the import plans, before the runs): cancels every pending request (`cancel`, `stopped`), clears
   * the registries and timers. Idempotent; never rejects.
   */
  readonly stop: () => Promise<void>
}
