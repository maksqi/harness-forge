// Environment variables (DECISIONS.md "Environment variables"): parsed once at boot into a frozen `Env`, after the
// optional `<workspace root>/.env` file was loaded (`loadDotEnvFile`; variables already set win). Owned by W1.1 after
// Phase 0 (bind safety with a stored password is enforced in `main.ts`); `HF_TRUST_PROXY` by W5.7 (ADR-026).
import type { LogLevel } from './logger.ts'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { findWorkspaceRoot, serverPackageRoot } from './paths.ts'
import { parseTrustProxy } from './security/proxy-trust.ts'

/** Every path inside the data directory (DECISIONS.md "Data directory", ARCHITECTURE.md 7). */
export interface DataPaths {
  /** `HF_DATA_DIR`, absolute. */
  readonly root: string
  /** SQLite database (WAL). */
  readonly db: string
  /** Master key file when `HF_MASTER_KEY` is unset (mode 0600). */
  readonly secretKey: string
  /** Installed plugins: `plugins/<id>/`. */
  readonly plugins: string
  /** In-progress installs and `.prev` copies: `plugins/.staging/`. */
  readonly pluginStaging: string
  /** Plugin private data: `plugins/.data/<id>/` (`ctx.plugin.dataDir`). */
  readonly pluginData: string
  /** Uploaded attachments: `files/<aa>/<sha256>`. */
  readonly files: string
  /** models.dev refreshes and misc caches. */
  readonly cache: string
  /** Compiled `.ts` code plugins: `cache/plugins/<id>/<sha256>.mjs`. */
  readonly pluginCache: string
}

export interface Env {
  /** `HF_PORT` (default 8787; 0 = any free port). */
  readonly port: number
  /** `HF_HOST` (default `127.0.0.1`). */
  readonly host: string
  /** `HF_DATA_DIR` resolved to an absolute path (relative paths: against the workspace root, else the cwd). */
  readonly dataDir: string
  readonly paths: DataPaths
  /** `HF_PASSWORD`; overrides a stored password. */
  readonly password: string | null
  /** `HF_MASTER_KEY`: base64 of exactly 32 bytes (decoded by the keyring). */
  readonly masterKey: string | null
  /** `HF_MOCK_PROVIDER=1`: register the dev-only `mock` builtin. */
  readonly mockProvider: boolean
  /** `HF_SAFE_MODE=1`: load builtin plugins only. */
  readonly safeMode: boolean
  /** `HF_PLUGIN_WATCH=1`: hot-reload code plugins in `data/plugins` on file change. */
  readonly pluginWatch: boolean
  /** `HF_OFFLINE=1`: never refresh the models.dev snapshot over the network. */
  readonly offline: boolean
  /**
   * `HF_INSECURE=1`: allow a non-loopback bind without a password, and (still without a password) requests addressed
   * to host names other than localhost / loopback IPs, which are otherwise refused as DNS rebinding
   * (`http/middleware/session-auth.ts`).
   */
  readonly insecure: boolean
  /**
   * `HF_TRUST_PROXY` (ADR-026): the trusted reverse proxies as canonical entries (`loopback`, `private`, IP addresses,
   * CIDR ranges; `security/proxy-trust.ts`), or null when unset (the v1 behavior: `X-Forwarded-For` is never read,
   * `X-Forwarded-Proto` is honored from any peer). Read through the helpers of `http/middleware/request-info.ts`.
   */
  readonly trustProxy: readonly string[] | null
  /** `HF_API_TARGET`: proxy target of `nuxt dev` (unused by the server, kept for completeness). */
  readonly apiTarget: string
  /**
   * `HF_WEB_DIR`: directory of the generated SPA served by the server (absolute; relative paths resolve like
   * `HF_DATA_DIR`), or null for the default `apps/web/.output/public` (`webPublicDir()` of `paths.ts`).
   */
  readonly webDir: string | null
  /**
   * Development mode: `NODE_ENV=development`, or no `NODE_ENV` and running from TypeScript sources (tsx, Vitest).
   * Enables the `:3000` dev origins in the Origin check and `debug` logging.
   */
  readonly dev: boolean
  /** `debug` in development, `info` in production. */
  readonly logLevel: LogLevel
  /**
   * The raw environment the values were read from. Provider key fallbacks (`CredentialField.envVar`, e.g.
   * `ANTHROPIC_API_KEY`) are read from here, never from `process.env` directly, so tests can inject them.
   */
  readonly vars: Readonly<Record<string, string | undefined>>
}

