// Inspect → install round trips of Claude Code plugins with the real plugin host and reader (Phase 12, W12.2-T3 with
// W12.1's `readClaudePluginDirectory` behind `PluginHost.inspectDirectory`): zip, copied folder, GitHub and marketplace
// sources. What the review shows is what gets pinned: the inspection's sha256 is the whole-tree hash the installed
// plugin reports as `trust.hash` (so an unchanged update reads "up to date"), exec bits are kept, and a changed file
// gives another hash. v1.8.1 (CCR-1): the export of a marketplace plugin carries its entry overlay, so its re-import on
// another server hashes and behaves like the original (a fresh install still asks for trust; an update keeps the pin).
import type { SourcesTestApp } from '../marketplaces/testing.ts'
import type { ClaudeEntryOverlay, PluginInstallInput } from '../types.ts'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_MARKETPLACE, claudeMarketplaceFiles, claudePluginFiles, registerClaudeMarketplaceRemote, writeFileTree } from '../../testing/claude-fixtures.ts'
import { createFakeRemoteRoutes, githubZipOf } from '../../testing/fake-remote.ts'
import { createSourcesTestApp } from '../marketplaces/testing.ts'
import { EntryCollector } from './archive.ts'
import { INSTALL_LIMITS } from './errors.ts'
import { OVERLAY_FILE_NAME, OVERLAY_FILE_NOTE, readEntryOverlayFile } from './overlay-file.ts'
import { allowAll } from './testing.ts'
import { readZip } from './zip.ts'

const apps: SourcesTestApp[] = []
const folders: string[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true })
})

async function realApp(routes = createFakeRemoteRoutes()): Promise<SourcesTestApp> {
  const app = await createSourcesTestApp({ routes, fakeClaude: false })
  apps.push(app)
  return app
}

async function tempFolder(): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'hf-cc-')))
  folders.push(folder)
  return folder
}

/** Inspects, installs the reviewed hash with trust and checks that the pin is the reviewed whole-tree hash. */
async function roundTrip(app: SourcesTestApp, input: PluginInstallInput): Promise<{ id: string, sha256: string }> {
  const inspection = await app.t.deps.installer.inspect(input)
  expect(inspection.format).toBe('claude')
  const detail = await app.t.deps.installer.install(input, { trust: true, sha256: inspection.sha256, authorize: allowAll })
  // A plugin that runs nothing needs no pin (trust only pins what requires it).
  expect(detail).toMatchObject({ id: inspection.manifest.id, state: 'active', trust: { trusted: true, hash: inspection.sha256, trustedHash: inspection.requiresTrust ? inspection.sha256 : null } })
  // Inspecting the same source again gives the same hash: an update would read "up to date".
  expect((await app.t.deps.installer.inspect(input)).sha256).toBe(inspection.sha256)
  return { id: detail.id, sha256: inspection.sha256 }
}

describe('claude Code plugins with the real reader', () => {
  it('zip upload and copied folder', async () => {
    const app = await realApp()
    const zip = githubZipOf('review-kit', '0'.repeat(40), claudePluginFiles('review-kit'), { topFolder: 'review-kit', comment: null })
    const zipped = await roundTrip(app, { source: 'zip', fileName: 'review-kit.zip', data: zip })
    expect(zipped.id).toBe('review-kit')
    if (process.platform !== 'win32')
      expect(statSync(join(app.t.env.paths.plugins, 'review-kit', 'hooks', 'format.sh')).mode & 0o777).toBe(0o755)

    const folder = await tempFolder()
    await writeFileTree(join(folder, 'notes-only'), claudePluginFiles('notes-only'))
    const copied = await roundTrip(app, { source: 'path', path: join(folder, 'notes-only'), mode: 'copy' })
    expect(copied.id).toBe('notes-only')
  })

  it.skipIf(process.platform === 'win32')('a linked Claude Code folder is used in place (named after its id)', async () => {
    const app = await realApp()
    const folder = await tempFolder()
    await writeFileTree(join(folder, 'single-skill'), claudePluginFiles('single-skill'))
    const input: PluginInstallInput = { source: 'path', path: join(folder, 'single-skill'), mode: 'link' }
    const inspection = await app.t.deps.installer.inspect(input)
    expect(inspection).toMatchObject({ format: 'claude', source: 'link', manifest: { id: 'single-skill' }, requiresTrust: false })
    expect(await app.t.deps.installer.install(input, { authorize: allowAll })).toMatchObject({ id: 'single-skill', source: 'link', state: 'active' })
    expect(await app.t.deps.plugins.record('single-skill')).toMatchObject({ format: 'claude', sourceRef: join(folder, 'single-skill') })
  })

  it('gitHub: the same tree from the commit zip; a changed file is another hash', async () => {
    const routes = createFakeRemoteRoutes()
    routes.commit('acme/review-kit', claudePluginFiles('review-kit'))
    const app = await realApp(routes)
    const first = await roundTrip(app, { source: 'github', repo: 'acme/review-kit' })
    routes.commit('acme/review-kit', { ...claudePluginFiles('review-kit'), 'hooks/format.sh': { content: '#!/bin/sh\necho changed\n', mode: 0o755 } })
    const changed = await app.t.deps.installer.inspect({ source: 'github', repo: 'acme/review-kit' })
    expect(changed.sha256).not.toBe(first.sha256)
    expect(changed.existing).toMatchObject({ source: 'github' })
  })

  it('marketplace entries: relative (github and folder), github, archive and npm sources', async () => {
    const routes = createFakeRemoteRoutes()
    registerClaudeMarketplaceRemote(routes)
    const app = await realApp(routes)
    const github = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    for (const plugin of ['review-kit', 'gh-plugin', 'archive-plugin', 'npm-plugin', 'inline-tools'])
      await roundTrip(app, { source: 'marketplace', marketplaceId: github.id, plugin })
    expect((await app.t.deps.marketplaces.get(github.id)).entries.filter(entry => entry.installedPluginId !== null).map(entry => entry.name).sort())
      .toEqual(['archive-plugin', 'gh-plugin', 'inline-tools', 'npm-plugin', 'review-kit'])

    const folder = await tempFolder()
    await writeFileTree(folder, claudeMarketplaceFiles())
    await app.t.deps.marketplaces.remove(github.id)
    const local = await app.t.deps.marketplaces.add({ source: { type: 'path', path: folder } })
    await roundTrip(app, { source: 'marketplace', marketplaceId: local.id, plugin: 'notes-only' })
  })
})

