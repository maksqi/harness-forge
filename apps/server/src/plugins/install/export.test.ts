// Export of a Claude Code plugin (W12.18-T1; `GET /plugins/:id/export`): the installed tree below `<id>/` with the same
// paths and contents, the owner exec bits as Unix external attributes, the UTF-8 path order, `<id>-<version>.zip`, the
// skip rules and caps of the harness export. Round trip with the real host and reader: inspecting the exported zip
// gives the installed plugin's `trust.hash`, and installing it again keeps the exec bits on disk.
import type { SourcesTestApp } from '../marketplaces/testing.ts'
import { Buffer } from 'node:buffer'
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { claudePluginFiles, writeFileTree } from '../../testing/claude-fixtures.ts'
import { githubZipOf } from '../../testing/fake-remote.ts'
import { compareUtf8, scanPluginTree } from '../claude/tree-hash.ts'
import { createSourcesTestApp } from '../marketplaces/testing.ts'
import { EntryCollector } from './archive.ts'
import { INSTALL_LIMITS } from './errors.ts'
import { exportPluginDirectory } from './export.ts'
import { allowAll } from './testing.ts'
import { readZip } from './zip.ts'

const apps: SourcesTestApp[] = []
const folders: string[] = []
const posix = process.platform !== 'win32'

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true })
})

async function realApp(): Promise<SourcesTestApp> {
  const app = await createSourcesTestApp({ fakeClaude: false })
  apps.push(app)
  return app
}

async function tempFolder(): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'hf-export-')))
  folders.push(folder)
  return folder
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: string, message?: string }> {
  try {
    await promise
  }
  catch (error) {
    return error as { code?: string, message?: string }
  }
  throw new Error('expected a rejection')
}

