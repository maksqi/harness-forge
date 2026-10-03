// Denying tool approvals that can no longer be answered (C16-T6, frozen after Gate P7-0b). Used by the chat import
// (`./import.ts`, reason `imported`) and the master-key rotation (W7.7, reason "Expired after a key rotation.": the
// approval tokens are signed with the old `approval` subkey, so an open approval cannot be answered after a rotation).
import type { HarnessUIMessagePart } from '@harness-forge/shared'

/** Result of `denyOpenApprovals`. */
export interface DeniedApprovals<T extends HarnessUIMessagePart = HarnessUIMessagePart> {
  /** The parts with every open approval denied; the input array itself when nothing was open. */
  parts: T[]
  /** How many parts were denied. */
  denied: number
}

function isToolPart(type: string): boolean {
  return type.startsWith('tool-') || type === 'dynamic-tool'
}

/** True for a tool part waiting for an approval or for its approved / denied response to be processed. */
export function isOpenApproval(part: HarnessUIMessagePart): boolean {
  const state = (part as unknown as { state?: unknown }).state
  return isToolPart(part.type) && (state === 'approval-requested' || state === 'approval-responded')
}

/**
 * Denies every open approval of a message: a tool part in `approval-requested` (no answer yet) or `approval-responded`
 * (answered, but the answer was not processed: the tool never ran) becomes `output-denied` with `approval.approved =
 * false` and `approval.reason = reason`; a response that already denied the call with its own reason keeps that reason.
 * Every other part (text, finished calls with an output, an error or a processed denial) is returned unchanged (the
 * same object). The input is never mutated.
 */
export function denyOpenApprovals<T extends HarnessUIMessagePart>(parts: T[], reason: string): DeniedApprovals<T> {
  let denied = 0
  const next = parts.map((part) => {
    if (!isOpenApproval(part))
      return part
    denied += 1
    const loose = part as unknown as Record<string, unknown>
    const approval = (typeof loose.approval === 'object' && loose.approval !== null ? loose.approval : {}) as Record<string, unknown>
    const keepReason = loose.state === 'approval-responded' && approval.approved === false && typeof approval.reason === 'string'
    return {
      ...loose,
      state: 'output-denied',
      approval: { ...approval, approved: false, reason: keepReason ? approval.reason : reason },
    } as unknown as T
  })
  return { parts: denied === 0 ? parts : next, denied }
}
