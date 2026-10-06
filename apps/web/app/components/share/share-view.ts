// Pure helpers of the public share page (docs/UI.md 7.15, ADR-025): the snapshot parts turned into the shapes the
// reused chat components read (TextPart, ReasoningPart, FilePart, ImageGallery, SourcesPart, UserMessageBubble),
// consecutive sources merged into one row, consecutive images of an assistant message into one gallery (Phase 6,
// 7.16), the model id and the page's error text. No Vue, no stores.
// Phase 9 (ADR-040, ADR-042; no `sharePartSchema` change): the server's sanitizer splits a reply at each steer into
// user share messages (they render as ordinary user bubbles, `toUserMessage`) and drops compaction markers and activity
// parts (summaries are never shared: no divider and no dimming here); the agent tools (`task`, `todo_write`,
// `exit_plan_mode`) are tool parts like any other and render through ShareToolRow.
// Phase 11 (ADR-048, ADR-052; no `sharePartSchema` change): the allowlist drops `data-hook` parts and a hook carrier
// holding only them, so a call a hook denied reads "Denied" like any denial; a skill the user ran keeps its name
// (`command.name`) and shows the command badge (a snapshot does not say it was a skill).
import type { HarnessError, HarnessUIMessage, MessageMetadata, ShareMessage, SharePart } from '@harness-forge/shared'
import type { FileUIPart, ReasoningUIPart, TextUIPart } from 'ai'
import type { SourcePart } from '~/components/chat/chat-format'
import { safeParseModelRef, SHARE_TOKEN_PATTERN } from '@harness-forge/shared'

export type ShareToolPart = Extract<SharePart, { type: 'tool' }>
type ShareFilePart = Extract<SharePart, { type: 'file' }>
type ShareSourcePart = Extract<SharePart, { type: 'source-url' | 'source-document' }>

/** One rendered block of a shared assistant message, in part order. */
export type ShareBlock
  = | { kind: 'text', key: string, part: TextUIPart }
    | { kind: 'reasoning', key: string, part: ReasoningUIPart }
    | { kind: 'tool', key: string, part: ShareToolPart }
    | { kind: 'file', key: string, part: FileUIPart }
    | { kind: 'gallery', key: string, parts: FileUIPart[] }
    | { kind: 'sources', key: string, parts: SourcePart[] }

/** A token in the documented format; anything else is unavailable without asking the server (it answers 404). */
export function isShareToken(token: string): boolean {
  return SHARE_TOKEN_PATTERN.test(token)
}

export function toFilePart(part: ShareFilePart): FileUIPart {
  return { type: 'file', mediaType: part.mediaType, url: part.url, ...(part.filename ? { filename: part.filename } : {}) }
}

function toSourcePart(part: ShareSourcePart): SourcePart {
  if (part.type === 'source-url')
    return { type: 'source-url', sourceId: part.sourceId, url: part.url, ...(part.title ? { title: part.title } : {}) }
  return {
    type: 'source-document',
    sourceId: part.sourceId,
    title: part.title,
    mediaType: part.mediaType,
    ...(part.filename ? { filename: part.filename } : {}),
  }
}

/** An image file part: generated images of an assistant message render as a gallery (docs/UI.md 7.16). */
export function isImageFilePart(part: Pick<ShareFilePart, 'mediaType'>): boolean {
  return part.mediaType.toLowerCase().startsWith('image/')
}

/**
 * Renderable blocks of an assistant message: parts in order, consecutive sources merged into one row, consecutive
 * image files into one gallery (other files stay chips).
 */
export function shareMessageBlocks(parts: readonly SharePart[]): ShareBlock[] {
  const blocks: ShareBlock[] = []
  parts.forEach((part, index) => {
    switch (part.type) {
      case 'text':
        blocks.push({ kind: 'text', key: `text-${index}`, part: { type: 'text', text: part.text, state: 'done' } })
        break
      case 'reasoning':
        blocks.push({ kind: 'reasoning', key: `reasoning-${index}`, part: { type: 'reasoning', text: part.text, state: 'done' } })
        break
      case 'tool':
        blocks.push({ kind: 'tool', key: `tool-${index}`, part })
        break
      case 'file': {
        const previous = blocks.at(-1)
        if (!isImageFilePart(part))
          blocks.push({ kind: 'file', key: `file-${index}`, part: toFilePart(part) })
        else if (previous?.kind === 'gallery')
          previous.parts.push(toFilePart(part))
        else
          blocks.push({ kind: 'gallery', key: `gallery-${index}`, parts: [toFilePart(part)] })
        break
      }
      case 'source-url':
      case 'source-document': {
        const previous = blocks.at(-1)
        if (previous?.kind === 'sources')
          previous.parts.push(toSourcePart(part))
        else
          blocks.push({ kind: 'sources', key: `sources-${index}`, parts: [toSourcePart(part)] })
        break
      }
    }
  })
  return blocks
}

/**
 * A shared user message in the shape UserMessageBubble reads: text and file parts plus `metadata.command.name`. A
 * snapshot keeps no other metadata (no model, times or command expansion), so only that field is filled.
 */
export function toUserMessage(message: ShareMessage, id: string): HarnessUIMessage {
  const parts: HarnessUIMessage['parts'] = []
  for (const part of message.parts) {
    if (part.type === 'text')
      parts.push({ type: 'text', text: part.text, state: 'done' })
    else if (part.type === 'file')
      parts.push(toFilePart(part))
  }
  const user: HarnessUIMessage = { id, role: 'user', parts }
  if (message.command)
    user.metadata = { command: { name: message.command.name } } as unknown as MessageMetadata
  return user
}

/** The model id of a model ref ("claude-sonnet-5" of "anthropic:claude-sonnet-5"); the ref itself when malformed. */
export function modelIdOf(modelRef: string): string {
  return safeParseModelRef(modelRef)?.modelId ?? modelRef
}

/** "Too many requests. Try again in 12s." for a rate limit, else the server message. */
export function sharePageErrorMessage(error: HarnessError): string {
  if (error.code === 'rate_limited') {
    const seconds = Math.max(1, Math.ceil((error.retryAfterMs ?? 1000) / 1000))
    return `Too many requests. Try again in ${seconds}s.`
  }
  return error.message
}
