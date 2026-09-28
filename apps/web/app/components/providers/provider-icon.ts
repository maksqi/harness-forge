// Rendering rules of ProviderIcon (docs/UI.md 10.4). The server serves every icon; the client never inlines SVG.
import { reactive } from 'vue'
import { safeAssetUrl } from '../common/format'

/** Icon URLs of a provider or plugin DTO (`IconRef` in docs/API.md): /api/icons/lobe/<slug>, /api/plugins/<id>/icon. */
export interface IconRefLike {
  color?: string
  mono?: string
}

export type ProviderIconVariant = 'auto' | 'color' | 'mono'
export type ProviderIconSize = 'sm' | 'md' | 'lg'
export type ProviderIconRendering
  = | { kind: 'mono', url: string }
    | { kind: 'color', url: string }
    | { kind: 'monogram' }

/** Stable 0-359 hue from a string (FNV-1a), used as the monogram tile hue. */
export function hashHue(seed: string): number {
  let hash = 0x811C9DC5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 360
}

/** "Together AI" -> "TA", "anthropic" -> "A", "lm-studio" -> "LS"; one letter when `max` is 1. */
export function monogramLetters(name: string, max = 2): string {
  const words = name
    .split(/[\s\-_.:/]+/)
    .map(word => Array.from(word).filter(char => /[\p{L}\p{N}]/u.test(char)))
    .filter(chars => chars.length > 0)
  const letters = words.slice(0, max).map(chars => chars[0]!)
  return (letters.join('') || '?').toUpperCase()
}

/**
 * Picks what to draw. auto = mono -> color -> monogram, color = color -> mono -> monogram, mono = mono -> monogram.
 * URLs that are unsafe or known to fail to load are skipped.
 */
export function resolveProviderIcon(
  icon: IconRefLike | null | undefined,
  variant: ProviderIconVariant,
  failed: ReadonlySet<string> = new Set(),
): ProviderIconRendering {
  const usable = (url: string | undefined) => {
    const safe = safeAssetUrl(url)
    return safe && !failed.has(safe) ? safe : null
  }
  const mono = usable(icon?.mono)
  const color = usable(icon?.color)
  const order: Array<'mono' | 'color'> = variant === 'color'
    ? ['color', 'mono']
    : variant === 'mono'
      ? ['mono']
      : ['mono', 'color']
  for (const kind of order) {
    const url = kind === 'mono' ? mono : color
    if (url)
      return { kind, url }
  }
  return { kind: 'monogram' }
}

/** CSS `url("...")` with the characters that could end the string escaped. */
export function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\n\r\f]/g, char => `\\${char.charCodeAt(0).toString(16)} `)}")`
}

// URLs that failed to load, shared by every ProviderIcon: color icons report <img> errors, mono icons are probed
// once with an Image() because a CSS mask cannot report a failure.
export const failedIconUrls = reactive(new Set<string>())
const probedIconUrls = new Set<string>()

export function markIconFailed(url: string) {
  failedIconUrls.add(url)
}

export function probeIconUrl(url: string) {
  if (probedIconUrls.has(url) || typeof Image === 'undefined')
    return
  probedIconUrls.add(url)
  const image = new Image()
  image.onerror = () => markIconFailed(url)
  image.src = url
}
