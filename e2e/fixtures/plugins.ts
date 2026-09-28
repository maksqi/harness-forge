// Plugin fixtures of the e2e suite (W3.6-T1). Each folder of `e2e/fixtures/plugins/` is a plugin source whose folder
// name is the plugin id; specs zip them at test time (`fixtureZip`) or send the manifest to `POST /api/plugins`
// (`fixtureManifest`), after pointing the providers at the mock OpenAI server of the spec (`withBaseURL`).
//
//   e2e-zip-provider  declarative: one OpenAI-compatible provider (bearer key, one tools-capable model) + a command
//   e2e-zip-code      code: one `safe` tool (`e2e_zip_code_ping`), installed with trust
//   e2e-tools-llm     declarative, keyless: the model that calls tools in the code plugin and MCP specs
import type { Buffer } from 'node:buffer'
import type { ZipEntry } from './zip.ts'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZip } from './zip.ts'

export const FIXTURES_DIR = fileURLToPath(new URL('.', import.meta.url))
export const PLUGIN_FIXTURES_DIR = join(FIXTURES_DIR, 'plugins')
/** Absolute path of the stdio MCP echo server (`node <path>`). */
export const MCP_ECHO_SERVER_PATH = join(FIXTURES_DIR, 'mcp-echo-server.mjs')

export type FixturePluginId = 'e2e-zip-provider' | 'e2e-zip-code' | 'e2e-tools-llm'

export interface FixtureProvider {
  id: string
  name: string
  baseURL: string
  [key: string]: unknown
}

/** A plugin manifest as plain JSON; only the fields the specs change are typed. */
export interface FixtureManifest {
  id: string
  name: string
  version: string
  contributes?: {
    providers?: FixtureProvider[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface FixtureOptions {
  /** Changes the manifest (a fresh copy) before it is used. */
  manifest?: (manifest: FixtureManifest) => void
  /** Wraps every file in one top-level folder, like a zipped folder (the installer unwraps it). */
  folder?: string
  /** Entries added as given, e.g. `{ name: '../evil.txt', data: '...' }`. */
  extraEntries?: readonly ZipEntry[]
}

const MANIFEST = 'plugin.json'

function fixtureDir(id: FixturePluginId): string {
  return join(PLUGIN_FIXTURES_DIR, id)
}

/** Relative POSIX paths of the files of a fixture, sorted. */
function fixtureFiles(id: FixturePluginId): string[] {
  const dir = fixtureDir(id)
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map(path => path.split('\\').join('/'))
    .filter(path => statSync(join(dir, path)).isFile())
    .sort()
}

/** The manifest of a fixture, optionally changed by `edit`. */
export function fixtureManifest(id: FixturePluginId, edit?: (manifest: FixtureManifest) => void): FixtureManifest {
  const manifest = JSON.parse(readFileSync(join(fixtureDir(id), MANIFEST), 'utf8')) as FixtureManifest
  edit?.(manifest)
  return manifest
}

/** A manifest edit that points every provider at `baseURL` (the mock OpenAI server of a spec). */
export function withBaseURL(baseURL: string): (manifest: FixtureManifest) => void {
  return (manifest) => {
    for (const provider of manifest.contributes?.providers ?? [])
      provider.baseURL = baseURL
  }
}

/**
 * A manifest edit that renames a fixture plugin: new plugin id and name, and provider ids that follow the plugin id
 * (`<pluginId>` or `<pluginId>-<suffix>`, PLUGINS.md 14). Commands are dropped (their names are global).
 */
export function withPluginId(id: string, name: string): (manifest: FixtureManifest) => void {
  return (manifest) => {
    const previous = manifest.id
    manifest.id = id
    manifest.name = name
    for (const provider of manifest.contributes?.providers ?? [])
      provider.id = `${id}${provider.id.slice(previous.length)}`
    if (manifest.contributes)
      delete manifest.contributes.commands
  }
}

/** The zip of a fixture plugin (see `FixtureOptions`). */
export function fixtureZip(id: FixturePluginId, options: FixtureOptions = {}): Buffer {
  const prefix = options.folder === undefined ? '' : `${options.folder}/`
  const entries: ZipEntry[] = fixtureFiles(id).map((path) => {
    const data = path === MANIFEST
      ? `${JSON.stringify(fixtureManifest(id, options.manifest), null, 2)}\n`
      : readFileSync(join(fixtureDir(id), path))
    return { name: `${prefix}${path}`, data }
  })
  return createZip([...entries, ...(options.extraEntries ?? [])])
}
