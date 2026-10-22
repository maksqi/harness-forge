// The entry overlay file of an export (v1.8.1, CCR-1): every overlay the marketplace parser stores reads back exactly
// (also after the JSON round trip of `plugins.origin`); anything else, malformed, oversized or with fields a marketplace
// entry does not keep, is a `validation_error` at the request's issue path.
import type { ClaudeEntryOverlay } from '../types.ts'
import { canonicalJson, parseMarketplaceJson } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { claudeMarketplaceJson } from '../../testing/claude-fixtures.ts'
import { entryOverlay } from '../marketplaces/sources.ts'
import { entryOverlayFile, OVERLAY_FILE_FORMAT, OVERLAY_FILE_MAX_BYTES, readEntryOverlayFile } from './overlay-file.ts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

function fixtureOverlays(): ClaudeEntryOverlay[] {
  const marketplace = parseMarketplaceJson(claudeMarketplaceJson()).marketplace
  expect(marketplace).not.toBeNull()
  return marketplace!.plugins.map(entryOverlay)
}

function overlayOf(name: string): ClaudeEntryOverlay {
  const found = fixtureOverlays().find(overlay => overlay.name === name)
  expect(found).toBeDefined()
  return found!
}

function fileOf(entry: unknown): Uint8Array {
  return encode(JSON.stringify({ format: OVERLAY_FILE_FORMAT, entry }))
}

function failure(data: Uint8Array): { code?: string, message?: string, details?: unknown } {
  try {
    readEntryOverlayFile(data, ['file'])
  }
  catch (error) {
    return error as { code?: string, message?: string, details?: unknown }
  }
  throw new Error('expected a validation error')
}

describe('the entry overlay file', () => {
  it('every overlay the marketplace parser stores reads back exactly, also after a JSON round trip', () => {
    const overlays = fixtureOverlays()
    expect(overlays.map(overlay => overlay.name)).toContain('inline-tools')
    for (const overlay of overlays) {
      const stored = JSON.parse(JSON.stringify(overlay)) as ClaudeEntryOverlay
      const read = readEntryOverlayFile(entryOverlayFile(stored))
      expect(read).toEqual(overlay)
      expect(canonicalJson(read)).toBe(canonicalJson(overlay))
    }
    // A strict: false entry keeps its components (the entry is the whole manifest).
    expect(readEntryOverlayFile(entryOverlayFile(overlayOf('inline-tools')))).toMatchObject({ strict: false, version: '0.1.0', overlay: { commands: ['./commands/hello.md'], agents: ['./agents/helper.md'] } })
  })

  it('refuses a file that is too large, not JSON or not an overlay file', () => {
    const big = new Uint8Array(OVERLAY_FILE_MAX_BYTES + 1).fill(0x20)
    expect(failure(big)).toMatchObject({ code: 'validation_error', message: 'The file ".hf-entry-overlay.json" of the archive is larger than 256 KB.', details: { issues: [{ path: ['file'] }] } })
    expect(failure(encode('{ "format": '))).toMatchObject({ code: 'validation_error', message: 'The file ".hf-entry-overlay.json" of the archive is not valid JSON.' })
    expect(failure(new Uint8Array([0x7B, 0xFF, 0x7D]))).toMatchObject({ code: 'validation_error', message: 'The file ".hf-entry-overlay.json" of the archive is not valid JSON.' })
    const review = overlayOf('review-kit')
    for (const value of [[], { entry: review }, { format: 'hf-entry-overlay/v2', entry: review }, { format: OVERLAY_FILE_FORMAT, entry: review, extra: true }, { format: OVERLAY_FILE_FORMAT, entry: 'review-kit' }])
      expect(failure(encode(JSON.stringify(value)))).toMatchObject({ code: 'validation_error', message: 'The file ".hf-entry-overlay.json" of the archive is not a marketplace entry overlay (format hf-entry-overlay/v1).' })
    for (const entry of [{ ...review, source: './x' }, { ...review, strict: 'yes' }, { ...review, overlay: [] }, { name: 'review-kit', strict: true }, { ...review, version: 2 }])
      expect(failure(fileOf(entry))).toMatchObject({ code: 'validation_error', message: 'The file ".hf-entry-overlay.json" of the archive is not a marketplace entry overlay: the entry needs a name, strict and overlay.' })
  })

  it('refuses an entry the marketplace parser would not store as it is', () => {
    const review = overlayOf('review-kit')
    expect(failure(fileOf({ ...review, name: 'Bad Name!' }))).toMatchObject({ code: 'validation_error', message: 'The file ".hf-entry-overlay.json" of the archive names no valid marketplace entry.' })
    const kept = 'The file ".hf-entry-overlay.json" of the archive holds fields a marketplace entry does not keep.'
    // An unknown field, a field the parser drops, an entry field, a version that is not the overlay's, a prototype key.
    for (const entry of [
      { ...review, overlay: { ...review.overlay, evil: 1 } },
      { ...review, overlay: { ...review.overlay, homepage: 'ftp://example.com' } },
      { ...review, overlay: { ...review.overlay, tags: ['x'] } },
      { ...review, version: '9.9.9' },
      { ...review, description: undefined },
    ])
      expect(failure(fileOf(entry))).toMatchObject({ code: 'validation_error', message: kept })
    const proto = `{"format":"${OVERLAY_FILE_FORMAT}","entry":{"name":"review-kit","strict":true,"overlay":{"__proto__":{"hooks":"./x.json"}}}}`
    expect(failure(encode(proto))).toMatchObject({ code: 'validation_error', message: kept })
  })
})