/** Invalid environment: `main.ts` prints the message and exits with code 1. */
export class EnvError extends Error {
  override readonly name = 'EnvError'
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

const flagSchema = z
  .string()
  .transform((value, ctx) => {
    const normalized = value.trim().toLowerCase()
    if (TRUE_VALUES.has(normalized))
      return true
    if (!FALSE_VALUES.has(normalized))
      ctx.addIssue({ code: 'custom', message: 'Use 1 (on) or 0 (off).' })
    return false
  })
  .default(false)

const portSchema = z
  .string()
  .regex(/^\s*\d{1,5}\s*$/, 'Expected a port number.')
  .transform(Number)
  .pipe(z.int().min(0, 'Expected a port number.').max(65_535, 'Expected a port number (0-65535).'))
  .default(8787)

const masterKeySchema = z
  .string()
  .refine((value) => {
    const trimmed = value.trim()
    return /^[\w+/-]+={0,2}$/.test(trimmed) && Buffer.from(trimmed, 'base64').length === 32
  }, 'Expected the base64 encoding of exactly 32 bytes.')
  .optional()

/** `HF_TRUST_PROXY`: `1`, `true`, hop counts, `/0` ranges and unknown tokens are refused with the format explained. */
const trustProxySchema = z
  .string()
  .transform((value, ctx) => {
    const parsed = parseTrustProxy(value)
    if (parsed.ok)
      return parsed.entries
    ctx.addIssue({ code: 'custom', message: parsed.message })
    return z.NEVER
  })
  .optional()

const envSchema = z.object({
  HF_PORT: portSchema,
  HF_HOST: z.string().trim().min(1).default('127.0.0.1'),
  HF_DATA_DIR: z.string().trim().min(1).default('./data'),
  HF_PASSWORD: z.string().min(1).max(1024).optional(),
  HF_MASTER_KEY: masterKeySchema,
  HF_MOCK_PROVIDER: flagSchema,
  HF_SAFE_MODE: flagSchema,
  HF_PLUGIN_WATCH: flagSchema,
  HF_OFFLINE: flagSchema,
  HF_INSECURE: flagSchema,
  HF_TRUST_PROXY: trustProxySchema,
  HF_API_TARGET: z.url({ protocol: /^https?$/ }).default('http://localhost:8787'),
  HF_WEB_DIR: z.string().trim().min(1).optional(),
  NODE_ENV: z.string().optional(),
})

export interface LoadEnvOptions {
  /** Base for a relative `HF_DATA_DIR` when no workspace root is found; default `process.cwd()`. */
  cwd?: string
  /** Overrides the development-mode detection (tests). */
  dev?: boolean
}

function runningFromSource(): boolean {
  return import.meta.url.endsWith('.ts')
}

/** Absolute data directory: relative paths resolve against the workspace root (dev), else `cwd`. */
export function resolveDataDir(value: string, cwd: string): string {
  if (isAbsolute(value))
    return resolve(value)
  return resolve(findWorkspaceRoot(cwd) ?? cwd, value)
}

export function dataPaths(root: string): DataPaths {
  const plugins = join(root, 'plugins')
  const cache = join(root, 'cache')
  return Object.freeze({
    root,
    db: join(root, 'harness.db'),
    secretKey: join(root, 'secret.key'),
    plugins,
    pluginStaging: join(plugins, '.staging'),
    pluginData: join(plugins, '.data'),
    files: join(root, 'files'),
    cache,
    pluginCache: join(cache, 'plugins'),
  })
}

/**
 * Parses and validates the environment (empty values count as unset). Throws `EnvError` listing every invalid
 * variable. Does not touch the filesystem (see `ensureDataDir`).
 */
export function loadEnv(source: Record<string, string | undefined> = process.env, options: LoadEnvOptions = {}): Env {
  const input: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '')
      input[key] = value
  }
  const parsed = envSchema.safeParse(input)
  if (!parsed.success) {
    const lines = parsed.error.issues.map(issue => `${issue.path.join('.') || 'env'}: ${issue.message}`)
    throw new EnvError(`Invalid environment. ${lines.join(' ')}`)
  }
  const values = parsed.data
  const nodeEnv = values.NODE_ENV
  const dev = options.dev ?? (nodeEnv === 'production' ? false : nodeEnv === 'development' ? true : runningFromSource())
  const cwd = options.cwd ?? process.cwd()
  const dataDir = resolveDataDir(values.HF_DATA_DIR, cwd)
  return Object.freeze({
    port: values.HF_PORT,
    host: values.HF_HOST,
    dataDir,
    paths: dataPaths(dataDir),
    password: values.HF_PASSWORD ?? null,
    masterKey: values.HF_MASTER_KEY?.trim() ?? null,
    mockProvider: values.HF_MOCK_PROVIDER,
    safeMode: values.HF_SAFE_MODE,
    pluginWatch: values.HF_PLUGIN_WATCH,
    offline: values.HF_OFFLINE,
    insecure: values.HF_INSECURE,
    trustProxy: values.HF_TRUST_PROXY ?? null,
    apiTarget: values.HF_API_TARGET,
    webDir: values.HF_WEB_DIR === undefined ? null : resolveDataDir(values.HF_WEB_DIR, cwd),
    dev,
    logLevel: dev ? 'debug' : 'info',
    vars: Object.freeze({ ...source }),
  })
}

