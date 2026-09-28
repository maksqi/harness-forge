// Test helpers of the installer (not app code): archive builders (fflate zips, hand-written tar and stored zips for
// malformed cases), plugin file sets, a fake npm registry behind a fake `fetch`, a fake `SafeFetch`, and an in-process
// app whose installer uses them. Nothing here touches the network.
import type { ZipOptions, Zippable } from 'fflate'
import type { SafeFetch, SafeFetchOptions } from '../../security/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { BuiltinPlugin } from '../types.ts'
import type { InstallerOptions } from './index.ts'
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { crc32, gzipSync } from 'node:zlib'
import { HarnessError } from '@harness-forge/shared'
import { zipSync } from 'fflate'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeIconService, createMemorySecretStore, createRecordingEventBus } from '../../testing/fakes.ts'
import { createInstaller } from './index.ts'
import { integrityOf } from './integrity.ts'

// ---------- plugin files ----------

export type FileSet = Record<string, string | Uint8Array>

export function manifestOf(id: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ manifestVersion: 1, id, name: `Plugin ${id}`, version: '1.0.0', engines: { harness: '^1.0.0' }, ...extra }, null, 2)}\n`
}

/** A declarative plugin with one OpenAI-compatible provider. */
export function declarativePlugin(id: string, extra: Record<string, unknown> = {}): FileSet {
  return {
    'plugin.json': manifestOf(id, {
      contributes: {
        providers: [{ id, name: `Provider ${id}`, baseURL: 'https://api.example.com/v1', apiFormat: 'openai-chat', listModels: false, models: [{ id: 'model-a' }] }],
      },
      ...extra,
    }),
  }
}

/**
 * A code plugin whose `setup` counts its runs in `globalThis.__hfInstallTest[id]` (so tests can prove that untrusted
 * code never ran), or throws when `fail` is set.
 */
export function codePlugin(id: string, options: { version?: string, fail?: boolean, marker?: string } = {}): FileSet {
  const body = options.fail
    ? `throw new Error('setup failed on purpose')`
    : `const runs = (globalThis.__hfInstallTest ??= {}); runs[${JSON.stringify(id)}] = (runs[${JSON.stringify(id)}] ?? 0) + 1`
  return {
    'plugin.json': manifestOf(id, { version: options.version ?? '1.0.0', main: 'index.mjs', permissions: ['storage'] }),
    'index.mjs': `// ${options.marker ?? 'v1'}\nexport default {\n  setup() {\n    ${body}\n  },\n}\n`,
  }
}

/** How often the code plugin `id` ran its `setup` in this process. */
export function setupRuns(id: string): number {
  const runs = (globalThis as { __hfInstallTest?: Record<string, number> }).__hfInstallTest
  return runs?.[id] ?? 0
}

/** A declarative plugin that declares a stdio MCP server (requires trust). */
export function stdioPlugin(id: string): FileSet {
  return {
    'plugin.json': manifestOf(id, {
      permissions: ['process'],
      contributes: { mcpServers: [{ id, name: 'Echo', transport: { type: 'stdio', command: 'node', args: ['server.mjs'] } }] },
    }),
  }
}

/** Prefixes every path of `files` with `folder/`. */
export function inFolder(folder: string, files: FileSet): FileSet {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [`${folder}/${path}`, content]))
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content
}

// ---------- zip (fflate) ----------

export type ZipInput = Record<string, string | Uint8Array | [string | Uint8Array, ZipOptions]>

/** A zip built by fflate; names are written verbatim (fflate does not sanitize them). */
export function zipOf(files: ZipInput): Uint8Array {
  const zippable: Zippable = {}
  for (const [name, value] of Object.entries(files))
    zippable[name] = Array.isArray(value) ? [bytesOf(value[0]), value[1]] : bytesOf(value)
  return zipSync(zippable, { level: 6, mtime: new Date(Date.UTC(2024, 0, 1)) })
}

/** Unix mode attributes of a zip entry (`os: 3`). */
export function unixMode(mode: number): ZipOptions {
  return { os: 3, attrs: (mode << 16) >>> 0 }
}

interface CentralRecord {
  offset: number
}

