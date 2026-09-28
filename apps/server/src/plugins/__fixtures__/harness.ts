import type { SecretStore } from '../../services/secrets/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
// Test harness of the plugin host tests: fixture plugins copied into a temporary data directory, the real composition
// (`createTestApp`) with in-memory fakes for the services of other agents (events, secrets, icons), and polling helpers.
import type { BuiltinPlugin } from '../types.ts'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeIconService, createMemorySecretStore, createRecordingEventBus } from '../../testing/fakes.ts'

/** Folder of the committed fixture plugins. */
export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url))

export type FixtureName
  = | 'acme-docs'
    | 'dice-roller'
    | 'word-count'
    | 'throwing-setup'
    | 'hanging-setup'
    | 'incompatible-api'
    | 'stdio-server'
    | 'broken-import'

export function fixturePath(name: FixtureName): string {
  return join(FIXTURES_DIR, name)
}

/** A fresh temporary directory, removed by `removeTempDirs()`. */
const tempDirs: string[] = []
export function tempDir(prefix = 'hf-plugin-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
}

/** Writes `files` (relative path -> content; objects are written as JSON) below `dir`. */
export function writeFiles(dir: string, files: Record<string, string | object>): string {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
  return dir
}

/** A minimal valid manifest (override any field). */
export function manifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { manifestVersion: 1, id, name: `Plugin ${id}`, version: '1.0.0', engines: { harness: '^1.0.0' }, ...extra }
}

export interface InstalledPlugin {
  /** Fixture to copy, or files to write. */
  fixture?: FixtureName
  files?: Record<string, string | object>
  /** Folder name below `data/plugins` (default: the fixture name). */
  id?: string
  /** Pin the current hash in the `plugins` row (code and stdio plugins need it to load). */
  trust?: boolean
  enabled?: boolean
}

export interface PluginTestApp {
  t: TestApp
  dataDir: string
  pluginsDir: string
  events: RecordingEventBus
  secrets: SecretStore
  /** `data/plugins/<id>`. */
  pluginDir: (id: string) => string
  /** Copies / writes a plugin into `data/plugins/<id>` (and pins it) without loading it. */
  install: (plugin: InstalledPlugin) => Promise<string>
  close: () => Promise<void>
}

export interface PluginTestAppOptions {
  env?: Record<string, string | undefined>
  plugins?: InstalledPlugin[]
  /** Default: no builtins, so the tests do not depend on other agents' builtin implementations. */
  builtins?: readonly BuiltinPlugin[]
  /** Run `plugins.start()` (default true). */
  start?: boolean
}

export async function createPluginTestApp(options: PluginTestAppOptions = {}): Promise<PluginTestApp> {
  const dataDir = tempDir('hf-plugin-data-')
  const events = createRecordingEventBus()
  const secrets = createMemorySecretStore()
  const t = await createTestApp({
    dataDir,
    env: options.env,
    start: false,
    builtins: options.builtins ?? [],
    overrides: { events, secrets, icons: createFakeIconService() },
  })
  const pluginsDir = t.env.paths.plugins
  const pluginDir = (id: string): string => join(pluginsDir, id)

  const install = async (plugin: InstalledPlugin): Promise<string> => {
    const id = plugin.id ?? plugin.fixture
    if (!id)
      throw new Error('An installed test plugin needs an id or a fixture.')
    const dir = pluginDir(id)
    if (plugin.fixture)
      cpSync(fixturePath(plugin.fixture), dir, { recursive: true })
    if (plugin.files)
      writeFiles(dir, plugin.files)
    if (plugin.trust || plugin.enabled !== undefined) {
      const inspection = await t.deps.plugins.inspectDirectory(dir)
      await t.deps.plugins.saveRecord({
        id,
        source: 'copy',
        version: inspection.manifest.version,
        ...(plugin.enabled === undefined ? {} : { enabled: plugin.enabled }),
        ...(plugin.trust ? { trustedHash: inspection.sha256 } : {}),
      })
    }
    return dir
  }

  for (const plugin of options.plugins ?? [])
    await install(plugin)
  if (options.start ?? true)
    await t.deps.plugins.start()

  return {
    t,
    dataDir,
    pluginsDir,
    events,
    secrets,
    pluginDir,
    install,
    close: async () => {
      await t.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** Polls `predicate` (real time) until it returns a truthy value; fails after `timeoutMs`. */
export async function waitFor<T>(predicate: () => T | Promise<T>, timeoutMs = 5000, intervalMs = 20): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value)
      return value as NonNullable<T>
    if (Date.now() > deadline)
      throw new Error(`waitFor timed out after ${timeoutMs} ms`)
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