describe('the entry overlay of a marketplace plugin in its export (v1.8.1, CCR-1)', () => {
  it('export, then a zip install on another server: the same overlay and tree hash; trust as for any install', async () => {
    const routes = createFakeRemoteRoutes()
    registerClaudeMarketplaceRemote(routes)
    const app = await realApp(routes)
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    const original = await roundTrip(app, { source: 'marketplace', marketplaceId: marketplace.id, plugin: 'review-kit' })
    const origin = (await app.t.deps.plugins.record('review-kit'))?.origin
    expect(origin?.kind).toBe('marketplace')
    const overlay = (origin as { overlay: ClaudeEntryOverlay }).overlay
    expect(overlay).toMatchObject({ name: 'review-kit', strict: true, version: '1.2.0' })

    // The export holds the overlay file next to the installed tree.
    const exported = await app.t.deps.installer.export('review-kit')
    const entries = await readZip(exported.data, new EntryCollector(INSTALL_LIMITS))
    const file = entries.find(entry => entry.path === `review-kit/${OVERLAY_FILE_NAME}`)
    expect(file?.executable).not.toBe(true)
    expect(readEntryOverlayFile(file!.data!)).toEqual(overlay)

    // Another server: the inspection is the original's hash (with a note) and still requires trust.
    const other = await realApp()
    const input: PluginInstallInput = { source: 'zip', fileName: exported.fileName, data: exported.data }
    const inspection = await other.t.deps.installer.inspect(input)
    expect(inspection).toMatchObject({ format: 'claude', source: 'zip', manifest: { id: 'review-kit' }, sha256: original.sha256, requiresTrust: true })
    expect(inspection.warnings).toContain(OVERLAY_FILE_NOTE)
    // Without trust nothing runs; trusting pins the original's hash.
    const untrusted = await other.t.deps.installer.install(input, { sha256: inspection.sha256, authorize: allowAll })
    expect(untrusted).toMatchObject({ state: 'untrusted', origin: null, trust: { hash: original.sha256, trustedHash: null } })
    const trusted = await other.t.deps.installer.install(input, { trust: true, sha256: inspection.sha256, authorize: allowAll })
    expect(trusted).toMatchObject({ source: 'zip', state: 'active', origin: null, trust: { trusted: true, hash: original.sha256, trustedHash: original.sha256 } })
    // The overlay is kept as the server-only origin, never as a file of the plugin.
    expect((await other.t.deps.plugins.record('review-kit'))?.origin).toEqual({ kind: 'overlay', overlay })
    expect(existsSync(join(other.t.env.paths.plugins, 'review-kit', OVERLAY_FILE_NAME))).toBe(false)
    // A reload reads it again (still trusted), an update without trust keeps the pin, a second export carries it.
    expect(await other.t.deps.plugins.reload('review-kit')).toMatchObject({ state: 'active', trust: { hash: original.sha256 } })
    expect(await other.t.deps.installer.install(input, { sha256: inspection.sha256, authorize: allowAll })).toMatchObject({ state: 'active', trust: { trustedHash: original.sha256 } })
    const again = await readZip((await other.t.deps.installer.export('review-kit')).data, new EntryCollector(INSTALL_LIMITS))
    expect(readEntryOverlayFile(again.find(entry => entry.path === `review-kit/${OVERLAY_FILE_NAME}`)!.data!)).toEqual(overlay)
  })

  it('a strict: false entry (the entry is the manifest) keeps its components through the export', async () => {
    const routes = createFakeRemoteRoutes()
    registerClaudeMarketplaceRemote(routes)
    const app = await realApp(routes)
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    const original = await roundTrip(app, { source: 'marketplace', marketplaceId: marketplace.id, plugin: 'inline-tools' })
    const installed = await app.t.deps.plugins.get(original.id)
    const exported = await app.t.deps.installer.export(original.id)
    const other = await realApp()
    const inspection = await other.t.deps.installer.inspect({ source: 'zip', fileName: exported.fileName, data: exported.data })
    expect(inspection).toMatchObject({ manifest: { id: original.id, version: installed.manifest.version }, sha256: original.sha256 })
    expect(inspection.claude?.components).toEqual(installed.claude?.components)
  })
})
