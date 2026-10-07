// The plugin formats of the host (W12.1-T1 / T6): the layout of a folder placed by hand, the reader per format and the
// declared contributions of a Claude Code plugin.
import type { FixtureTree } from '../testing/claude-fixtures.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudePluginFiles, writeFileTree } from '../testing/claude-fixtures.ts'
import { claudeContributions, detectFolderFormat, readPluginDirectoryFor } from './formats.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

async function folder(files: FixtureTree, name = 'plugin'): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'hf-formats-')))
  roots.push(parent)
  const dir = join(parent, name)
  await writeFileTree(dir, files)
  return dir
}

const text = (content: string): { content: string, mode: number } => ({ content, mode: 0o644 })

describe('detectFolderFormat', () => {
  it('a root plugin.json is harness; a Claude Code layout is claude; anything else null', async () => {
    expect(await detectFolderFormat(await folder({ 'plugin.json': text('{}'), 'commands/x.md': text('x') }))).toBe('harness')
    for (const name of ['review-kit', 'notes-only', 'single-skill', 'broken', 'uid-mark'] as const)
      expect(await detectFolderFormat(await folder(claudePluginFiles(name))), name).toBe('claude')
    expect(await detectFolderFormat(await folder({ 'skills/pdf/SKILL.md': text('x') }))).toBe('claude')
    expect(await detectFolderFormat(await folder({ '.claude-plugin/plugin.json': text('{}') }))).toBe('claude')
    expect(await detectFolderFormat(await folder({ 'README.md': text('x'), 'docs/a.md': text('x') }))).toBeNull()
    expect(await detectFolderFormat(join(tmpdir(), 'hf-formats-missing-folder'))).toBeNull()
  })
})

describe('readPluginDirectoryFor', () => {
  it('reads a Claude Code plugin with the reader of its format and lists its declared contributions', async () => {
    const dir = await folder(claudePluginFiles('review-kit'), 'review-kit')
    const read = await readPluginDirectoryFor('claude', dir, { expectedId: 'review-kit' })
    expect(read.format).toBe('claude')
    expect(read.directory.problem).toBeNull()
    expect(claudeContributions(read.claude!)).toEqual({
      providers: [],
      models: 0,
      tools: [],
      mcpServers: ['review-kit-review-tools', 'review-kit-review-api'],
      commands: ['review-kit:clean-gone', 'review-kit:db:migrate', 'review-kit:review'],
      hooks: [],
      agents: ['review-kit:code-reviewer'],
      skills: ['review-kit:pdf'],
      commandHooks: 1,
      outputStyles: ['review-kit:terse'],
    })
  })

  it('reads a harness plugin with the loader (no Claude Code part)', async () => {
    const dir = await folder({ 'plugin.json': text(JSON.stringify({ manifestVersion: 1, id: 'plain', name: 'Plain', version: '1.0.0', engines: { harness: '^1.0.0' } })) }, 'plain')
    const read = await readPluginDirectoryFor('harness', dir, { expectedId: 'plain' })
    expect(read).toMatchObject({ format: 'harness', claude: null, directory: { problem: null, manifest: { id: 'plain' } } })
  })
})
