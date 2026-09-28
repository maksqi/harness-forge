// Boot safety (W1.1-T8): the real entry point refuses a non-loopback bind without a password and exits with code 1
// before it creates the data directory or opens a port. (The stored-password and HF_INSECURE branches of the rule are
// unit-tested in env.test.ts; starting a server on a public address is never done in tests.) `HF_TRUST_PROXY`
// (W5.7-T1 / T4, ADR-026): an invalid value stops the boot with the format explained, a valid one is logged with every
// trusted range (a real boot on 127.0.0.1, any free port, offline, provider keys blanked).
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { PROVIDER_DEFINITIONS } from './builtin-plugins/core-providers/providers/index.ts'
import { serverPackageRoot } from './paths.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

interface RunResult {
  code: number | null
  output: string
}

/** Every provider key variable (`CredentialField.envVar`), blanked so a `.env` file cannot hand the child a real key. */
const PROVIDER_KEY_VARIABLES = PROVIDER_DEFINITIONS.flatMap(definition => definition.credentials.flatMap(field => field.envVar ?? []))

/** Spawns `src/main.ts` with tsx and a clean `HF_*` environment (explicit values also shadow any `.env` file). */
function spawnMain(env: Record<string, string>): ChildProcess {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HF_')))
  const root = serverPackageRoot()
  return spawn(process.execPath, ['--import', 'tsx', join(root, 'src', 'main.ts')], {
    cwd: root,
    env: { ...inherited, HF_PASSWORD: '', HF_INSECURE: '0', HF_MASTER_KEY: '', HF_TRUST_PROXY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Runs `src/main.ts` until it exits. With `stopWhen`, sends SIGTERM once the output matches it (a server that booted)
 * and waits for the graceful shutdown.
 */
function runMain(env: Record<string, string>, timeoutMs = 60_000, stopWhen?: RegExp): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnMain(env)
    let output = ''
    let stopping = false
    const collect = (chunk: string): void => {
      output += chunk
      if (stopWhen !== undefined && !stopping && stopWhen.test(output)) {
        stopping = true
        child.kill('SIGTERM')
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`main.ts did not exit within ${timeoutMs} ms:\n${output}`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

/** The JSON log records of an output (other lines ignored). */
function records(output: string): Array<Record<string, unknown>> {
  return output.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return typeof value === 'object' && value !== null ? [value as Record<string, unknown>] : []
    }
    catch {
      return []
    }
  })
}

describe('main.ts bind safety', () => {
  it('a non-loopback HF_HOST without a password exits with code 1 and a clear message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harness-forge-main-'))
    tempDirs.push(dataDir)
    const result = await runMain({ HF_HOST: '0.0.0.0', HF_PORT: '8791', HF_DATA_DIR: dataDir, NODE_ENV: 'production' })
    expect(result.code).toBe(1)
    expect(result.output).toContain('Refusing to listen on 0.0.0.0 without a password')
    expect(result.output).not.toContain('"msg":"listening"')
    // Refused before anything was created in the data directory.
    expect(existsSync(join(dataDir, 'harness.db'))).toBe(false)
    expect(readdirSync(dataDir)).toEqual([])
  }, 90_000)

  it('with an existing database, the stored password is checked (none stored: exit 1 before plugins start)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harness-forge-main-'))
    tempDirs.push(dataDir)
    writeFileSync(join(dataDir, 'harness.db'), '')
    const result = await runMain({ HF_HOST: '0.0.0.0', HF_PORT: '8791', HF_DATA_DIR: dataDir, NODE_ENV: 'production' })
    expect(result.code).toBe(1)
    expect(result.output).toContain('Refusing to listen on 0.0.0.0 without a password')
    expect(result.output).not.toContain('plugins loaded')
    expect(result.output).not.toContain('"msg":"listening"')
  }, 90_000)

  it('an invalid environment exits with code 1 and names the variable', async () => {
    const result = await runMain({ HF_PORT: 'not-a-port', HF_DATA_DIR: join(tmpdir(), 'harness-forge-never-created') })
    expect(result.code).toBe(1)
    expect(result.output).toContain('HF_PORT')
  }, 90_000)
})

describe('main.ts and HF_TRUST_PROXY (ADR-026)', () => {
  it.each(['true', '1', 'loopback,2'])('hF_TRUST_PROXY=%s exits with code 1 and explains the format', async (value) => {
    const result = await runMain({ HF_TRUST_PROXY: value, HF_DATA_DIR: join(tmpdir(), 'harness-forge-never-created') })
    expect(result.code).toBe(1)
    expect(result.output).toContain('HF_TRUST_PROXY')
    for (const part of ['loopback', 'private', 'CIDR ranges'])
      expect(result.output).toContain(part)
    expect(result.output).not.toContain('"msg":"listening"')
  }, 90_000)

  it('the boot log lists the trusted ranges', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harness-forge-main-'))
    tempDirs.push(dataDir)
    const blankKeys = Object.fromEntries(PROVIDER_KEY_VARIABLES.map(name => [name, '']))
    const result = await runMain({
      ...blankKeys,
      HF_HOST: '127.0.0.1',
      HF_PORT: '0',
      HF_DATA_DIR: dataDir,
      HF_OFFLINE: '1',
      HF_TRUST_PROXY: 'loopback, 10.0.0.2',
      NODE_ENV: 'production',
    }, 60_000, /"msg":"listening"/)
    expect(result.output).toContain('"msg":"listening"')
    const trusted = records(result.output).find(record => record.msg === 'trusting reverse proxies (HF_TRUST_PROXY)')
    expect(trusted).toMatchObject({ level: 'info', trustProxy: ['loopback', '10.0.0.2'], ranges: ['127.0.0.0/8', '::1', '10.0.0.2'] })
    expect(result.code).toBe(0)
  }, 90_000)
})
