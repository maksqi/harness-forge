// MCP questions of the chat's running tool calls (Phase 14, ADR-060; docs/UI.md 7.35, 11.10). The transcript rows are
// `v-memo`ed, so the pending request of a call reaches `ToolPart` through this injection instead of a prop: `forCall`
// gives the request a running MCP call waits on (the session's `elicitations`, mapped to their calls), `respond` answers
// it through `useChatSession().respondElicitation` and keeps the card's posting state (`busy`), the field issues of a
// `400` answer (`issues`, from `details.issues`) and the requests that were no longer open (`gone`: answered in another
// tab, expired, or the run ended). There is no `unlinked()`: requests the server cannot tie to a call are declined there.
// ChatView provides it from its session (`createToolElicitationContext`), like TOOL_APPROVAL_CONTEXT; share pages provide
// none. C54, complete and frozen from Gate P14-0b.
import type { ElicitationFieldIssue, HarnessUIMessage, McpElicitation, McpElicitationAnswerBody } from '@harness-forge/shared'
import type { InjectionKey, Ref } from 'vue'
import { isToolUIPart } from 'ai'
import { shallowRef } from 'vue'
import { toHarnessError } from '~/utils/errors'
import { pendingElicitationOf } from './elicitation'

export interface ToolElicitationContext {
  /** The pending request of that tool call, else null. */
  forCall: (toolCallId: string) => McpElicitation | null
  /** An answer to the request is being posted. */
  busy: (elicitationId: string) => boolean
  /** The field issues of the request's last `400` answer. */
  issues: (elicitationId: string) => readonly ElicitationFieldIssue[]
  /** The request was no longer open when answered (`'gone'`). */
  gone: (elicitationId: string) => boolean
  /** Answers the request (`'answered'`, or `'gone'`); a `400` records its issues and throws the `HarnessError`. */
  respond: (elicitationId: string, answer: McpElicitationAnswerBody) => Promise<'answered' | 'gone'>
}

export const TOOL_ELICITATIONS: InjectionKey<ToolElicitationContext> = Symbol('hf-tool-elicitations')

/** A pending request and the tool call that waits on it. */
export interface PendingElicitation {
  toolCallId: string
  elicitation: McpElicitation
}

/**
 * The pending requests of a message: its MCP tool parts whose latest preliminary output is `input-required`
 * (`pendingElicitationOf`), the oldest request first (by `expiresAt`, then in part order).
 */
export function pendingElicitationsOf(message: Pick<HarnessUIMessage, 'role' | 'parts'> | undefined): PendingElicitation[] {
  if (!message || message.role !== 'assistant')
    return []
  const pending: PendingElicitation[] = []
  for (const part of message.parts) {
    if (!isToolUIPart(part))
      continue
    const elicitation = pendingElicitationOf(part)
    if (elicitation)
      pending.push({ toolCallId: part.toolCallId, elicitation })
  }
  return pending.sort((a, b) => a.elicitation.expiresAt - b.elicitation.expiresAt)
}

/** What the context needs of a chat session (`useChatSession`). */
export interface ToolElicitationSource {
  chat: { messages: Ref<HarnessUIMessage[]> }
  /** The session's pending requests (answered ones excluded). */
  elicitations: Readonly<Ref<readonly McpElicitation[]>>
  respondElicitation: (id: string, answer: McpElicitationAnswerBody) => Promise<'answered' | 'gone'>
}

function issuesOf(error: unknown): ElicitationFieldIssue[] | null {
  const failure = toHarnessError(error)
  if (failure.code !== 'validation_error')
    return null
  const issues = (failure.details as { issues?: unknown } | undefined)?.issues
  return Array.isArray(issues) ? issues as ElicitationFieldIssue[] : []
}

function withKey<T>(record: Readonly<Record<string, T>>, key: string, value: T | undefined): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return value === undefined ? rest : { ...rest, [key]: value }
}

/** The TOOL_ELICITATIONS context of a session (ChatView provides it). */
export function createToolElicitationContext(source: ToolElicitationSource): ToolElicitationContext {
  const posting = shallowRef<Readonly<Record<string, true>>>({})
  const fieldIssues = shallowRef<Readonly<Record<string, readonly ElicitationFieldIssue[]>>>({})
  const goneIds = shallowRef<Readonly<Record<string, true>>>({})

  function forCall(toolCallId: string): McpElicitation | null {
    const open = source.elicitations.value
    if (open.length === 0)
      return null
    const entry = pendingElicitationsOf(source.chat.messages.value.at(-1)).find(item => item.toolCallId === toolCallId)
    return entry && open.some(item => item.id === entry.elicitation.id) ? entry.elicitation : null
  }

  async function respond(elicitationId: string, answer: McpElicitationAnswerBody): Promise<'answered' | 'gone'> {
    posting.value = withKey(posting.value, elicitationId, true)
    try {
      const result = await source.respondElicitation(elicitationId, answer)
      fieldIssues.value = withKey(fieldIssues.value, elicitationId, undefined)
      if (result === 'gone')
        goneIds.value = withKey(goneIds.value, elicitationId, true)
      return result
    }
    catch (error) {
      const issues = issuesOf(error)
      if (issues)
        fieldIssues.value = withKey(fieldIssues.value, elicitationId, issues)
      throw toHarnessError(error)
    }
    finally {
      posting.value = withKey(posting.value, elicitationId, undefined)
    }
  }

  return {
    forCall,
    busy: elicitationId => posting.value[elicitationId] === true,
    issues: elicitationId => fieldIssues.value[elicitationId] ?? [],
    gone: elicitationId => goneIds.value[elicitationId] === true,
    respond,
  }
}
