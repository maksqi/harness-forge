// Compaction in the transcript (docs/UI.md 7.24, 11.6; ADR-040): pure helpers over `compactionMarkers` of
// `@harness-forge/shared` (`util/agent-state.ts`, the only implementation of the marker rules). No Vue, no stores.
// C25 ships the final signatures in P9-0b (frozen from Gate P9-0b); W9.11 implements the layout in P9-A.
// - `compactionLayout(messages)`: the ids of the messages before the latest marker's message (minus the kept user
//   message of a `keep: 'last-user'` marker), dimmed by ChatTranscript (`ChatMessage.compacted`). Inert in P9-0b: dims
//   nothing.
// - `compactionLabel(data, variant)`: the divider label.
// - `compactionVariant(message, partIndex)`: 'history' when no rendered block precedes the marker in its message.
import type { CompactionData, HarnessUIMessage } from '@harness-forge/shared'
import { messageBlocks } from '../chat-format'

/** Where a divider sits: the first rendered block of its message (`history`) or after other blocks (`run`). */
export type CompactionVariant = 'history' | 'run'

/** The transcript layout of the compaction markers of a path. */
export interface CompactionLayout {
  /** Ids of the messages the latest marker replaced for the model (shown dimmed, `data-compacted`). */
  dimmed: ReadonlySet<string>
}

const NOTHING_DIMMED: ReadonlySet<string> = new Set()

/**
 * The messages to dim on the shown path (docs/UI.md 7.24): those before the message holding the latest marker, minus
 * the kept user message (`keep: 'last-user'`). P9-0b stub: nothing is dimmed (W9.11 implements it over
 * `compactionMarkers`, with a `WeakMap` cache of finished messages).
 */
export function compactionLayout(_messages: readonly HarnessUIMessage[]): CompactionLayout {
  return { dimmed: NOTHING_DIMMED }
}

/**
 * The divider label: "Conversation compacted" (`/compact`), "Conversation compacted automatically" (automatic, first
 * block of its reply) or "Context compacted during this response" (automatic, after other blocks of its reply).
 */
export function compactionLabel(data: CompactionData, variant: CompactionVariant): string {
  if (data.trigger === 'manual')
    return 'Conversation compacted'
  return variant === 'history' ? 'Conversation compacted automatically' : 'Context compacted during this response'
}

/** 'history' when no rendered block (`messageBlocks`) precedes the part at `partIndex` in its message, else 'run'. */
export function compactionVariant(message: HarnessUIMessage, partIndex: number): CompactionVariant {
  return messageBlocks(message.parts).some(block => block.index < partIndex) ? 'run' : 'history'
}