/** Creates the data directory (mode 0700) and its fixed subdirectories. Idempotent. */
export function ensureDataDir(env: Pick<Env, 'paths'>): void {
  const { paths } = env
  mkdirSync(paths.root, { recursive: true, mode: 0o700 })
  for (const dir of [paths.plugins, paths.pluginStaging, paths.files, paths.cache, paths.pluginCache])
    mkdirSync(dir, { recursive: true, mode: 0o755 })
  mkdirSync(paths.pluginData, { recursive: true, mode: 0o700 })
}

/** `127.0.0.0/8`, `::1` and `localhost` (ARCHITECTURE.md 10.1 "Bind safety"). */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value)
}

/**
 * Bind safety: a non-loopback `HF_HOST` needs a password (`HF_PASSWORD`, or a stored one when the caller knows it)
 * or `HF_INSECURE=1`. Returns the reason to refuse the boot, or null.
 */
export function bindSafetyError(env: Pick<Env, 'host' | 'password' | 'insecure'>, options: { storedPassword?: boolean } = {}): string | null {
  if (isLoopbackHost(env.host) || env.insecure || env.password !== null || options.storedPassword === true)
    return null
  return `Refusing to listen on ${env.host} without a password: set HF_PASSWORD (or set a password in Settings while `
    + `bound to 127.0.0.1), bind to 127.0.0.1, or set HF_INSECURE=1 (not recommended).`
}

/** `<workspace root>/.env` of the server package (the current directory's `.env` outside a workspace). */
export function defaultEnvFile(cwd: string = process.cwd()): string {
  let root: string | null = null
  try {
    root = findWorkspaceRoot(serverPackageRoot())
  }
  catch {
    // Not inside the server package layout (unusual bundling): fall back to the current directory.
  }
  return join(root ?? cwd, '.env')
}

/**
 * Loads a `.env` file into `process.env` with `process.loadEnvFile` when it exists; variables that are already set
 * (even to an empty value) win. Returns the loaded path, or null when there is no file. Throws when the file exists
 * but cannot be read.
 */
export function loadDotEnvFile(file: string = defaultEnvFile()): string | null {
  if (!existsSync(file))
    return null
  process.loadEnvFile(file)
  return file
}
