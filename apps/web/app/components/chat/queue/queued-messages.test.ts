import { describe, expect, it } from 'vitest'
import { messageId, queueItem } from '~/utils/testing/fixtures'
import { queueItemFileCount, queueItemFiles, queueItemPreview, queueItemText, restoredDraft } from './queued-messages'

const id = messageId('files1')
const withFiles = queueItem({
  id,
  message: {
    id,
    role: 'user',
    parts: [
      { type: 'text', text: 'First line\nSecond line' },
      { type: 'file', mediaType: 'text/markdown', filename: 'notes.md', url: '/api/files/file_notes00000000000' },
      { type: 'file', mediaType: 'image/png', url: '/api/files/file_shot000000000000' },
      { type: 'file', mediaType: 'image/png', filename: 'odd.png', url: 'https://example.com/odd.png' },
    ],
  },
})

describe('queued message helpers', () => {
  it('reads the text, the files and the preview of a queued message', () => {
    expect(queueItemText(withFiles)).toBe('First line\nSecond line')
    expect(queueItemPreview(withFiles)).toBe('First line')
    expect(queueItemFileCount(withFiles)).toBe(3)
    expect(queueItemFiles(withFiles)).toEqual([
      { id: 'file_notes00000000000', name: 'notes.md', mime: 'text/markdown', size: 0, url: '/api/files/file_notes00000000000' },
      { id: 'file_shot000000000000', name: 'file_shot000000000000', mime: 'image/png', size: 0, url: '/api/files/file_shot000000000000' },
    ])
  })

  it('previews a message without text by its file names', () => {
    const only = queueItem({
      id,
      message: { id, role: 'user', parts: [{ type: 'file', mediaType: 'image/png', filename: 'a.png', url: '/api/files/file_a000000000000000' }] },
    })
    expect(queueItemText(only)).toBe('')
    expect(queueItemPreview(only)).toBe('a.png')
    expect(queueItemPreview(queueItem({ text: '\n\n  Later line ' }))).toBe('Later line')
  })

  it('appends the texts to the draft with blank lines between them', () => {
    const items = [queueItem({ text: 'Also update the README' }), queueItem({ id: messageId('q2'), text: '  Check the lexer  ' })]
    expect(restoredDraft('', items)).toBe('Also update the README\n\nCheck the lexer')
    expect(restoredDraft('My draft\n', items)).toBe('My draft\n\nAlso update the README\n\nCheck the lexer')
    expect(restoredDraft('   ', items)).toBe('Also update the README\n\nCheck the lexer')
    expect(restoredDraft('Kept', [])).toBe('Kept')
  })
})
