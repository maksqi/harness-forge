// LobeHub brand icons (PROVIDERS.md 10, API.md 5.8): SVG files of `@lobehub/icons-static-svg`, served only by the
// server. Slugs are file names without `.svg` (`claude`, `claude-color`); a slug is read only when it matches the slug
// pattern and exists in the package's `icons` directory, so no request can reach another file.
import type { IconRef, LobeIconEntry, LobeIconList } from '@harness-forge/shared'
import type { AppDeps } from '../types.ts'
import type { IconService, LobeIconSpec } from './types.ts'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ICON_SLUG_PATTERN } from '@harness-forge/shared'
import { packageVersion, resolvePackageDir } from '../paths.ts'

export const LOBE_ICONS_PACKAGE = '@lobehub/icons-static-svg'
/** URL prefix of `GET /icons/lobe/:slug`. */
export const LOBE_ICON_URL_PREFIX = '/api/icons/lobe/'

const COLOR_SUFFIX = '-color'
/** Wordmarks (`*-text`, `*-text-cn`) are not icons: they stay readable but are not offered in the picker list. */
const WORDMARK = /-text(?:-[a-z]+)?$/
const LOBE_PREFIX = 'lobe:'

export interface IconServiceOptions {
  /** Directory holding `<slug>.svg` files; default: `icons/` of the installed package. */
  iconsDir?: string | null
  /** Default: the installed package version. */
  version?: string
}

/** `lobe:<slug>` -> `<slug>` when the slug is valid, else null (file icons, malformed specs). */
export function lobeSlugOf(spec: string | undefined): string | null {
  if (spec === undefined || !spec.startsWith(LOBE_PREFIX))
    return null
  const slug = spec.slice(LOBE_PREFIX.length)
  return ICON_SLUG_PATTERN.test(slug) ? slug : null
}

export function createIconService(deps: AppDeps, options: IconServiceOptions = {}): IconService {
  const version = options.version ?? packageVersion(LOBE_ICONS_PACKAGE) ?? '0.0.0'
  let slugs: ReadonlySet<string> | undefined
  let list: LobeIconList | undefined
  const svgCache = new Map<string, string>()

  function iconsDir(): string | null {
    if (options.iconsDir !== undefined)
      return options.iconsDir
    const packageDir = resolvePackageDir(LOBE_ICONS_PACKAGE)
    return packageDir === null ? null : join(packageDir, 'icons')
  }

  /** Every slug of the package, read once (synchronously: `lobeRef` is synchronous). */
  function knownSlugs(): ReadonlySet<string> {
    if (slugs !== undefined)
      return slugs
    const dir = iconsDir()
    const found = new Set<string>()
    if (dir === null) {
      deps.logger.warn('LobeHub icons are unavailable: the package is not installed', { package: LOBE_ICONS_PACKAGE })
    }
    else {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.svg'))
            continue
          const slug = entry.name.slice(0, -'.svg'.length)
          if (ICON_SLUG_PATTERN.test(slug))
            found.add(slug)
        }
      }
      catch (error) {
        deps.logger.warn('cannot read the LobeHub icons directory', { err: error })
      }
    }
    slugs = found
    return found
  }

  function url(slug: string): string {
    return `${LOBE_ICON_URL_PREFIX}${slug}?v=${encodeURIComponent(version)}`
  }

  function refOf(color: string | null, mono: string | null): IconRef {
    const known = knownSlugs()
    const ref: { color?: string, mono?: string } = {}
    if (color !== null && known.has(color))
      ref.color = url(color)
    if (mono !== null && known.has(mono))
      ref.mono = url(mono)
    return ref.color === undefined && ref.mono === undefined ? null : ref
  }

  return {
    version,
    list: async () => {
      if (list === undefined) {
        const known = knownSlugs()
        const items: LobeIconEntry[] = [...known]
          .filter(slug => !slug.endsWith(COLOR_SUFFIX) && !WORDMARK.test(slug))
          .sort()
          .map(slug => ({ slug, hasColor: known.has(`${slug}${COLOR_SUFFIX}`) }))
        list = { items, version }
      }
      return { items: list.items.map(item => ({ ...item })), version: list.version }
    },
    read: async (slug) => {
      if (!ICON_SLUG_PATTERN.test(slug) || !knownSlugs().has(slug))
        return null
      const cached = svgCache.get(slug)
      if (cached !== undefined)
        return cached
      const dir = iconsDir()
      if (dir === null)
        return null
      try {
        const svg = await readFile(join(dir, `${slug}.svg`), 'utf8')
        svgCache.set(slug, svg)
        return svg
      }
      catch (error) {
        deps.logger.warn('cannot read a LobeHub icon', { slug, err: error })
        return null
      }
    },
    lobeRef: (icon: LobeIconSpec): IconRef => {
      if (typeof icon === 'string') {
        const slug = lobeSlugOf(icon)
        if (slug === null)
          return null
        // `lobe:<x>-color` also offers `<x>` as mono; `lobe:<x>` also offers `<x>-color` (when the files exist).
        if (slug.endsWith(COLOR_SUFFIX))
          return refOf(slug, slug.slice(0, -COLOR_SUFFIX.length) || null)
        return refOf(`${slug}${COLOR_SUFFIX}`, slug)
      }
      return refOf(lobeSlugOf(icon.color), lobeSlugOf(icon.mono))
    },
  }
}
