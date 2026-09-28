// npm source (PLUGINS.md 12 "Sources"): package spec -> registry metadata (`registry.npmjs.org`) -> version (exact,
// dist-tag or semver range) -> tarball from the same registry origin -> `dist.integrity` (sha512) verified before the
// tarball is decompressed. Only the tarball's files are used: `dependencies` are ignored and lifecycle scripts never
// run (nothing is executed; the host loads the plugin like any other).
import type { InstallLimits } from './errors.ts'
import semver from 'semver'
import { z } from 'zod'
import { cappedFetch } from './download.ts'
import { invalid, upstreamError } from './errors.ts'
import { parseIntegrity, verifyIntegrity } from './integrity.ts'

export const NPM_REGISTRY_URL = 'https://registry.npmjs.org'

/** Timeouts of the registry metadata request and of the tarball download. */
const METADATA_TIMEOUT_MS = 20_000
const TARBALL_TIMEOUT_MS = 60_000
const MAX_MESSAGE_CHARS = 200
const TAG_PATTERN = /^[a-z\d][\w.-]{0,127}$/i

export interface NpmSpec {
  /** `name` or `@scope/name`. */
  name: string
  /** Version, dist-tag or range; null = the `latest` dist-tag. */
  selector: string | null
}

/** Splits a spec validated by `pluginInstallSourceSchema` (`name`, `@scope/name`, `name@1.2.3`, `name@^1`, `name@tag`). */
export function parseNpmSpec(spec: string): NpmSpec {
  const trimmed = spec.trim()
  const at = trimmed.indexOf('@', trimmed.startsWith('@') ? 1 : 0)
  if (at < 0)
    return { name: trimmed, selector: null }
  const selector = trimmed.slice(at + 1).trim()
  return { name: trimmed.slice(0, at), selector: selector === '' ? null : selector }
}

/** The metadata URL of a package: `@scope/name` keeps `@` and encodes `/` (as the npm CLI does). */
export function packageMetadataUrl(registry: string, name: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(name).replace(/^%40/, '@')}`
}

const versionManifestSchema = z.object({
  version: z.string(),
  dist: z.object({
    tarball: z.string(),
    integrity: z.string().optional(),
  }),
  deprecated: z.unknown().optional(),
  hasInstallScript: z.boolean().optional(),
  scripts: z.record(z.string(), z.unknown()).optional(),
})
type VersionManifest = z.infer<typeof versionManifestSchema>

const packumentSchema = z.object({
  'name': z.string().optional(),
  'dist-tags': z.record(z.string(), z.string()).optional(),
  'versions': z.record(z.string(), z.unknown()),
})

export interface NpmResolution {
  name: string
  version: string
  tarball: string
  integrity: string
  /** Notes for the inspection warnings (deprecation, install scripts that are never run). */
  warnings: string[]
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS)}...` : flat
}

/** Picks the version a selector names (npm semantics: version, then range, then dist-tag; default `latest`). */
export function resolveVersion(metadata: unknown, spec: NpmSpec): string {
  const parsed = packumentSchema.safeParse(metadata)
  if (!parsed.success)
    throw upstreamError('provider_error', `The npm registry returned unreadable metadata for "${spec.name}".`)
  const versions = Object.keys(parsed.data.versions).filter(version => semver.valid(version) !== null)
  const tags = parsed.data['dist-tags'] ?? {}
  const selector = spec.selector ?? 'latest'
  const notFound = (): never => {
    throw upstreamError('not_found', spec.selector === null
      ? `The npm package "${spec.name}" has no latest version.`
      : `The npm package "${spec.name}" has no version matching "${clip(selector)}".`, 404)
  }

  const exact = semver.valid(selector)
  if (exact !== null)
    return versions.includes(exact) ? exact : notFound()
  if (semver.validRange(selector) !== null && !Object.hasOwn(tags, selector)) {
    const latest = tags.latest
    if (latest !== undefined && versions.includes(latest) && semver.satisfies(latest, selector))
      return latest
    return semver.maxSatisfying(versions, selector) ?? notFound()
  }
  if (!TAG_PATTERN.test(selector))
    throw invalid(`"${clip(selector)}" is not a version, range or dist-tag.`, ['spec'])
  const tagged = Object.hasOwn(tags, selector) ? tags[selector] : undefined
  return tagged !== undefined && versions.includes(tagged) ? tagged : notFound()
}