/** Offsets of the central directory headers of a zip (EOCD without comment). */
export function centralRecords(zip: Uint8Array): CentralRecord[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.byteLength - 22
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const records: CentralRecord[] = []
  for (let index = 0; index < count; index++) {
    records.push({ offset })
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
  return records
}

/** A copy of `zip` with `patch` applied to the central header `index` (and optionally to the bytes). */
export function patchZip(zip: Uint8Array, patch: (view: DataView, central: number, bytes: Uint8Array) => void, index = 0): Uint8Array {
  const copy = zip.slice()
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  patch(view, centralRecords(copy)[index]!.offset, copy)
  return copy
}

// ---------- zip (hand-written, stored entries) ----------

export interface StoredZipEntry {
  name: string
  data: Uint8Array
  /** Local header offset written into the central record (default: where the entry was written). */
  localOffset?: number
  /** Skip writing the local header and data (the central record points elsewhere). */
  centralOnly?: boolean
}

/** A zip of stored (uncompressed) entries whose central records may point anywhere (overlap tests). */
export function storedZip(entries: StoredZipEntry[]): Uint8Array {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data) >>> 0
    const localOffset = entry.localOffset ?? offset
    if (!entry.centralOnly) {
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034B50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(0, 8)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(entry.data.length, 18)
      local.writeUInt32LE(entry.data.length, 22)
      local.writeUInt16LE(name.length, 26)
      parts.push(local, name, Buffer.from(entry.data))
      offset += 30 + name.length + entry.data.length
    }
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014B50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(entry.data.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(localOffset, 42)
    central.push(record, name)
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...parts, directory, end]))
}

