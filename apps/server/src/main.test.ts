// Boot safety (W1.1-T8): the real entry point refuses a non-loopback bind without a password and exits with code 1
// before it creates the data directory or opens a port. (The stored-password and HF_INSECURE branches of the rule are
// unit-tested in env.test.ts; starting a server on a public address is never done in tests.)
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
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

/** Runs `src/main.ts` with tsx and a clean `HF_*` environment (explicit values also shadow any `.env` file). */
function runMain(env: Record<string, string>, timeoutMs = 60_000): Promise<RunResult> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HF_')))
  const root = serverPackageRoot()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src', 'main.ts')], {
      cwd: root,
      env: { ...inherited, HF_PASSWORD: '', HF_INSECURE: '0', HF_MASTER_KEY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      output += chunk
    })
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
