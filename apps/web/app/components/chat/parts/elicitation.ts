// Pure rules of MCP questions in the transcript (Phase 14, ADR-060; docs/UI.md 7.35, 11.10): the pending request of a
// running MCP tool part (its latest preliminary output `{ status: 'input-required', elicitation }`), the records the final
// output keeps (never the values), the result lines and the countdown. Untrusted text stays plain text.
// Signatures from C54 (P14-0b, frozen from Gate P14-0b). `pendingElicitationOf` is complete (useChatSession derives the
// session's pending requests from it); W14.9 owns the module (it may add helpers) and the card's texts.
import type { McpElicitation, McpElicitationRecord } from '@harness-forge/shared'
import type { ToolPartLike } from '../chat-format'
import { mcpElicitationRecordSchema, mcpToolProgressSchema } from '@harness-forge/shared'
import { splitMcpToolName, toolNameOf } from '../chat-format'

/** The caution line of the card (`{server}` = the server's name). */
export const ELICITATION_CAUTION = 'Share only what you would give {server}. Never enter passwords here.'

/** "7:42 left" (whole seconds, never negative). */
export function countdownText(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil((Number.isFinite(msLeft) ? msLeft : 0) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`
}

/** The one-line result of an answered or ended request (docs/UI.md 7.35, 15). */
export function elicitationResultText(record: Pick<McpElicitationRecord, 'action' | 'reason'>, server: string): string {
  switch (record.reason) {
    case 'timeout':
      return `${server}'s request expired.`
    case 'stopped':
      return 'Stopped before you answered.'
    case 'not-interactive':
      return 'Declined automatically: sub-agents can\'t ask you.'
    case 'ambiguous':
      return `Declined automatically: more than one chat was using ${server}.`
    case 'unsupported':
      return 'Declined automatically: harness-forge can\'t show this form.'
  }
  if (record.action === 'accept')
    return `You answered ${server}'s request.`
  return record.action === 'decline' ? `You declined ${server}'s request.` : `You dismissed ${server}'s request.`
}

/** The `data-action` of a result line: the action, or `timeout` for an expired request. */
export function elicitationResultAction(record: McpElicitationRecord): 'accept' | 'decline' | 'cancel' | 'timeout' {
  return record.reason === 'timeout' ? 'timeout' : record.action
}

/** The records of a final MCP tool output (`output.elicitations`); invalid entries are dropped. */
export function elicitationRecordsOf(output: unknown): McpElicitationRecord[] {
  if (typeof output !== 'object' || output === null || !Array.isArray((output as { elicitations?: unknown }).elicitations))
    return []
  const records: McpElicitationRecord[] = []
  for (const entry of (output as { elicitations: unknown[] }).elicitations) {
    const parsed = mcpElicitationRecordSchema.safeParse(entry)
    if (parsed.success)
      records.push(parsed.data)
  }
  return records
}

/**
 * The pending request of an MCP tool part (`mcp__<server>__<tool>`): its latest preliminary output (`output-available`
 * with `preliminary: true`) is `{ status: 'input-required', elicitation }`; null otherwise (a final output, `running`, any
 * other tool, an output that does not parse).
 */
export function pendingElicitationOf(part: ToolPartLike): McpElicitation | null {
  if (part.state !== 'output-available' || part.preliminary !== true || splitMcpToolName(toolNameOf(part)) === null)
    return null
  const parsed = mcpToolProgressSchema.safeParse(part.output)
  return parsed.success && parsed.data.status === 'input-required' ? parsed.data.elicitation : null
}
