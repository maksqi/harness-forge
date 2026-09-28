// Small display formatters shared by common/ and providers/ components.

/** "812 B", "12 KB", "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0)
    return ''
  if (bytes < 1024)
    return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded} ${units[unit]}`
}

/** Decimal unit when exact (128000 -> 128), else binary when exact (32768 -> 32), else decimal. */
function scaleTokens(tokens: number, decimal: number, binary: number): number {
  if (tokens % decimal === 0)
    return tokens / decimal
  if (tokens % binary === 0)
    return tokens / binary
  return tokens / decimal
}

/** Token counts as "200K" / "128K" / "1M" / "1.5M"; exact binary sizes read naturally (32768 -> "32K"). */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0)
    return ''
  const oneDecimal = (value: number) => String(Math.round(value * 10) / 10)
  if (tokens >= 1000) {
    const thousands = scaleTokens(tokens, 1000, 1024)
    const label = thousands >= 10 ? String(Math.round(thousands)) : oneDecimal(thousands)
    if (tokens < 1_000_000 && Number(label) < 1000)
      return `${label}K`
    return `${oneDecimal(scaleTokens(tokens, 1_000_000, 1_048_576))}M`
  }
  return String(Math.round(tokens))
}

/**
 * Accepts only URLs that are safe to use in src / CSS url(): same-origin paths, http(s), blob: and data:image/.
 * Anything else (javascript:, protocol-relative //host, malformed) yields null.
 */
export function safeAssetUrl(url: string | null | undefined): string | null {
  if (!url)
    return null
  const value = url.trim()
  if (!value || Array.from(value).some(char => char.charCodeAt(0) < 0x20))
    return null
  // "//host" and "/\host" are protocol-relative (browsers treat "\" like "/").
  if (value.startsWith('/'))
    return value[1] === '/' || value[1] === '\\' ? null : value
  if (/^https?:\/\//i.test(value) || /^blob:/i.test(value) || /^data:image\//i.test(value))
    return value
  return null
}
