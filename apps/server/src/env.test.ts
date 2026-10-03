import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSafetyError, defaultEnvFile, ensureDataDir, EnvError, isLoopbackHost, loadDotEnvFile, loadEnv, parseWorkspaceRoots } from './env.ts'
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
      trustProxy: null,
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
      HF_TRUST_PROXY: 'loopback,10.0.0.2',
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
      trustProxy: ['loopback', '10.0.0.2'],
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

describe('hF_TRUST_PROXY (ADR-026)', () => {
  it('unset (or empty) keeps the v1 behavior: null', () => {
    expect(loadEnv({}, { cwd: tempDir() }).trustProxy).toBeNull()
    expect(loadEnv({ HF_TRUST_PROXY: '  ' }, { cwd: tempDir() }).trustProxy).toBeNull()
  })

  it.each([
    ['loopback', ['loopback']],
    ['private', ['private']],
    ['Loopback, 10.0.0.2', ['loopback', '10.0.0.2']],
    ['192.168.1.0/24,fd00::/8', ['192.168.1.0/24', 'fd00::/8']],
    ['2001:DB8::1', ['2001:db8::1']],
    ['::ffff:10.0.0.3', ['10.0.0.3']],
  ])('%s -> %o (frozen)', (value, entries) => {
    const env = loadEnv({ HF_TRUST_PROXY: value }, { cwd: tempDir() })
    expect(env.trustProxy).toEqual(entries)
    expect(Object.isFrozen(env.trustProxy)).toBe(true)
  })

  it.each(['1', 'true', 'TRUE', '2', '0', 'yes', '*', 'false', 'localhost', 'proxy.example.com', 'loopback,maybe', '10.0.0.0/33', '0.0.0.0/0', '::/0', '10.0.0.1:8080', ','])('rejects %s with an EnvError that explains the format', (value) => {
    let error: unknown
    try {
      loadEnv({ HF_TRUST_PROXY: value }, { cwd: tempDir() })
    }
    catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EnvError)
    const message = (error as EnvError).message
    expect(message).toContain('HF_TRUST_PROXY')
    for (const part of ['loopback', 'private', 'IP addresses', 'CIDR ranges'])
      expect(message).toContain(part)
  })

  it('names the reason for booleans and hop counts', () => {
    expect(() => loadEnv({ HF_TRUST_PROXY: 'true' }, { cwd: tempDir() })).toThrow(/trust every peer/)
    expect(() => loadEnv({ HF_TRUST_PROXY: '1' }, { cwd: tempDir() })).toThrow(/hop count/)
  })
})

describe('hF_WORKSPACE_ROOTS and HF_WORKSPACE_SHELL (Phase 7, ADR-031 / ADR-033)', () => {
  it('defaults: the only root is <dataDir>/workspaces (frozen), the shell is on', () => {
    const cwd = tempDir()
    const env = loadEnv({}, { cwd })
    expect(env.paths.workspaces).toBe(join(cwd, 'data', 'workspaces'))
    expect(env.workspaceRoots).toEqual([join(cwd, 'data', 'workspaces')])
    expect(env.workspaceRootsDefault).toBe(true)
    expect(env.workspaceShell).toBe(true)
    expect(Object.isFrozen(env.workspaceRoots)).toBe(true)
    expect(Object.isFrozen(env.paths)).toBe(true)
  })

  it('an empty value counts as unset', () => {
    const env = loadEnv({ HF_WORKSPACE_ROOTS: '  ', HF_WORKSPACE_SHELL: '' }, { cwd: tempDir() })
    expect(env.workspaceRootsDefault).toBe(true)
    expect(env.workspaceShell).toBe(true)
  })

  it('splits on commas, trims, drops empty items, normalizes with resolve and deduplicates (first wins)', () => {
    const env = loadEnv({ HF_WORKSPACE_ROOTS: ' /srv/projects , ,/home/me/code/, /srv/a/../projects,/srv/x/./y,' }, { cwd: tempDir() })
    expect(env.workspaceRoots).toEqual(['/srv/projects', '/home/me/code', '/srv/x/y'])
    expect(env.workspaceRootsDefault).toBe(false)
    expect(Object.isFrozen(env.workspaceRoots)).toBe(true)
  })

  it('an explicit list may name the default root', () => {
    const cwd = tempDir()
    const dataDir = join(cwd, 'data')
    const env = loadEnv({ HF_DATA_DIR: dataDir, HF_WORKSPACE_ROOTS: `${join(dataDir, 'workspaces')},/srv/projects` }, { cwd })
    expect(env.workspaceRoots).toEqual([join(dataDir, 'workspaces'), '/srv/projects'])
    expect(env.workspaceRootsDefault).toBe(false)
  })

  it.each([
    ['relative/projects', 'is not an absolute path'],
    ['./projects', 'is not an absolute path'],
    ['~/projects', 'is not an absolute path'],
    ['/srv/projects,projects', 'is not an absolute path'],
    ['/', 'is a filesystem root'],
    ['/srv/..', 'is a filesystem root'],
    ['/srv/projects, //', 'is a filesystem root'],
    ['/srv/pro\u0000jects', 'NUL character'],
    [',', 'names no folder'],
    [' , ,, ', 'names no folder'],
  ])('refuses %j with an EnvError naming the variable and the format', (value, reason) => {
    let error: unknown
    try {
      loadEnv({ HF_WORKSPACE_ROOTS: value }, { cwd: tempDir() })
    }
    catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EnvError)
    const message = (error as EnvError).message
    expect(message).toContain('HF_WORKSPACE_ROOTS')
    expect(message).toContain(reason)
    expect(message).toContain('comma-separated list of absolute folders')
  })

  it('parseWorkspaceRoots never touches the filesystem: missing folders pass the syntax check', () => {
    expect(parseWorkspaceRoots('/does/not/exist/hf-c14')).toEqual({ ok: true, roots: ['/does/not/exist/hf-c14'] })
    expect(parseWorkspaceRoots('relative')).toMatchObject({ ok: false })
  })

  it.each([
    ['0', false],
    ['off', false],
    ['false', false],
    ['no', false],
    ['1', true],
    ['on', true],
    ['TRUE', true],
  ])('hF_WORKSPACE_SHELL=%s -> %s', (value, expected) => {
    expect(loadEnv({ HF_WORKSPACE_SHELL: value }, { cwd: tempDir() }).workspaceShell).toBe(expected)
  })

  it('refuses an HF_WORKSPACE_SHELL that is not a flag', () => {
    expect(() => loadEnv({ HF_WORKSPACE_SHELL: 'maybe' }, { cwd: tempDir() })).toThrow(EnvError)
    expect(() => loadEnv({ HF_WORKSPACE_SHELL: 'maybe' }, { cwd: tempDir() })).toThrow(/HF_WORKSPACE_SHELL/)
  })

  it('ensureDataDir does not create the workspace root (projects.start() does)', () => {
    const env = loadEnv({ HF_DATA_DIR: join(tempDir(), 'data') })
    ensureDataDir(env)
    expect(existsSync(env.paths.workspaces)).toBe(false)
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
