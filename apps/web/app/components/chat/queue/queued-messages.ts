// Pure helpers of the queued messages (docs/UI.md 7.7, 7.26; ADR-042): what a row shows, and what goes back into the
// composer when queued messages return to it (`restoreQueued`, after a Stop or an Edit): the texts appended to the draft
// with blank lines between them, and the uploaded files as done chips.
import type { FileRef, QueueItem } from '@harness-forge/shared'
import { FILE_ID_PATTERN } from '@harness-forge/shared'

/** The text of a queued message (its text parts, in order). */
export function queueItemText(item: QueueItem): string {
  return item.message.parts
    .flatMap(part => (part.type === 'text' ? [part.text] : []))
    .join('\n')
}

/** The id of an uploaded file from its part URL (`/api/files/<id>`), or null. */
function fileIdOf(url: string): string | null {
  const id = url.split(/[?#]/)[0]!.split('/').pop() ?? ''
  return FILE_ID_PATTERN.test(id) ? id : null
}

/** The uploaded files of a queued message (the size is not part of a message: 0). */
export function queueItemFiles(item: QueueItem): FileRef[] {
  return item.message.parts.flatMap((part) => {
    if (part.type !== 'file')
      return []
    const id = fileIdOf(part.url)
    return id ? [{ id, name: part.filename ?? id, mime: part.mediaType, size: 0, url: part.url }] : []
  })
}

/** The number of files of a queued message. */
export function queueItemFileCount(item: QueueItem): number {
  return item.message.parts.filter(part => part.type === 'file').length
}

/** What a row shows: the first non-blank line of the text, else the file names. */
export function queueItemPreview(item: QueueItem): string {
  const line = queueItemText(item).split(/\r?\n/).map(value => value.trim()).find(value => value !== '')
  if (line)
    return line
  return item.message.parts.flatMap(part => (part.type === 'file' ? [part.filename ?? 'File'] : [])).join(', ')
}

/** The draft after putting `items` back: the current text, then each message's text, separated by blank lines. */
export function restoredDraft(current: string, items: readonly QueueItem[]): string {
  const texts = items.map(item => queueItemText(item).trim()).filter(text => text !== '')
  const head = current.replace(/\s+$/, '')
  return [...(head.trim() ? [head] : []), ...texts].join('\n\n')
}
