// `detectPluginLayout` (C43 signature, W12.1): a root `plugin.json` is a harness plugin; `.claude-plugin/plugin.json` or
// any Claude Code component is a Claude Code plugin; both at the root or inside the one top-level folder.
import { describe, expect, it } from 'vitest'
import { claudePluginFiles } from '../../testing/claude-fixtures.ts'
import { detectPluginLayout } from './detect.ts'

describe('detectPluginLayout', () => {
  it('a root plugin.json is a harness plugin at the root (folders listed with or without a trailing slash)', () => {
    expect(detectPluginLayout(['plugin.json', 'index.mjs', 'icons/', 'icons/logo.svg'])).toEqual({ format: 'harness', prefix: '' })
    expect(detectPluginLayout(['./plugin.json'])).toEqual({ format: 'harness', prefix: '' })
  })

  it('a plugin.json inside the one top-level folder is a harness plugin with that prefix (zipped folders, npm package/)', () => {
    expect(detectPluginLayout(['package/', 'package/plugin.json', 'package/index.mjs'])).toEqual({ format: 'harness', prefix: 'package/' })
    expect(detectPluginLayout(['acme-0123456789abcdef/plugin.json'])).toEqual({ format: 'harness', prefix: 'acme-0123456789abcdef/' })
  })

  it('a Claude Code manifest or any Claude Code component is a Claude Code plugin', () => {
    expect(detectPluginLayout(['.claude-plugin/plugin.json', 'commands/review.md'])).toEqual({ format: 'claude', prefix: '' })
    for (const paths of [
      ['commands/'],
      ['commands/review.md'],
      ['agents/reviewer.md'],
      ['skills/pdf/SKILL.md', 'skills/pdf/reference.md'],
      ['SKILL.md', 'reference.md'],
      ['output-styles/terse.md'],
      ['hooks/hooks.json'],
      ['.mcp.json'],
    ])
      expect(detectPluginLayout(paths), paths.join(',')).toEqual({ format: 'claude', prefix: '' })
    for (const name of ['review-kit', 'notes-only', 'single-skill', 'broken', 'broken-manifest', 'uid-mark'] as const)
      expect(detectPluginLayout(Object.keys(claudePluginFiles(name))), name).toEqual({ format: 'claude', prefix: '' })
  })

  it('finds a Claude Code plugin in the one top folder (a GitHub zip, a zipped folder)', () => {
    const paths = Object.keys(claudePluginFiles('review-kit')).map(path => `claude-review-kit-0123456789ab/${path}`)
    expect(detectPluginLayout(['claude-review-kit-0123456789ab/', ...paths])).toEqual({ format: 'claude', prefix: 'claude-review-kit-0123456789ab/' })
  })

  it('a harness manifest wins at the same level; the root wins over the top folder', () => {
    expect(detectPluginLayout(['plugin.json', 'commands/review.md', '.mcp.json'])).toEqual({ format: 'harness', prefix: '' })
    expect(detectPluginLayout(['top/plugin.json', 'top/commands/x.md'])).toEqual({ format: 'harness', prefix: 'top/' })
    expect(detectPluginLayout(['commands/x.md', 'commands/plugin.json'])).toEqual({ format: 'claude', prefix: '' })
  })

  it('nothing it knows: null', () => {
    expect(detectPluginLayout([])).toBeNull()
    expect(detectPluginLayout(['README.md'])).toBeNull()
    expect(detectPluginLayout(['a/plugin.json', 'b/plugin.json'])).toBeNull()
    expect(detectPluginLayout(['a/b/plugin.json'])).toBeNull()
    expect(detectPluginLayout(['skills/README.md', 'docs/SKILL.md'])).toBeNull()
    expect(detectPluginLayout(['a/commands/x.md', 'b/agents/y.md'])).toBeNull()
  })
})
