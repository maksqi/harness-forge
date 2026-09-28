import { describe, expect, it } from 'vitest'
import { fileIdOfUrl, referencedFileIds, rewriteFileUrls } from './parts.ts'

const A = 'file_aaaaaaaaaaaaaaaa'
const B = 'file_bbbbbbbbbbbbbbbb'
const C = 'file_cccccccccccccccc'

function messages(): Array<{ id: string, parts: unknown[] }> {
  return [
    {
      id: 'msg_1',
      parts: [
        { type: 'text', text: `see /api/files/${A}` },
        { type: 'file', mediaType: 'image/png', url: `/api/files/${A}` },
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
        { type: 'file', mediaType: 'image/png', url: `https://example.com/api/files/${C}` },
      ],
    },
    {
      id: 'msg_2',
      parts: [
        { type: 'reasoning-file', mediaType: 'image/png', url: `/api/files/${B}` },
        { type: 'tool-fetch', state: 'output-available', input: { url: `/api/files/${C}` }, output: { url: `/api/files/${C}` } },
        { type: 'source-url', sourceId: 's', url: `/api/files/${C}` },
        { type: 'file', mediaType: 'image/png', url: `/api/files/${A}` },
        'not a part',
        null,
      ],
    },
    { id: 'msg_3', parts: 'broken' },
    null,
  ] as Array<{ id: string, parts: unknown[] }>
}

describe('attachment references of message parts', () => {
  it('reads the file id of stored-file URLs only', () => {
    expect(fileIdOfUrl(`/api/files/${A}`)).toBe(A)
    expect(fileIdOfUrl(`/api/files/${A}?download=1`)).toBeNull()
    expect(fileIdOfUrl('/api/files/file_short')).toBeNull()
    expect(fileIdOfUrl(`https://example.com/api/files/${A}`)).toBeNull()
    expect(fileIdOfUrl(42)).toBeNull()
  })

  it('lists the files of file and reasoning-file parts once, in order of first reference', () => {
    expect(referencedFileIds(messages())).toEqual([A, B])
    expect(referencedFileIds([])).toEqual([])
  })

  it('rewrites the URLs of mapped file parts in place and nothing else', () => {
    const list = messages()
    expect(rewriteFileUrls(list, new Map([[A, C], [B, B]]))).toBe(2)
    const [first, second] = list as Array<{ parts: Array<Record<string, unknown>> }>
    expect(first!.parts[0]).toEqual({ type: 'text', text: `see /api/files/${A}` })
    expect(first!.parts[1]!.url).toBe(`/api/files/${C}`)
    expect(second!.parts[0]!.url).toBe(`/api/files/${B}`)
    expect(second!.parts[1]).toMatchObject({ input: { url: `/api/files/${C}` } })
    expect(second!.parts[3]!.url).toBe(`/api/files/${C}`)
    expect(referencedFileIds(list)).toEqual([C, B])
  })
})
