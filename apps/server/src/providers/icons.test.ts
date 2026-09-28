import type { AppDeps } from '../types.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lobeIconListSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../logger.ts'
import { packageVersion } from '../paths.ts'
import { createIconService, LOBE_ICONS_PACKAGE, lobeSlugOf } from './icons.ts'

function depsWithLogger(): AppDeps {
  return { logger: createMemoryLogger().logger } as unknown as AppDeps
}

describe('icon service (installed package)', () => {
  const icons = createIconService(depsWithLogger())
  const version = packageVersion(LOBE_ICONS_PACKAGE)
  const url = (slug: string): string => `/api/icons/lobe/${slug}?v=${version}`

  it('uses the package version as cache buster', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
    expect(icons.version).toBe(version)
  })

  it('lists mono slugs sorted, with hasColor, without color variants and wordmarks', async () => {
    const list = lobeIconListSchema.parse(await icons.list())
    const slugs = list.items.map(item => item.slug)
    expect(slugs).toEqual([...slugs].sort())
    expect(slugs.some(slug => slug.endsWith('-color'))).toBe(false)
    expect(slugs.some(slug => /-text(?:-[a-z]+)?$/.test(slug))).toBe(false)
    expect(list.items.find(item => item.slug === 'claude')).toEqual({ slug: 'claude', hasColor: true })
    expect(list.items.find(item => item.slug === 'openai')).toEqual({ slug: 'openai', hasColor: false })
    expect(list.version).toBe(version)
  })

  it('reads known slugs only', async () => {
    expect(await icons.read('claude-color')).toMatch(/<svg[\s>]/)
    expect(await icons.read('openai')).toMatch(/<svg[\s>]/)
    for (const slug of ['no-such-icon', '../package', '..', 'claude.svg', 'CLAUDE', ''])
      expect(await icons.read(slug)).toBeNull()
  })

  it('resolves builtin provider icons with both variants when they exist', () => {
    expect(icons.lobeRef('lobe:claude')).toEqual({ color: url('claude-color'), mono: url('claude') })
    expect(icons.lobeRef('lobe:claude-color')).toEqual({ color: url('claude-color'), mono: url('claude') })
    expect(icons.lobeRef('lobe:openai')).toEqual({ mono: url('openai') })
    expect(icons.lobeRef('lobe:grok')).toEqual({ mono: url('grok') })
    expect(icons.lobeRef({ color: 'lobe:zhipu-color', mono: 'lobe:zai' })).toEqual({ color: url('zhipu-color'), mono: url('zai') })
    expect(icons.lobeRef({ mono: 'lobe:ollama' })).toEqual({ mono: url('ollama') })
  })

  it('returns null for file icons, unknown slugs and malformed specs', () => {
    expect(icons.lobeRef('icon.svg')).toBeNull()
    expect(icons.lobeRef('lobe:no-such-icon')).toBeNull()
    expect(icons.lobeRef('lobe:../etc')).toBeNull()
    expect(icons.lobeRef({ color: 'assets/logo.png' })).toBeNull()
    expect(icons.lobeRef({})).toBeNull()
  })
})

describe('icon service (custom directory)', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hf-icons-'))
    writeFileSync(join(dir, 'acme.svg'), '<svg id="acme"/>')
    writeFileSync(join(dir, 'acme-color.svg'), '<svg id="acme-color"/>')
    writeFileSync(join(dir, 'solo-color.svg'), '<svg id="solo-color"/>')
    writeFileSync(join(dir, 'acme-text.svg'), '<svg id="acme-text"/>')
    writeFileSync(join(dir, 'Bad Name.svg'), '<svg/>')
    writeFileSync(join(dir, 'notes.txt'), 'not an icon')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('offers the mono variant of a color-only spec only when it exists', () => {
    const icons = createIconService(depsWithLogger(), { iconsDir: dir, version: '9.9.9' })
    expect(icons.lobeRef('lobe:acme-color')).toEqual({ color: '/api/icons/lobe/acme-color?v=9.9.9', mono: '/api/icons/lobe/acme?v=9.9.9' })
    expect(icons.lobeRef('lobe:solo-color')).toEqual({ color: '/api/icons/lobe/solo-color?v=9.9.9' })
  })

  it('ignores files that are not slug svgs and still reads wordmarks by slug', async () => {
    const icons = createIconService(depsWithLogger(), { iconsDir: dir, version: '9.9.9' })
    expect((await icons.list()).items).toEqual([{ slug: 'acme', hasColor: true }])
    expect(await icons.read('acme-text')).toBe('<svg id="acme-text"/>')
    expect(await icons.read('notes')).toBeNull()
  })

  it('degrades to no icons when the package is missing', async () => {
    const icons = createIconService(depsWithLogger(), { iconsDir: null, version: '0.0.0' })
    expect((await icons.list()).items).toEqual([])
    expect(await icons.read('claude')).toBeNull()
    expect(icons.lobeRef('lobe:claude')).toBeNull()
  })
})

describe('lobeSlugOf', () => {
  it('extracts valid slugs of lobe specs', () => {
    expect(lobeSlugOf('lobe:claude-color')).toBe('claude-color')
    expect(lobeSlugOf('lobe:')).toBeNull()
    expect(lobeSlugOf('lobe:a/b')).toBeNull()
    expect(lobeSlugOf('icon.svg')).toBeNull()
    expect(lobeSlugOf(undefined)).toBeNull()
  })
})