describe('export of a Claude Code plugin', () => {
  it('review-kit: the installed tree with its exec bits; inspecting the zip gives the trust hash; a reinstall keeps the modes', async () => {
    const app = await realApp()
    const zip = githubZipOf('review-kit', '0'.repeat(40), claudePluginFiles('review-kit'), { topFolder: 'review-kit', comment: null })
    const input = { source: 'zip', fileName: 'review-kit.zip', data: zip } as const
    const inspection = await app.t.deps.installer.inspect(input)
    const installed = await app.t.deps.installer.install(input, { trust: true, sha256: inspection.sha256, authorize: allowAll })
    expect(installed).toMatchObject({ id: 'review-kit', format: 'claude', version: '1.2.0', trust: { hash: inspection.sha256 } })
    const dir = join(app.t.env.paths.plugins, 'review-kit')
    const tree = await scanPluginTree(dir)

    const exported = await app.t.deps.installer.export('review-kit')
    expect(exported.fileName).toBe('review-kit-1.2.0.zip')
    const entries = await readZip(exported.data, new EntryCollector(INSTALL_LIMITS))
    // The same files (no folder entries), in the UTF-8 byte order of their paths, with the installed contents.
    expect(entries.map(entry => entry.path)).toEqual(tree.files.map(file => `review-kit/${file.path}`))
    expect(entries.map(entry => entry.path)).toEqual([...entries.map(entry => entry.path)].sort(compareUtf8))
    for (const entry of entries)
      expect(Buffer.from(entry.data ?? []).equals(readFileSync(join(dir, entry.path.slice('review-kit/'.length))))).toBe(true)
    if (posix) {
      expect(entries.filter(entry => entry.executable === true).map(entry => entry.path))
        .toEqual(['review-kit/bin/tool', 'review-kit/hooks/format.sh', 'review-kit/skills/pdf/scripts/fill.sh'])
    }
    // Deterministic: the same tree gives the same bytes.
    expect(Buffer.from((await app.t.deps.installer.export('review-kit')).data).equals(Buffer.from(exported.data))).toBe(true)

    // The route answers the same zip.
    const response = await app.t.request('/api/plugins/review-kit/export')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('filename="review-kit-1.2.0.zip"')
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(exported.data))).toBe(true)

    // Inspecting the export: the same id and the same whole-tree hash (an update would read "up to date").
    const again = await app.t.deps.installer.inspect({ source: 'zip', fileName: exported.fileName, data: exported.data })
    expect(again).toMatchObject({ format: 'claude', manifest: { id: 'review-kit', version: '1.2.0' }, sha256: installed.trust.hash })

    // Installed on another server, the exec bits are back on disk and the pin is the same hash.
    const other = await realApp()
    const reinstalled = await other.t.deps.installer.install({ source: 'zip', fileName: exported.fileName, data: exported.data }, { trust: true, sha256: again.sha256, authorize: allowAll })
    expect(reinstalled).toMatchObject({ id: 'review-kit', state: 'active', trust: { hash: installed.trust.hash, trustedHash: installed.trust.hash } })
    if (posix) {
      const target = join(other.t.env.paths.plugins, 'review-kit')
      expect(statSync(join(target, 'hooks', 'format.sh')).mode & 0o777).toBe(0o755)
      expect(statSync(join(target, 'skills', 'pdf', 'scripts', 'fill.sh')).mode & 0o777).toBe(0o755)
      expect(statSync(join(target, 'README.md')).mode & 0o777).toBe(0o644)
    }
  })

  it('a plugin without plugin.json keeps its id through the <id>/ folder; skip rules, links and caps', async () => {
    const app = await realApp()
    const folder = await tempFolder()
    await writeFileTree(join(folder, 'notes-only'), claudePluginFiles('notes-only'))
    const installed = await app.t.deps.installer.install({ source: 'path', path: join(folder, 'notes-only'), mode: 'copy' }, { authorize: allowAll })
    expect(installed).toMatchObject({ id: 'notes-only', format: 'claude', version: '0.0.0' })
    const exported = await app.t.deps.installer.export('notes-only')
    expect(exported.fileName).toBe('notes-only-0.0.0.zip')
    const inspection = await app.t.deps.installer.inspect({ source: 'zip', fileName: 'renamed-upload.zip', data: exported.data })
    expect(inspection).toMatchObject({ manifest: { id: 'notes-only' }, sha256: installed.trust.hash })

    // What the harness export leaves out is left out here too (links are never followed or exported).
    const dir = join(app.t.env.paths.plugins, 'notes-only')
    writeFileSync(join(dir, '.env'), 'TOKEN=local-secret')
    writeFileSync(join(dir, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_secret')
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'x.js'), 'x')
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    if (posix) {
      symlinkSync('/etc/hosts', join(dir, 'hosts-link'))
      expect(lstatSync(join(dir, 'hosts-link')).isSymbolicLink()).toBe(true)
    }
    const filtered = await exportPluginDirectory('notes-only', '0.0.0', dir, INSTALL_LIMITS, { format: 'claude' })
    expect((await readZip(filtered.data, new EntryCollector(INSTALL_LIMITS))).map(entry => entry.path))
      .toEqual(['notes-only/commands/note.md', 'notes-only/commands/summarize.md'])

    // The caps of the harness export: entries (files and folders) and bytes.
    expect(await rejection(exportPluginDirectory('notes-only', '0.0.0', dir, { entries: 2, expandedBytes: INSTALL_LIMITS.expandedBytes }, { format: 'claude' })))
      .toMatchObject({ code: 'validation_error', message: 'The plugin has more than 2 files and folders, so it cannot be exported.' })
    expect(await rejection(exportPluginDirectory('notes-only', '0.0.0', dir, { entries: INSTALL_LIMITS.entries, expandedBytes: 10 }, { format: 'claude' })))
      .toMatchObject({ code: 'payload_too_large' })
    // A harness plugin still needs its plugin.json; an empty Claude Code folder has nothing to export.
    expect(await rejection(exportPluginDirectory('notes-only', '0.0.0', dir, INSTALL_LIMITS)))
      .toMatchObject({ code: 'validation_error', message: 'The plugin directory has no "plugin.json", so it cannot be exported.' })
    const empty = await tempFolder()
    expect(await rejection(exportPluginDirectory('empty', '1.0.0', empty, INSTALL_LIMITS, { format: 'claude' })))
      .toMatchObject({ code: 'validation_error', message: 'The plugin folder has no files, so it cannot be exported.' })
  })
})
