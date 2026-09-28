import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  expiresAtFor,
  expiryChoiceLabel,
  expiryLabel,
  isShareExpiryChoice,
  messageCountLabel,
  optionPatch,
  SHARE_EXPIRY_OPTIONS,
  SHARE_OPTION_FIELDS,
  shareErrorView,
  shareUrl,
  SNAPSHOT_TOO_LARGE_MESSAGE,
  sortNewestFirst,
} from './share-links'
import { shareId, shareSummary } from './testing'

const NOW = Date.UTC(2026, 8, 28, 12)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('share link helpers', () => {
  it('lists the switches and expiry choices with their test values', () => {
    expect(SHARE_OPTION_FIELDS.map(field => [field.key, field.value, field.label])).toEqual([
      ['attachments', 'attachments', 'Files and images'],
      ['reasoning', 'reasoning', 'Reasoning'],
      ['toolDetails', 'tool-details', 'Tool details'],
    ])
    expect(SHARE_EXPIRY_OPTIONS.map(option => option.value)).toEqual(['never', '1d', '7d', '30d', '90d'])
    expect(isShareExpiryChoice('7d')).toBe(true)
    expect(isShareExpiryChoice('2d')).toBe(false)
    expect(isShareExpiryChoice(null)).toBe(false)
  })

  it('builds an options patch with exactly one key', () => {
    expect(optionPatch('toolDetails', true)).toEqual({ toolDetails: true })
    expect(optionPatch('attachments', false)).toEqual({ attachments: false })
  })

  it('computes expiresAt from now, null for never', () => {
    expect(expiresAtFor('never', NOW)).toBeNull()
    expect(expiresAtFor('1d', NOW)).toBe(NOW + DAY)
    expect(expiresAtFor('7d', NOW)).toBe(NOW + 7 * DAY)
    expect(expiresAtFor('30d', NOW)).toBe(NOW + 30 * DAY)
    expect(expiresAtFor('90d', NOW)).toBe(NOW + 90 * DAY)
  })

  it('labels the expiry state of a link', () => {
    expect(expiryLabel(null, NOW)).toBe('Never expires')
    expect(expiryLabel(NOW + 7 * DAY - 5, NOW)).toBe('Expires in 7 days')
    expect(expiryLabel(NOW + DAY - 5, NOW)).toBe('Expires in 1 day')
    expect(expiryLabel(NOW + 5 * DAY + 2 * HOUR, NOW)).toBe('Expires in 5 days')
    expect(expiryLabel(NOW + 3 * HOUR, NOW)).toBe('Expires in 3 hours')
    expect(expiryLabel(NOW + 50 * MINUTE, NOW)).toBe('Expires in 1 hour')
    expect(expiryLabel(NOW + 12 * MINUTE, NOW)).toBe('Expires in 12 minutes')
    expect(expiryLabel(NOW + 10_000, NOW)).toBe('Expires in 1 minute')
    expect(expiryLabel(NOW, NOW)).toBe('Expired')
    expect(expiryLabel(NOW - DAY, NOW)).toBe('Expired')
    // The server's flag wins over a clock that lags behind.
    expect(expiryLabel(NOW + DAY, NOW, true)).toBe('Expired')
  })

  it('labels the expiry choice of a new link', () => {
    expect(expiryChoiceLabel('never')).toBe('Never expires')
    expect(expiryChoiceLabel('1d')).toBe('Expires in 1 day')
    expect(expiryChoiceLabel('90d')).toBe('Expires in 90 days')
  })

  it('builds the absolute link from the origin and the path', () => {
    expect(shareUrl('/share/abc', 'https://chat.example.com')).toBe('https://chat.example.com/share/abc')
    expect(shareUrl('/share/abc')).toBe(`${window.location.origin}/share/abc`)
  })

  it('counts messages and sorts newest first', () => {
    expect(messageCountLabel(1)).toBe('1 message')
    expect(messageCountLabel(0)).toBe('0 messages')
    expect(messageCountLabel(12)).toBe('12 messages')
    const older = shareSummary({ id: shareId(1), createdAt: NOW - DAY })
    const newer = shareSummary({ id: shareId(2), createdAt: NOW })
    expect(sortNewestFirst([older, newer]).map(item => item.id)).toEqual([shareId(2), shareId(1)])
  })

  it('describes failures with the 7.4 title and a dedicated text for a snapshot over 10 MB', () => {
    expect(shareErrorView(new HarnessError({ code: 'payload_too_large', message: 'Too large.', details: { limitBytes: 10_485_760 } }))).toEqual({
      code: 'payload_too_large',
      title: 'Too large',
      message: SNAPSHOT_TOO_LARGE_MESSAGE,
    })
    expect(SNAPSHOT_TOO_LARGE_MESSAGE).toBe('This chat is too large to share (the snapshot would exceed 10 MB).')
    expect(shareErrorView(new HarnessError({ code: 'validation_error', message: 'A chat can have at most 20 share links.' }))).toEqual({
      code: 'validation_error',
      title: 'Some values are not valid',
      message: 'A chat can have at most 20 share links.',
    })
    expect(shareErrorView(new TypeError('boom')).code).toBe('internal_error')
  })
})
