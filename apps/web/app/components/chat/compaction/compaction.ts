// Compaction in the transcript (docs/UI.md 7.24, 11.6; ADR-040): pure helpers over `compactionMarkers` and
// `compactionCutoff` of `@harness-forge/shared` (`util/agent-state.ts`, the only implementation of the marker rules).
// No Vue, no stores. C25 shipped the signatures in P9-0b (frozen from Gate P9-0b); W9.11 implements them in P9-A.
// - `compactionLayout(messages)`: the ids of the messages before the latest marker's message (minus the kept user
//   message of a `keep: 'last-user'` marker), dimmed by ChatTranscript (`ChatMessage.compacted`). The markers of
//   finished messages are cached per message object (like the transcript's `rewindable`).
// - `messageCompaction(message)`: the markers of one message for ChatMessage (the variant of each divider and the part
//   index of the last marker: the blocks before it are dimmed when the row itself is not).
// - `compactionLabel(data, variant)`: the divider label; `compactionMeta(data)`: its meta line.
// - `compactionVariant(message, partIndex)`: 'history' unless the marker comes after content of its own message.
import type { CompactionData, CompactionMarker, HarnessUIMessage } from '@harness-forge/shared'
import { compactionCutoff, compactionMarkers } from '@harness-forge/shared'

/** Where a divider sits: the first rendered block of its message (`history`) or after other blocks (`run`). */
export type CompactionVariant = 'history' | 'run'

/** The transcript layout of the compaction markers of a path. */
export interface CompactionLayout {
  /** Ids of the messages the latest marker replaced for the model (shown dimmed, `data-compacted`). */
  dimmed: ReadonlySet<string>
}

/** The compaction markers of one message, as ChatMessage renders them. */
export interface MessageCompaction {
  /** The divider variant of each valid marker, by part index. */
  variants: ReadonlyMap<number, CompactionVariant>
  /** The part index of the message's last valid marker (blocks before it are compacted); null without one. */
  lastIndex: number | null
}

const NOTHING_DIMMED: ReadonlySet<string> = new Set()
const NO_MARKERS: readonly CompactionMarker[] = []
const NO_COMPACTION: MessageCompaction = { variants: new Map(), lastIndex: null }

/** The markers of finished messages (their parts no longer change). */
const markerCache = new WeakMap<HarnessUIMessage, readonly CompactionMarker[]>()

/** The valid markers of one message (`compactionMarkers` over a path of just that message). */
function markersOf(message: HarnessUIMessage, cache: boolean): readonly CompactionMarker[] {
  if (message.role !== 'assistant')
    return NO_MARKERS
  if (!cache)
    return compactionMarkers([message])
  let known = markerCache.get(message)
  if (known === undefined) {
    known = compactionMarkers([message])
    markerCache.set(message, known)
  }
  return known
}

/**
 * The messages to dim on the shown path (docs/UI.md 7.24): those before the message holding the latest marker, minus
 * the kept user message (`keep: 'last-user'`, from `compactionCutoff`: the model still sees it). A path without a
 * marker (a branch above it, a regenerated or deleted marker message) dims nothing. One backwards pass to the latest
 * marker; the last message is never cached (it may still change in place while it streams).
 */
export function compactionLayout(messages: readonly HarnessUIMessage[]): CompactionLayout {
  let latest = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (markersOf(messages[index]!, index < messages.length - 1).length > 0) {
      latest = index
      break
    }
  }
  if (latest <= 0)
    return { dimmed: NOTHING_DIMMED }
  // The slice ends at the marker's message, so the cutoff is found at once (its kept user message precedes it).
  const cutoff = compactionCutoff(messages.slice(0, latest + 1))
  const kept = cutoff !== null && cutoff.messageIndex < latest ? cutoff.messageIndex : -1
  const dimmed = new Set<string>()
  for (let index = 0; index < latest; index++) {
    if (index !== kept)
      dimmed.add(messages[index]!.id)
  }
  return { dimmed }
}

function variantOf(marker: CompactionMarker): CompactionVariant {
  return marker.data.trigger === 'auto' && marker.inline ? 'run' : 'history'
}

/**
 * The markers of one assistant message: each divider's variant and the index of the last marker. A manual marker is
 * always `history`; an automatic one is `run` when content parts of its message precede it (`CompactionMarker.inline`:
 * compacted during the reply), else `history` (before the reply's first step).
 */
export function messageCompaction(message: HarnessUIMessage): MessageCompaction {
  const markers = markersOf(message, false)
  if (markers.length === 0)
    return NO_COMPACTION
  return {
    variants: new Map(markers.map(marker => [marker.partIndex, variantOf(marker)])),
    lastIndex: markers.at(-1)!.partIndex,
  }
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

const COMPACT_TOKENS = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** The divider's meta line: "42 messages summarized · 182K → 9K tokens" (sizes in the "14.3K" style). */
export function compactionMeta(data: Pick<CompactionData, 'messagesCompacted' | 'tokensBefore' | 'tokensAfter'>): string {
  const count = `${data.messagesCompacted} ${data.messagesCompacted === 1 ? 'message' : 'messages'} summarized`
  return `${count} · ${COMPACT_TOKENS.format(data.tokensBefore)} → ${COMPACT_TOKENS.format(data.tokensAfter)} tokens`
}

/** The variant of the marker at `partIndex` of `message` (`messageCompaction`); 'history' when it is not a marker. */
export function compactionVariant(message: HarnessUIMessage, partIndex: number): CompactionVariant {
  return messageCompaction(message).variants.get(partIndex) ?? 'history'
}
