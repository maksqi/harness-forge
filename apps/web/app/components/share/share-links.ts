// Pure helpers of the share link owner UI (docs/UI.md 7.14, 9.8, ADR-025): the include switches, the expiry choices
// and labels, the absolute link, counts and the dialog's error text. No Vue, no stores: unit tested on their own.
import type { ShareOptions, ShareOptionsInput, ShareSummary } from '@harness-forge/shared'
import { errorTitle } from '~/components/common/harness-error'
import { toHarnessError } from '~/utils/errors'

export type ShareOptionKey = keyof ShareOptions

/** The request running for a link card (its controls are disabled meanwhile). */
export type ShareCardAction = 'options' | 'expiry' | 'refresh' | 'revoke'

export interface ShareOptionField {
  key: ShareOptionKey
  /** `data-value` of the switch (docs/UI.md 13.6). */
  value: 'attachments' | 'reasoning' | 'tool-details'
  label: string
}

/** The include switches of a link card and of the new-link form, in display order. */
export const SHARE_OPTION_FIELDS: readonly ShareOptionField[] = [
  { key: 'attachments', value: 'attachments', label: 'Attachments' },
  { key: 'reasoning', value: 'reasoning', label: 'Reasoning' },
  { key: 'toolDetails', value: 'tool-details', label: 'Tool details' },
]

/** A new link starts with the server defaults: attachments on, reasoning and tool details off. */
export const DEFAULT_SHARE_OPTIONS: Readonly<ShareOptions> = { attachments: true, reasoning: false, toolDetails: false }

/** One changed option, the body of an options-only `PATCH /shares/:id` (applied to the page at once). */
export function optionPatch(key: ShareOptionKey, value: boolean): ShareOptionsInput {
  const options: ShareOptionsInput = {}
  options[key] = value
  return options
}

export type ShareExpiryChoice = 'never' | '1d' | '7d' | '30d' | '90d'

export interface ShareExpiryOption {
  /** `data-value` of the select item (docs/UI.md 13.6). */
  value: ShareExpiryChoice
  label: string
  /** Days from now; null = never expires. */
  days: number | null
}

export const SHARE_EXPIRY_OPTIONS: readonly ShareExpiryOption[] = [
  { value: 'never', label: 'Never', days: null },
  { value: '1d', label: '1 day', days: 1 },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '90d', label: '90 days', days: 90 },
]

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function isShareExpiryChoice(value: unknown): value is ShareExpiryChoice {
  return SHARE_EXPIRY_OPTIONS.some(option => option.value === value)
}

/** `expiresAt` of a choice counted from `now`; null for "Never" (the link never expires). */
export function expiresAtFor(choice: ShareExpiryChoice, now: number = Date.now()): number | null {
  const days = SHARE_EXPIRY_OPTIONS.find(option => option.value === choice)?.days ?? null
  return days === null ? null : now + days * DAY
}

function count(amount: number, unit: string): string {
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`
}

/**
 * The expiry state of a link (the trigger text of its expiry select): "Never expires", "Expires in 5 days",
 * "Expires in 3 hours", "Expires in 12 minutes" or "Expired". A link a few milliseconds short of a whole day still
 * reads "Expires in 1 day" (days from 22 hours on, hours from 45 minutes on).
 */
export function expiryLabel(expiresAt: number | null, now: number = Date.now(), expired = false): string {
  if (expiresAt === null)
    return 'Never expires'
  const left = expiresAt - now
  if (expired || left <= 0)
    return 'Expired'
  if (left >= 22 * HOUR)
    return `Expires in ${count(Math.max(1, Math.round(left / DAY)), 'day')}`
  if (left >= 45 * MINUTE)
    return `Expires in ${count(Math.max(1, Math.round(left / HOUR)), 'hour')}`
  return `Expires in ${count(Math.max(1, Math.ceil(left / MINUTE)), 'minute')}`
}

/** Trigger text of the new-link form's expiry select: "Never expires", "Expires in 7 days". */
export function expiryChoiceLabel(choice: ShareExpiryChoice): string {
  const option = SHARE_EXPIRY_OPTIONS.find(item => item.value === choice)
  return option && option.days !== null ? `Expires in ${option.label}` : 'Never expires'
}

/** The absolute link shown and copied by the owner: this page's origin + `ShareSummary.path` (`/share/<token>`). */
export function shareUrl(path: string, origin: string = window.location.origin): string {
  return `${origin}${path}`
}

/** "1 message", "12 messages". */
export function messageCountLabel(amount: number): string {
  return count(amount, 'message')
}

/** Newest first, the server's order (a new link goes on top). */
export function sortNewestFirst(items: readonly ShareSummary[]): ShareSummary[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt)
}

/** The dialog's message for a snapshot over `LIMITS.shareSnapshotBytes` (`413 payload_too_large`). */
export const SNAPSHOT_TOO_LARGE_MESSAGE = 'This chat is too large to share (the snapshot would exceed 10 MB).'

export interface ShareErrorView {
  code: string
  title: string
  message: string
}

/** Title (docs/UI.md 7.4) and message of a failed share request; a too large snapshot gets its own message. */
export function shareErrorView(error: unknown): ShareErrorView {
  const failure = toHarnessError(error)
  return {
    code: failure.code,
    title: errorTitle(failure),
    message: failure.code === 'payload_too_large' ? SNAPSHOT_TOO_LARGE_MESSAGE : failure.message,
  }
}