/** A 30-byte local header + name + stored data (to embed inside another entry). */
export function localRecord(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = Buffer.from(name, 'utf8')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034B50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt32LE(crc32(data) >>> 0, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  return new Uint8Array(Buffer.concat([local, nameBytes, Buffer.from(data)]))
}

// ---------- tar ----------

export interface TarEntry {
  name: string
  /** ustar type flag: '0' file (default), '5' directory, '2' symlink, '1' hard link, '3' char device, '6' FIFO, 'S' sparse. */
  type?: string
  data?: string | Uint8Array
  linkname?: string
  /** Declared size (default: the data length). */
  size?: number
  /** Write the name through a PAX `path` record (long names). */
  pax?: boolean
}

function tarHeader(name: string, type: string, size: number, linkname: string): Buffer {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, 100, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  header.write('14567342000\0', 136)
  header.write('        ', 148)
  header.write(type, 156)
  header.write(linkname, 157, 100, 'utf8')
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header)
    sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

function padded(data: Uint8Array): Buffer[] {
  const rest = data.length % 512
  return rest === 0 ? [Buffer.from(data)] : [Buffer.from(data), Buffer.alloc(512 - rest)]
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (`${length}${body}`.length !== length)
    length = `${length}${body}`.length
  return `${length}${body}`
}

/** A plain ustar archive (entries written verbatim, including malicious names and types). */
export function tarOf(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const data = entry.data === undefined ? new Uint8Array(0) : bytesOf(entry.data)
    const type = entry.type ?? '0'
    if (entry.pax) {
      const record = Buffer.from(paxRecord('path', entry.name), 'utf8')
      parts.push(tarHeader('PaxHeader', 'x', record.length, ''), ...padded(record))
    }
    parts.push(tarHeader(entry.pax ? 'placeholder' : entry.name, type, entry.size ?? data.length, entry.linkname ?? ''), ...padded(data))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export function tgzOf(entries: TarEntry[]): Uint8Array {
  return new Uint8Array(gzipSync(tarOf(entries)))
}

/** An npm-style tarball: every file below `package/`. */
export function npmTarball(files: FileSet): Uint8Array {
  return tgzOf(Object.entries(files).map(([path, data]) => ({ name: `package/${path}`, data })))
}

// ---------- fake npm registry ----------

export const FAKE_REGISTRY = 'https://registry.test'

export interface FakePackageVersion {
  files?: FileSet
  /** Raw tarball (overrides `files`). */
  tarball?: Uint8Array
  /** Published integrity (default: the sha512 of the tarball). */
  integrity?: string | null
  /** Tarball URL override. */
  tarballUrl?: string
  deprecated?: string
  hasInstallScript?: boolean
}

export interface FakeRegistry {
  fetch: typeof globalThis.fetch
  /** Every requested URL. */
  requests: string[]
}

/** A registry served by a fake `fetch`: `packages[name].versions[version]`, `packages[name].tags`. */
export function createFakeRegistry(packages: Record<string, { versions: Record<string, FakePackageVersion>, tags?: Record<string, string> }>): FakeRegistry {
  const requests: string[] = []
  const tarballs = new Map<string, Uint8Array>()
  const documents = new Map<string, unknown>()
  for (const [name, pkg] of Object.entries(packages)) {
    const versions: Record<string, unknown> = {}
    for (const [version, spec] of Object.entries(pkg.versions)) {
      const tarball = spec.tarball ?? npmTarball(spec.files ?? {})
      const url = spec.tarballUrl ?? `${FAKE_REGISTRY}/${name}/-/${name.split('/').pop()}-${version}.tgz`
      tarballs.set(url, tarball)
      versions[version] = {
        name,
        version,
        dist: { tarball: url, ...(spec.integrity === null ? {} : { integrity: spec.integrity ?? integrityOf(tarball) }) },
        ...(spec.deprecated === undefined ? {} : { deprecated: spec.deprecated }),
        ...(spec.hasInstallScript === undefined ? {} : { hasInstallScript: spec.hasInstallScript }),
      }
    }
    const tags = pkg.tags ?? { latest: Object.keys(pkg.versions).at(-1)! }
    documents.set(`${FAKE_REGISTRY}/${encodeURIComponent(name).replace(/^%40/, '@')}`, { 'name': name, 'dist-tags': tags, versions })
  }
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push(url)
    const document = documents.get(url)
    if (document !== undefined)
      return new Response(JSON.stringify(document), { status: 200, headers: { 'content-type': 'application/json' } })
    const tarball = tarballs.get(url)
    if (tarball !== undefined)
      return new Response(Buffer.from(tarball), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    return new Response('{"error":"Not found"}', { status: 404 })
  }
  return { fetch: fetchImpl, requests }
}

// ---------- fake SafeFetch ----------

export interface FakeSafeFetch {
  safeFetch: SafeFetch
  calls: Array<{ url: string, options: SafeFetchOptions }>
}

/** Serves `routes[url]` (bytes, or a status), refuses everything else like the SSRF guard would. */
export function createFakeSafeFetch(routes: Record<string, Uint8Array | number>): FakeSafeFetch {
  const calls: Array<{ url: string, options: SafeFetchOptions }> = []
  const safeFetch: SafeFetch = async (url, options) => {
    calls.push({ url, options })
    const route = routes[url]
    if (route === undefined)
      throw new HarnessError({ code: 'validation_error', message: 'The host resolves to a private address.' })
    if (typeof route === 'number')
      return { url, status: route, headers: new Headers(), body: new Uint8Array(0) }
    if (route.byteLength > options.maxBytes)
      throw new HarnessError({ code: 'payload_too_large', message: 'Too large.', details: { limitBytes: options.maxBytes } })
    return { url, status: 200, headers: new Headers({ 'content-type': 'application/octet-stream' }), body: route }
  }
  return { safeFetch, calls }
}

// ---------- folders and the app ----------

const tempDirs: string[] = []

export function tempDir(prefix = 'hf-install-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
}

/** Writes `files` below `dir` and returns `dir`. */
export function writeFileSet(dir: string, files: FileSet): string {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

export interface InstallTestApp {
  t: TestApp
  events: RecordingEventBus
  /** `data/plugins`. */
  pluginsDir: string
  /** `data/plugins/.staging`. */
  stagingDir: string
  close: () => Promise<void>
}

export interface InstallTestAppOptions {
  env?: Record<string, string | undefined>
  installer?: InstallerOptions
  /** Run `plugins.start()` (default true). */
  start?: boolean
  dataDir?: string
  /** Default: none. */
  builtins?: readonly BuiltinPlugin[]
}

/** The real composition (builtins optional), with fakes for events / secrets / icons and an injectable installer. */
export async function createInstallTestApp(options: InstallTestAppOptions = {}): Promise<InstallTestApp> {
  const events = createRecordingEventBus()
  const t = await createTestApp({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    env: options.env,
    start: false,
    builtins: options.builtins ?? [],
    overrides: { events, secrets: createMemorySecretStore(), icons: createFakeIconService() },
    factories: { installer: deps => createInstaller(deps, options.installer) },
  })
  if (options.start ?? true) {
    await t.deps.installer.recover()
    await t.deps.plugins.start()
  }
  return {
    t,
    events,
    pluginsDir: t.env.paths.plugins,
    stagingDir: t.env.paths.pluginStaging,
    close: () => t.close(),
  }
}

/** An `authorize` that accepts everything (service tests; the route adds fresh auth). */
export function allowAll(): void {}
