// Inspect → install round trips of Claude Code plugins with the real plugin host and reader (Phase 12, W12.2-T3 with
// W12.1's `readClaudePluginDirectory` behind `PluginHost.inspectDirectory`): zip, copied folder, GitHub and marketplace
// sources. What the review shows is what gets pinned: the inspection's sha256 is the whole-tree hash the installed
// plugin reports as `trust.hash` (so an unchanged update reads "up to date"), exec bits are kept, and a changed file
// gives another hash.
import type { SourcesTestApp } from '../marketplaces/testing.ts'
import type { PluginInstallInput } from '../types.ts'
import { statSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_MARKETPLACE, claudeMarketplaceFiles, claudePluginFiles, registerClaudeMarketplaceRemote, writeFileTree } from '../../testing/claude-fixtures.ts'
import { createFakeRemoteRoutes, githubZipOf } from '../../testing/fake-remote.ts'
import { createSourcesTestApp } from '../marketplaces/testing.ts'
import { allowAll } from './testing.ts'

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
