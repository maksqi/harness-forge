import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSafetyError, defaultEnvFile, ensureDataDir, EnvError, isLoopbackHost, loadDotEnvFile, loadEnv } from './env.ts'
import { findWorkspaceRoot, serverPackageRoot } from './paths.ts'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-env-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('loadEnv', () => {
  it('applies the documented defaults', () => {
    const cwd = tempDir()
    const env = loadEnv({}, { cwd })
    expect(env).toMatchObject({
      port: 8787,
      host: '127.0.0.1',
      dataDir: join(cwd, 'data'),
      password: null,
      masterKey: null,
      mockProvider: false,
      safeMode: false,
      pluginWatch: false,
      offline: false,
      insecure: false,
      apiTarget: 'http://localhost:8787',
      webDir: null,
    })
    expect(env.paths).toMatchObject({
      db: join(cwd, 'data', 'harness.db'),
      secretKey: join(cwd, 'data', 'secret.key'),
      pluginStaging: join(cwd, 'data', 'plugins', '.staging'),
      pluginData: join(cwd, 'data', 'plugins', '.data'),
      files: join(cwd, 'data', 'files'),
      pluginCache: join(cwd, 'data', 'cache', 'plugins'),
    })
    expect(Object.isFrozen(env)).toBe(true)
  })

  it('parses every variable', () => {
    const masterKey = Buffer.alloc(32, 7).toString('base64')
    const env = loadEnv({
      HF_PORT: '8791',
      HF_HOST: '0.0.0.0',
      HF_DATA_DIR: '/srv/harness',
      HF_PASSWORD: 'secret',
      HF_MASTER_KEY: masterKey,
      HF_MOCK_PROVIDER: '1',
      HF_SAFE_MODE: 'true',
      HF_PLUGIN_WATCH: 'yes',
      HF_OFFLINE: 'on',
      HF_INSECURE: '0',
      HF_API_TARGET: 'http://127.0.0.1:8791',
      HF_WEB_DIR: '/srv/harness-web',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    })
    expect(env).toMatchObject({
      port: 8791,
      host: '0.0.0.0',
      dataDir: '/srv/harness',
      password: 'secret',
      masterKey,
      mockProvider: true,
      safeMode: true,
      pluginWatch: true,
      offline: true,
      insecure: false,
      apiTarget: 'http://127.0.0.1:8791',
      webDir: '/srv/harness-web',
    })
    expect(env.vars.ANTHROPIC_API_KEY).toBe('sk-ant-test')
  })

  it('resolves a relative HF_WEB_DIR like HF_DATA_DIR', () => {
    const root = tempDir()
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    const cwd = join(root, 'apps', 'server')
    mkdirSync(cwd, { recursive: true })
    expect(loadEnv({ HF_WEB_DIR: 'apps/web/.output/public' }, { cwd }).webDir).toBe(join(root, 'apps', 'web', '.output', 'public'))
  })

  it('treats empty values as unset', () => {
    const env = loadEnv({ HF_PORT: '', HF_PASSWORD: '  ', HF_SAFE_MODE: '' }, { cwd: tempDir() })
    expect(env.port).toBe(8787)
    expect(env.password).toBeNull()
    expect(env.safeMode).toBe(false)
  })

  it.each([
    [{ HF_PORT: 'abc' }, 'HF_PORT'],
    [{ HF_PORT: '70000' }, 'HF_PORT'],
    [{ HF_SAFE_MODE: 'maybe' }, 'HF_SAFE_MODE'],
    [{ HF_MASTER_KEY: 'too-short' }, 'HF_MASTER_KEY'],
    [{ HF_MASTER_KEY: Buffer.alloc(16).toString('base64') }, 'HF_MASTER_KEY'],
    [{ HF_API_TARGET: 'ftp://example.com' }, 'HF_API_TARGET'],
  ])('rejects %o', (vars, name) => {
    expect(() => loadEnv(vars, { cwd: tempDir() })).toThrow(EnvError)
    expect(() => loadEnv(vars, { cwd: tempDir() })).toThrow(name)
  })

  it('resolves a relative HF_DATA_DIR against the workspace root', () => {
    const root = tempDir()
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    const cwd = join(root, 'apps', 'server')
    mkdirSync(cwd, { recursive: true })
    expect(loadEnv({ HF_DATA_DIR: './data' }, { cwd }).dataDir).toBe(join(root, 'data'))
    expect(loadEnv({ HF_DATA_DIR: '.tmp/C4' }, { cwd }).dataDir).toBe(join(root, '.tmp', 'C4'))
  })

  it('resolves a relative HF_DATA_DIR against the cwd outside a workspace', () => {
    const cwd = tempDir()
    expect(loadEnv({ HF_DATA_DIR: 'state' }, { cwd }).dataDir).toBe(join(cwd, 'state'))
  })

  it('detects development mode from NODE_ENV', () => {
    expect(loadEnv({ NODE_ENV: 'production' }, { cwd: tempDir() })).toMatchObject({ dev: false, logLevel: 'info' })
    expect(loadEnv({ NODE_ENV: 'development' }, { cwd: tempDir() })).toMatchObject({ dev: true, logLevel: 'debug' })
    expect(loadEnv({}, { cwd: tempDir(), dev: false }).dev).toBe(false)
  })
})

