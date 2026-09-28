// Masked hints of secret values (`SecretState.hint`), computed once at write time and stored in `secrets.hint`.
//
//   length < 12          -> null           (fully masked)
//   12 <= length < 24    -> "…9fQ2"        (last 4 characters)
//   length >= 24         -> "sk-…9fQ2"     (first 3 + last 4 characters)
//
// Lengths count Unicode code points. At most 7 characters of a value of 24 or more are revealed, and never more than a
// third of a shorter one; real provider keys (32+ characters) always get the `sk-…9fQ2` form.

/** Values shorter than this get no hint. */
export const HINT_MIN_LENGTH = 12
/** From this length the hint also shows the first characters. */
export const HINT_PREFIX_MIN_LENGTH = 24
export const HINT_PREFIX_CHARS = 3
export const HINT_SUFFIX_CHARS = 4
export const HINT_ELLIPSIS = '…'

/** The masked hint of a secret value, or null when the value is too short to reveal anything. */
export function secretHint(value: string): string | null {
  const chars = Array.from(value)
  if (chars.length < HINT_MIN_LENGTH)
    return null
  const suffix = chars.slice(-HINT_SUFFIX_CHARS).join('')
  if (chars.length < HINT_PREFIX_MIN_LENGTH)
    return `${HINT_ELLIPSIS}${suffix}`
  return `${chars.slice(0, HINT_PREFIX_CHARS).join('')}${HINT_ELLIPSIS}${suffix}`
}