function versionManifest(metadata: unknown, version: string, name: string): VersionManifest {
  const raw = (metadata as { versions?: Record<string, unknown> }).versions?.[version]
  const parsed = versionManifestSchema.safeParse(raw)
  if (!parsed.success || parsed.data.version !== version)
    throw upstreamError('provider_error', `The npm registry returned unreadable metadata for "${name}@${version}".`)
  return parsed.data
}

/** Registry metadata -> the version to install, its tarball URL (same origin as the registry) and its sha512. */
export function resolvePackage(metadata: unknown, spec: NpmSpec, registry: string): NpmResolution {
  const version = resolveVersion(metadata, spec)
  const manifest = versionManifest(metadata, version, spec.name)
  const label = `${spec.name}@${version}`

  let tarball: URL
  try {
    tarball = new URL(manifest.dist.tarball)
  }
  catch {
    throw upstreamError('provider_error', `The npm registry returned an invalid tarball URL for ${label}.`)
  }
  if (tarball.origin !== new URL(registry).origin || tarball.username !== '' || tarball.password !== '')
    throw upstreamError('provider_error', `The tarball of ${label} is not served by ${new URL(registry).host}.`)

  const integrity = manifest.dist.integrity ?? ''
  if (parseIntegrity(integrity, ['sha512']).length === 0)
    throw invalid(`${label} has no sha512 integrity in the registry, so it cannot be verified.`, ['spec'])

  const warnings: string[] = []
  if (typeof manifest.deprecated === 'string' && manifest.deprecated.trim() !== '')
    warnings.push(`Deprecated on npm: ${clip(manifest.deprecated)}`)
  const scripts = manifest.scripts ?? {}
  if (manifest.hasInstallScript === true || ['preinstall', 'install', 'postinstall'].some(name => Object.hasOwn(scripts, name)))
    warnings.push('The package declares install scripts; they are never run.')
  return { name: spec.name, version, tarball: tarball.href, integrity, warnings }
}

export interface NpmDownloadOptions {
  fetch: typeof globalThis.fetch
  registry: string
  limits: Pick<InstallLimits, 'compressedBytes' | 'metadataBytes'>
}

export interface NpmDownload {
  resolution: NpmResolution
  /** The verified tarball (gzipped tar). */
  tarball: Uint8Array
}

/** Resolves `spec` on the registry and downloads the verified tarball. */
export async function downloadNpmPackage(specText: string, options: NpmDownloadOptions): Promise<NpmDownload> {
  const spec = parseNpmSpec(specText)
  const registryHost = new URL(options.registry).host
  const metadataResponse = await cappedFetch(options.fetch, packageMetadataUrl(options.registry, spec.name), {
    maxBytes: options.limits.metadataBytes,
    timeoutMs: METADATA_TIMEOUT_MS,
    headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
    what: 'the npm registry',
  })
  if (metadataResponse.status === 404)
    throw upstreamError('not_found', `The npm package "${spec.name}" was not found on ${registryHost}.`, 404)
  if (metadataResponse.status !== 200)
    throw upstreamError('provider_error', `The npm registry answered HTTP ${metadataResponse.status} for "${spec.name}".`, metadataResponse.status)
  let metadata: unknown
  try {
    metadata = JSON.parse(new TextDecoder().decode(metadataResponse.body)) as unknown
  }
  catch {
    throw upstreamError('provider_error', `The npm registry returned invalid JSON for "${spec.name}".`)
  }

  const resolution = resolvePackage(metadata, spec, options.registry)
  const label = `${resolution.name}@${resolution.version}`
  const tarballResponse = await cappedFetch(options.fetch, resolution.tarball, {
    maxBytes: options.limits.compressedBytes,
    timeoutMs: TARBALL_TIMEOUT_MS,
    headers: { accept: 'application/octet-stream' },
    what: `the tarball of ${label}`,
  })
  if (tarballResponse.status === 404)
    throw upstreamError('not_found', `The tarball of ${label} was not found on ${registryHost}.`, 404)
  if (tarballResponse.status !== 200)
    throw upstreamError('provider_error', `The npm registry answered HTTP ${tarballResponse.status} for the tarball of ${label}.`, tarballResponse.status)
  if (!verifyIntegrity(tarballResponse.body, resolution.integrity, ['sha512']))
    throw invalid(`The tarball of ${label} does not match its published sha512 integrity.`, ['spec'])
  return { resolution, tarball: tarballResponse.body }
}