describe('bind safety', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]'])('%s is loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each(['0.0.0.0', '192.168.1.10', '::', 'example.com'])('%s is not loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })

  it('refuses a non-loopback bind without a password unless HF_INSECURE=1', () => {
    const cwd = tempDir()
    expect(bindSafetyError(loadEnv({ HF_HOST: '0.0.0.0' }, { cwd }))).toMatch(/HF_PASSWORD/)
    expect(bindSafetyError(loadEnv({ HF_HOST: '0.0.0.0', HF_PASSWORD: 'x' }, { cwd }))).toBeNull()
    expect(bindSafetyError(loadEnv({ HF_HOST: '0.0.0.0', HF_INSECURE: '1' }, { cwd }))).toBeNull()
    expect(bindSafetyError(loadEnv({ HF_HOST: '0.0.0.0' }, { cwd }), { storedPassword: true })).toBeNull()
    expect(bindSafetyError(loadEnv({}, { cwd }))).toBeNull()
  })
})

describe('ensureDataDir', () => {
  it('creates the data directory layout (root 0700) idempotently', () => {
    const env = loadEnv({ HF_DATA_DIR: join(tempDir(), 'data') })
    ensureDataDir(env)
    ensureDataDir(env)
    for (const dir of [env.paths.root, env.paths.plugins, env.paths.pluginStaging, env.paths.pluginData, env.paths.files, env.paths.cache, env.paths.pluginCache])
      expect(statSync(dir).isDirectory()).toBe(true)
    if (process.platform !== 'win32')
      expect(statSync(env.paths.root).mode & 0o777).toBe(0o700)
  })
})

describe('.env file', () => {
  const NAMES = ['HF_W11_TEST_FROM_FILE', 'HF_W11_TEST_ALREADY_SET', 'HF_W11_TEST_EMPTY'] as const

  afterEach(() => {
    for (const name of NAMES)
      delete process.env[name]
  })

  it('defaults to <workspace root>/.env', () => {
    expect(defaultEnvFile()).toBe(join(findWorkspaceRoot(serverPackageRoot()) ?? '', '.env'))
  })

  it('loads missing variables; variables already set (even empty) win', () => {
    const file = join(tempDir(), '.env')
    writeFileSync(file, [
      '# comment',
      'HF_W11_TEST_FROM_FILE="from file"',
      'HF_W11_TEST_ALREADY_SET=from-file',
      'HF_W11_TEST_EMPTY=from-file',
    ].join('\n'))
    process.env.HF_W11_TEST_ALREADY_SET = 'from-shell'
    process.env.HF_W11_TEST_EMPTY = ''
    expect(loadDotEnvFile(file)).toBe(file)
    expect(process.env.HF_W11_TEST_FROM_FILE).toBe('from file')
    expect(process.env.HF_W11_TEST_ALREADY_SET).toBe('from-shell')
    expect(process.env.HF_W11_TEST_EMPTY).toBe('')
  })

  it('does nothing without a file', () => {
    expect(loadDotEnvFile(join(tempDir(), '.env'))).toBeNull()
  })

  it('fails loudly when the file exists but cannot be read', () => {
    const dir = join(tempDir(), '.env')
    mkdirSync(dir)
    expect(() => loadDotEnvFile(dir)).toThrow()
  })
})

describe('bind safety message', () => {
  it('names every way out', () => {
    const message = bindSafetyError({ host: '0.0.0.0', password: null, insecure: false }) ?? ''
    expect(message).toContain('0.0.0.0')
    for (const hint of ['HF_PASSWORD', 'Settings', '127.0.0.1', 'HF_INSECURE=1'])
      expect(message).toContain(hint)
  })
})
