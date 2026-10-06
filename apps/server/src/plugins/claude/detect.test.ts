// The C43 stub of `detectPluginLayout` (P12-0b): the final signature and the `harness` half of the rule (a root
// `plugin.json`, or one in the single top-level folder that holds everything). W12.1 adds the Claude Code half and
// extends these tests.
import { describe, expect, it } from 'vitest'
import { detectPluginLayout } from './detect.ts'

describe('detectPluginLayout (C43 stub)', () => {
  it('a root plugin.json is a harness plugin at the root (folders listed with or without a trailing slash)', () => {
    expect(detectPluginLayout(['plugin.json', 'index.mjs', 'icons/', 'icons/logo.svg'])).toEqual({ format: 'harness', prefix: '' })
    expect(detectPluginLayout(['./plugin.json'])).toEqual({ format: 'harness', prefix: '' })
  })

  it('a plugin.json inside the one top-level folder is a harness plugin with that prefix (zipped folders, npm package/)', () => {
    expect(detectPluginLayout(['package/', 'package/plugin.json', 'package/index.mjs'])).toEqual({ format: 'harness', prefix: 'package/' })
    expect(detectPluginLayout(['acme-0123456789abcdef/plugin.json'])).toEqual({ format: 'harness', prefix: 'acme-0123456789abcdef/' })
  })

  it('no plugin.json at the root or in a single top folder: null (the stub has no Claude Code half yet)', () => {
    expect(detectPluginLayout([])).toBeNull()
    expect(detectPluginLayout(['README.md'])).toBeNull()
    expect(detectPluginLayout(['a/plugin.json', 'b/plugin.json'])).toBeNull()
    expect(detectPluginLayout(['a/b/plugin.json'])).toBeNull()
    expect(detectPluginLayout(['.claude-plugin/plugin.json', 'commands/review.md'])).toBeNull()
  })
})
