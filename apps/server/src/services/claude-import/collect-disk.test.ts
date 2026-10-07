// The disk intake (W12.3-T1): the allowlist of a fake Claude Code home (C45 builders in a temp folder, never the real
// `~/.claude`) is read and nothing else is opened (a spy on every `open` and `opendir`); the canaries are never opened
// or returned; links are followed to regular files outside the data folder (a linked `CLAUDE.md` is read and marked,
// a link into the data folder is refused); the caps, the command depth, the deadline and the abort.
import type { DiskFs } from './collect-disk.ts'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { CLAUDE_JSON_PATH } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_HOME_CANARIES, claudeHomeImportFiles, fakeClaudeHomeFiles, writeFileTree } from '../../testing/claude-fixtures.ts'
import { collectDiskHome, NODE_DISK_FS, SCAN_FOLDER_ENTRIES_MAX } from './collect-disk.ts'
import { cleanupImportFixtures, tempFolder, writeFakeHome } from './fixtures.test-util.ts'

afterEach(cleanupImportFixtures)

interface Watched {
  fs: DiskFs
  opened: string[]
  listed: string[]
}

function watchedFs(): Watched {
  const opened: string[] = []
  const listed: string[] = []
  return {
    opened,
    listed,
    fs: {
      ...NODE_DISK_FS,
      open: async (path, flags) => {
        opened.push(path)
        return NODE_DISK_FS.open(path, flags)
      },
      opendir: async (path) => {
        listed.push(path)
        return NODE_DISK_FS.opendir(path)
      },
    },
  }
}

/** Paths relative to `root` (POSIX). */
function relativeTo(root: string, paths: readonly string[]): string[] {
  return paths.map(path => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)).sort()
}

