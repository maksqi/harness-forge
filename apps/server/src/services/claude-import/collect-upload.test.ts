// The upload intake (W12.3-T2): the fake home as folder files (+ `~/.claude.json`) and as a zip collects the same files
// as the disk scan; paths outside the allowlist are listed as skipped and never read (not even their bytes); the input
// rules (both or neither of zip / files) and the zip guards.
import type { ClaudeImportUploadFile } from './types.ts'
import { CLAUDE_JSON_PATH } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { zipOf } from '../../plugins/install/testing.ts'
import { CLAUDE_HOME_CANARIES, fakeClaudeHomeFiles } from '../../testing/claude-fixtures.ts'
import { collectDiskHome } from './collect-disk.ts'
import { collectUpload } from './collect-upload.ts'
import { cleanupImportFixtures, tempFolder, uploadOfHome, writeFakeHome, zipOfHome } from './fixtures.test-util.ts'

afterEach(cleanupImportFixtures)

/** A blob whose bytes must never be read (a part outside the allowlist). */
function untouchable(size = 10): Blob & { reads: number } {
  const blob = new Blob(['x'.repeat(size)]) as Blob & { reads: number }
  blob.reads = 0
  const fail = async (): Promise<never> => {
    blob.reads += 1
    throw new Error('read a file outside the allowlist')
  }
  Object.defineProperty(blob, 'arrayBuffer', { value: fail })
  Object.defineProperty(blob, 'text', { value: fail })
  Object.defineProperty(blob, 'stream', {
    value: () => {
      blob.reads += 1
      throw new Error('streamed a file outside the allowlist')
    },
  })
  return blob
}

describe('collectUpload', () => {
  it('the same fake home as folder files and as a zip collects the same files as the disk scan', async () => {
    const tree = fakeClaudeHomeFiles()
    const { claudeHome } = await writeFakeHome(tree)
    const scanned = await collectDiskHome({ root: claudeHome, dataDir: await tempFolder('hf-data-') })
    const fromFiles = await collectUpload(uploadOfHome(tree))
    const fromZip = await collectUpload({ label: 'claude.zip', zip: new Blob([new Uint8Array(zipOfHome(tree))]) })
    expect(fromFiles.files).toEqual(scanned.files)
    expect(fromZip.files).toEqual(scanned.files)
    // The zip holds every file of the folder: the canary files are listed by name and never read.
    expect(fromZip.skipped.map(entry => entry.path)).toEqual(expect.arrayContaining(['.claude/.credentials.json', '.claude/history.jsonl', '.claude/projects/x.jsonl', '.claude/settings.local.json', 'skills/pdf/reference.md'].map(path => path.replace(/^\.claude\//, ''))))
    expect(fromZip.skipped.every(entry => entry.reason === 'not on the import allowlist')).toBe(true)
    const text = JSON.stringify([fromFiles, fromZip])
    for (const canary of [CLAUDE_HOME_CANARIES.oauthAccount, CLAUDE_HOME_CANARIES.primaryApiKey, CLAUDE_HOME_CANARIES.credentials, CLAUDE_HOME_CANARIES.history, CLAUDE_HOME_CANARIES.projectTranscript, CLAUDE_HOME_CANARIES.settingsLocal])
      expect(text, canary).not.toContain(canary)
  })

  it('lists parts outside the allowlist as skipped without reading them; checks the caps against the declared size', async () => {
    const outside = untouchable()
    const big = untouchable(70_000)
    const files: ClaudeImportUploadFile[] = [
      { path: '.credentials.json', file: outside },
      { path: 'projects/x.jsonl', file: outside },
      { path: '../escape.md', file: outside },
      { path: 'agents/big.md', file: big },
      { path: 'agents/ok.md', file: new Blob(['---\nname: ok\ndescription: Ok.\n---\nOk.\n']) },
      { path: 'agents/ok.md', file: outside },
      { path: 'agents/binary.md', file: new Blob([new Uint8Array([0xFF, 0xFE, 0x00])]) },
    ]
    const collected = await collectUpload({ files })
    expect(collected.files.map(file => file.path)).toEqual(['agents/ok.md'])
    expect(outside.reads + big.reads).toBe(0)
    expect(collected.skipped).toEqual([
      { path: '../escape.md', reason: 'not on the import allowlist' },
      { path: '.credentials.json', reason: 'not on the import allowlist' },
      { path: 'agents/big.md', reason: 'larger than 64 KiB' },
      { path: 'agents/binary.md', reason: 'not a text file' },
      { path: 'agents/ok.md', reason: 'listed twice' },
      { path: 'projects/x.jsonl', reason: 'not on the import allowlist' },
    ])
  })

  it('keeps ~/.claude.json from its own part (reduced), never a second one; accepts it alone', async () => {
    const claudeJson = new Blob([JSON.stringify({ primaryApiKey: CLAUDE_HOME_CANARIES.primaryApiKey, mcpServers: { x: { command: 'node' } } })])
    const collected = await collectUpload({ files: [{ path: CLAUDE_JSON_PATH, file: untouchable() }], claudeJson })
    expect(collected.files.map(file => file.path)).toEqual([CLAUDE_JSON_PATH])
    expect(collected.files[0]!.text).toBe('{"mcpServers":{"x":{"command":"node"}},"projects":{}}')
    expect(collected.skipped).toEqual([{ path: CLAUDE_JSON_PATH, reason: 'listed twice' }])
    expect((await collectUpload({ claudeJson })).files).toHaveLength(1)
    const broken = await collectUpload({ claudeJson: new Blob(['{ not json']) })
    expect(broken.files).toEqual([])
    expect(broken.diagnostics).toEqual([{ level: 'error', code: 'invalid-json', message: '.claude.json is not valid JSON.' }])
  })

  it('a zip of the folder itself, of one allowlisted folder, and the zip guards', async () => {
    const agent = '---\nname: a\ndescription: A.\n---\nA.\n'
    const flat = await collectUpload({ zip: new Blob([new Uint8Array(zipOf({ 'agents/a.md': agent, 'settings.json': '{}' }))]) })
    expect(flat.files.map(file => file.path)).toEqual(['agents/a.md', 'settings.json'])
    const onlyAgents = await collectUpload({ zip: new Blob([new Uint8Array(zipOf({ 'agents/a.md': agent, 'agents/b.md': agent.replace(/\ba\b/g, 'b') }))]) })
    expect(onlyAgents.files.map(file => file.path)).toEqual(['agents/a.md', 'agents/b.md'])
    const named = await collectUpload({ zip: new Blob([new Uint8Array(zipOf({ 'my-claude/agents/a.md': agent }))]) })
    expect(named.files.map(file => file.path)).toEqual(['agents/a.md'])

    await expect(collectUpload({ zip: new Blob(['not a zip']) })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(collectUpload({ zip: new Blob([new Uint8Array(zipOf({ 'agents/../x.md': agent }))]) })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(collectUpload({ zip: new Blob([new Uint8Array(zipOf({ 'agents/A.md': agent, 'agents/a.md': agent }))]) })).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('refuses both a zip and files, and neither', async () => {
    const zip = new Blob([new Uint8Array(zipOf({ 'agents/a.md': 'x' }))])
    await expect(collectUpload({ zip, files: [{ path: 'agents/a.md', file: new Blob(['x']) }] })).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('not both') })
    await expect(collectUpload({})).rejects.toMatchObject({ code: 'validation_error' })
    await expect(collectUpload({ files: [] })).rejects.toMatchObject({ code: 'validation_error' })
  })
})
