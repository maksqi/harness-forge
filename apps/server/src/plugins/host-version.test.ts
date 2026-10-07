// The version of a Claude Code plugin without a `version` in its manifest (W12.18-T2): the host reads it with the hint
// the installer used, so an npm install keeps the package version (and a marketplace npm entry its `npmVersion`) on
// every load, also after a restart on the same data directory and database. Real host and reader; the npm registry is
// the in-memory fake remote (no network).
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeRemoteRoutes } from '../testing/fake-remote.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_MARKETPLACE, claudeMarketplaceFiles, claudePluginFiles, registerClaudeMarketplaceRemote, writeFileTree } from '../testing/claude-fixtures.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeRemoteRoutes, createFakeSafeFetch } from '../testing/fake-remote.ts'
import { createFakeIconService } from '../testing/fakes.ts'
import { createInstaller } from './install/index.ts'
import { allowAll } from './install/testing.ts'
import { createMarketplaceService } from './marketplaces/index.ts'
import { npmFetchOver } from './marketplaces/testing.ts'

const apps: TestApp[] = []
const folders: string[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true })
})

async function tempFolder(prefix: string): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  folders.push(folder)
  return folder
}

/** An app on `dataDir` with a database file there (so a second boot is a restart), installer and marketplaces faked. */
async function boot(dataDir: string, routes: FakeRemoteRoutes): Promise<TestApp> {
  const fake = createFakeSafeFetch(routes)
  const t = await createTestApp({
    dataDir,
    databasePath: join(dataDir, 'harness.db'),
    start: false,
    builtins: [],
    overrides: { icons: createFakeIconService() },
    factories: {
      installer: deps => createInstaller(deps, { safeFetch: fake.safeFetch, fetch: npmFetchOver(routes) }),
      marketplaces: deps => createMarketplaceService(deps, { safeFetch: fake.safeFetch }),
    },
  })
  apps.push(t)
  await t.deps.installer.recover()
  await t.deps.plugins.start()
  return t
}

async function restart(t: TestApp, routes: FakeRemoteRoutes): Promise<TestApp> {
  await t.close()
  apps.splice(apps.indexOf(t), 1)
  return boot(t.env.dataDir, routes)
}

describe('the version of a Claude Code plugin without one in its manifest', () => {
  it('an npm install keeps the package version across reloads and a restart', async () => {
    const routes = createFakeRemoteRoutes()
    routes.npmPackage('claude-notes', { '2.3.4': { files: { 'package.json': JSON.stringify({ name: 'claude-notes', version: '2.3.4' }), ...claudePluginFiles('notes-only') } } })
    const first = await boot(await tempFolder('hf-version-'), routes)
    const inspection = await first.deps.installer.inspect({ source: 'npm', spec: 'claude-notes' })
    expect(inspection).toMatchObject({ format: 'claude', manifest: { id: 'claude-notes', version: '2.3.4' } })
    const installed = await first.deps.installer.install({ source: 'npm', spec: 'claude-notes' }, { sha256: inspection.sha256, authorize: allowAll })
    expect(installed).toMatchObject({ id: 'claude-notes', format: 'claude', source: 'npm', state: 'active', version: '2.3.4', claude: { version: '2.3.4' } })
    expect(await first.deps.plugins.load('claude-notes')).toMatchObject({ version: '2.3.4' })
    expect(await first.deps.plugins.record('claude-notes')).toMatchObject({ version: '2.3.4', sourceRef: 'claude-notes@2.3.4' })

    const second = await restart(first, routes)
    expect(await second.deps.plugins.get('claude-notes')).toMatchObject({ state: 'active', version: '2.3.4', claude: { version: '2.3.4' } })
    expect((await second.deps.plugins.list()).find(plugin => plugin.id === 'claude-notes')).toMatchObject({ version: '2.3.4' })
    expect(await second.deps.plugins.record('claude-notes')).toMatchObject({ version: '2.3.4' })
  })

  it('a marketplace npm entry keeps the resolved npm version (origin.npmVersion) across a restart', async () => {
    const routes = createFakeRemoteRoutes()
    registerClaudeMarketplaceRemote(routes)
    const marketplaceFolder = await tempFolder('hf-version-mkt-')
    await writeFileTree(marketplaceFolder, claudeMarketplaceFiles())
    const first = await boot(await tempFolder('hf-version-'), routes)
    const marketplace = await first.deps.marketplaces.add({ source: { type: 'path', path: marketplaceFolder } })
    const input = { source: 'marketplace', marketplaceId: marketplace.id, plugin: 'npm-plugin' } as const
    const inspection = await first.deps.installer.inspect(input)
    const installed = await first.deps.installer.install(input, { sha256: inspection.sha256, authorize: allowAll })
    expect(installed).toMatchObject({ id: 'npm-plugin', version: '1.0.0', origin: { kind: 'marketplace', npmVersion: '1.0.0' } })
    expect(routes.requests.some(request => request.path.includes(CLAUDE_MARKETPLACE.npmPackage.split('/')[1]!))).toBe(true)

    const second = await restart(first, routes)
    expect(await second.deps.plugins.get('npm-plugin')).toMatchObject({ state: 'active', version: '1.0.0', claude: { version: '1.0.0' } })
    expect(await second.deps.plugins.record('npm-plugin')).toMatchObject({ version: '1.0.0' })
  })

  it('a copied folder without a version stays 0.0.0 (no hint)', async () => {
    const routes = createFakeRemoteRoutes()
    const first = await boot(await tempFolder('hf-version-'), routes)
    const folder = await tempFolder('hf-version-src-')
    await writeFileTree(join(folder, 'notes-only'), claudePluginFiles('notes-only'))
    const installed = await first.deps.installer.install({ source: 'path', path: join(folder, 'notes-only'), mode: 'copy' }, { authorize: allowAll })
    expect(installed).toMatchObject({ id: 'notes-only', version: '0.0.0' })
    const second = await restart(first, routes)
    expect(await second.deps.plugins.get('notes-only')).toMatchObject({ version: '0.0.0', claude: { version: null } })
  })
})