describe('collectDiskHome', () => {
  it('reads exactly the allowlist of the fake home and never opens or lists anything else', async () => {
    const { home, claudeHome } = await writeFakeHome()
    const watched = watchedFs()
    const dataDir = await tempFolder('hf-data-')
    const collected = await collectDiskHome({ root: claudeHome, dataDir, fs: watched.fs })

    const expected = claudeHomeImportFiles().map(file => file.path)
    expect(collected.files.map(file => file.path)).toEqual(expected)
    // Every opened path is on the allowlist (or the sibling ~/.claude.json); the root and skill folders are never listed.
    expect(relativeTo(home, watched.opened)).toEqual([
      '.claude.json',
      ...expected.filter(path => path !== CLAUDE_JSON_PATH).map(path => `.claude/${path}`),
    ].sort())
    expect(relativeTo(home, watched.listed)).toEqual(['.claude/agents', '.claude/commands', '.claude/commands/db', '.claude/commands/db/migrate', '.claude/commands/frontend', '.claude/output-styles', '.claude/skills'])
    for (const never of ['.credentials.json', 'settings.local.json', 'history.jsonl', 'projects', 'skills/pdf/reference.md'])
      expect(watched.opened.concat(watched.listed).some(path => path.includes(never)), never).toBe(false)

    // The texts are the files' (only .claude.json is reduced to its MCP server maps).
    const byPath = new Map(collected.files.map(file => [file.path, file.text]))
    for (const file of claudeHomeImportFiles()) {
      if (file.path !== CLAUDE_JSON_PATH)
        expect(byPath.get(file.path), file.path).toBe(file.text)
    }
    const reduced = JSON.parse(byPath.get(CLAUDE_JSON_PATH)!) as Record<string, unknown>
    expect(Object.keys(reduced)).toEqual(['mcpServers', 'projects'])
    const text = JSON.stringify(collected)
    for (const canary of [CLAUDE_HOME_CANARIES.oauthAccount, CLAUDE_HOME_CANARIES.primaryApiKey, CLAUDE_HOME_CANARIES.projectHistory, CLAUDE_HOME_CANARIES.credentials, CLAUDE_HOME_CANARIES.history, CLAUDE_HOME_CANARIES.projectTranscript, CLAUDE_HOME_CANARIES.settingsLocal])
      expect(text, canary).not.toContain(canary)
    expect(collected.files.every(file => file.linked === undefined)).toBe(true)
    expect(collected.diagnostics).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('follows a link to a regular file outside the data folder and marks it; refuses a link into the data folder', async () => {
    const tree = { ...fakeClaudeHomeFiles() }
    delete (tree as Record<string, unknown>)['.claude/CLAUDE.md']
    const { claudeHome } = await writeFakeHome(tree)
    const dotfiles = await tempFolder('hf-dotfiles-')
    await writeFile(join(dotfiles, 'CLAUDE.md'), '# Linked instructions\n')
    await symlink(join(dotfiles, 'CLAUDE.md'), join(claudeHome, 'CLAUDE.md'))
    const dataDir = await tempFolder('hf-data-')
    await writeFile(join(dataDir, 'secret.md'), '---\nname: secret\ndescription: Inside the data folder.\n---\nNo.\n')
    await symlink(join(dataDir, 'secret.md'), join(claudeHome, 'agents', 'secret.md'))
    // A linked folder (a dotfile manager linking output-styles) is followed too.
    await mkdir(join(dotfiles, 'styles'))
    await writeFile(join(dotfiles, 'styles', 'plain.md'), '---\nname: Plain\ndescription: Plain answers.\n---\nAnswer plainly.\n')
    await rm(join(claudeHome, 'output-styles'), { recursive: true })
    await symlink(join(dotfiles, 'styles'), join(claudeHome, 'output-styles'))

    const collected = await collectDiskHome({ root: claudeHome, dataDir })
    const byPath = new Map(collected.files.map(file => [file.path, file]))
    expect(byPath.get('CLAUDE.md')).toEqual({ path: 'CLAUDE.md', text: '# Linked instructions\n', linked: true })
    expect(byPath.get('output-styles/plain.md')).toMatchObject({ linked: true })
    expect(byPath.has('agents/secret.md')).toBe(false)
    expect(collected.skipped).toContainEqual({ path: 'agents/secret.md', reason: 'a link into the data folder of harness-forge' })
  })

  it('reads .claude.json inside a root that is not named .claude; a missing or file root is not_found', async () => {
    const root = join(await tempFolder(), 'claude-config')
    await writeFileTree(root, {
      'agents/a.md': { content: '---\nname: a\ndescription: A.\n---\nA.\n', mode: 0o644 },
      '.claude.json': { content: JSON.stringify({ primaryApiKey: CLAUDE_HOME_CANARIES.primaryApiKey, mcpServers: { x: { command: 'node' } } }), mode: 0o644 },
    })
    const dataDir = await tempFolder('hf-data-')
    const collected = await collectDiskHome({ root, dataDir })
    expect(collected.files.map(file => file.path)).toEqual(['.claude.json', 'agents/a.md'])
    expect(collected.files[0]!.text).not.toContain(CLAUDE_HOME_CANARIES.primaryApiKey)

    await expect(collectDiskHome({ root: join(root, 'missing'), dataDir })).rejects.toMatchObject({ code: 'not_found' })
    await expect(collectDiskHome({ root: join(root, 'agents', 'a.md'), dataDir })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('applies the caps before reading: a too large file, a folder too deep, a non-markdown file, more than 2000 entries', async () => {
    const root = join(await tempFolder(), '.claude')
    await writeFileTree(root, {
      'agents/big.md': { content: `---\nname: big\ndescription: Big.\n---\n${'x'.repeat(70_000)}\n`, mode: 0o644 },
      'agents/notes.txt': { content: 'not a definition', mode: 0o644 },
      'commands/a/b/c/ok.md': { content: '---\ndescription: Deep enough.\n---\nOk.\n', mode: 0o644 },
      'commands/a/b/c/d/deep.md': { content: '---\ndescription: Too deep.\n---\nNo.\n', mode: 0o644 },
    })
    await mkdir(join(root, 'output-styles'))
    for (let index = 0; index <= SCAN_FOLDER_ENTRIES_MAX; index++)
      await writeFile(join(root, 'output-styles', `s${String(index).padStart(4, '0')}.txt`), '')
    const watched = watchedFs()
    const collected = await collectDiskHome({ root, dataDir: await tempFolder('hf-data-'), fs: watched.fs })
    expect(collected.files.map(file => file.path)).toEqual(['commands/a/b/c/ok.md'])
    expect(collected.skipped).toContainEqual({ path: 'agents/big.md', reason: 'larger than 64 KiB' })
    expect(collected.skipped).toContainEqual({ path: 'agents/notes.txt', reason: 'not on the import allowlist' })
    expect(collected.skipped).toContainEqual({ path: 'commands/a/b/c/d/', reason: 'deeper than 3 folders' })
    expect(watched.opened.some(path => path.endsWith('notes.txt') || path.endsWith('deep.md'))).toBe(false)
    expect(collected.diagnostics).toEqual([{ level: 'warning', code: 'too-many', message: `The folder output-styles has more than ${SCAN_FOLDER_ENTRIES_MAX} entries; the rest were not read.` }])
  })

  it('stops at the deadline with what it read and a timeout warning; an abort rejects', async () => {
    const { claudeHome } = await writeFakeHome()
    let clock = 0
    let calls = 0
    // Every check costs a second after the first ten: the deadline (3 s) passes during the scan.
    const now = (): number => {
      calls += 1
      if (calls > 10)
        clock += 1000
      return clock
    }
    const collected = await collectDiskHome({ root: claudeHome, dataDir: await tempFolder('hf-data-'), timeoutMs: 3000, now })
    expect(collected.files.length).toBeLessThan(claudeHomeImportFiles().length)
    expect(collected.diagnostics).toContainEqual(expect.objectContaining({ level: 'warning', code: 'timeout' }))

    const controller = new AbortController()
    controller.abort()
    await expect(collectDiskHome({ root: claudeHome, dataDir: await tempFolder('hf-data-'), signal: controller.signal })).rejects.toMatchObject({ code: 'conflict' })
  })
})
