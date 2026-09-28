// Pure helpers of the generated images (docs/UI.md 7.16; ADR-028): the gallery tiles (safe URLs, labels, download
// names and links) and the placeholders of an image turn in flight (aspect ratio, caption). No Vue, no stores.
import type { ImageAspectRatio } from '@harness-forge/shared'
import type { FileUIPart } from 'ai'
import { safeAssetUrl } from '~/components/common/format'

/** CSS `aspect-ratio` of a requested ratio ("16 / 9"); Auto (none) is square. */
export function aspectRatioCss(ratio: ImageAspectRatio | undefined): string {
  const [width = '1', height = '1'] = (ratio ?? '1:1').split(':')
  return `${width} / ${height}`
}

/** "Generating image… 12s" / "Generating 2 images… 12s": whole seconds since the start, never negative. */
export function generatingCaption(count: number, elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0
  return count === 1 ? `Generating image… ${seconds}s` : `Generating ${count} images… ${seconds}s`
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

/** File extension of an image type ("jpg" for image/jpeg); else the subtype's letters, "png" as the last resort. */
export function imageExtension(mediaType: string): string {
  const type = mediaType.split(';')[0]!.trim().toLowerCase()
  const known = EXTENSIONS[type]
  if (known)
    return known
  const subtype = type.startsWith('image/') ? type.slice(6).split('+')[0]!.replace(/[^a-z\d]/g, '') : ''
  return subtype.slice(0, 10) || 'png'
}

/** Download name of the image at `index` (0-based): the part's filename (the server sets it), else "image-<n>.<ext>". */
export function imageDownloadName(part: Pick<FileUIPart, 'filename' | 'mediaType'>, index: number): string {
  // A name, never a path.
  const name = part.filename?.split(/[/\\]/).pop()?.trim().slice(0, 255)
  return name || `image-${index + 1}.${imageExtension(part.mediaType)}`
}

/**
 * The URL a Download link (`<a download>`) may use: a same-origin path or URL, a blob: URL or an image data: URL.
 * A cross-origin URL gets no link: browsers ignore `download` there and would navigate away instead.
 */
export function downloadableUrl(url: string | null, origin?: string): string | null {
  const safe = safeAssetUrl(url)
  if (!safe)
    return null
  if (safe.startsWith('/') || /^(?:blob:|data:image\/)/i.test(safe))
    return safe
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  try {
    return new URL(safe).origin === base ? safe : null
  }
  catch {
    return null
  }
}

export interface GalleryImage {
  /** The image URL (through safeAssetUrl). */
  url: string
  mediaType: string
  /** "Generated image 2 of 3" (the image's alt text). */
  alt: string
  /** "Open image 2 of 3" (the tile's label). */
  label: string
  downloadUrl: string | null
  downloadName: string
}

/** The tiles of a gallery: images whose URL is safe to load, labelled in order. */
export function galleryImages(images: readonly FileUIPart[]): GalleryImage[] {
  const usable = images.flatMap((part) => {
    const url = safeAssetUrl(part.url)
    return url ? [{ part, url }] : []
  })
  return usable.map(({ part, url }, index) => ({
    url,
    mediaType: part.mediaType,
    alt: `Generated image ${index + 1} of ${usable.length}`,
    label: `Open image ${index + 1} of ${usable.length}`,
    downloadUrl: downloadableUrl(url),
    downloadName: imageDownloadName(part, index),
  }))
}
