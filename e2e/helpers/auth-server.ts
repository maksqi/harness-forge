// A password-protected server for the login spec (`HF_PASSWORD`, docs/UI.md 9.7). The main e2e server runs without a
// password, so login is tested against a second instance:
// - `E2E_AUTH_BASE_URL` (+ `E2E_AUTH_PASSWORD`, default `secret`): use a server that is already running;
// - otherwise the production build (`apps/server/dist/main.mjs`) is started on a free port with a temporary data
//   directory, and `stop()` ends it and removes the directory.
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_AUTH_PASSWORD = 'secret'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SERVER_ENTRY = join(REPO_ROOT, 'apps/server/dist/main.mjs')
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000

export interface PasswordServer {
  /** `http://127.0.0.1:<port>` */
  baseURL: string
  password: string
  /** Stops a server this helper started (no-op for `E2E_AUTH_BASE_URL`). */
  stop: () => Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object')
          resolve(address.port)
        else
          reject(new Error('Could not find a free port.'))
      })
    })
  })
}

async function waitForHealth(baseURL: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`The password server exited with code ${child.exitCode}:\n${output()}`)
    try {
      const response = await fetch(`${baseURL}/api/health`)
      if (response.ok)
        return
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The password server did not answer within ${START_TIMEOUT_MS} ms:\n${output()}`)
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
  await exited
  clearTimeout(timer)
}

/** Starts (or points at) a server that requires a password. Call `stop()` in `afterAll`. */
export async function startPasswordServer(options: { password?: string } = {}): Promise<PasswordServer> {
  const external = process.env.E2E_AUTH_BASE_URL
  if (external) {
    return {
      baseURL: external.replace(/\/+$/, ''),
      password: process.env.E2E_AUTH_PASSWORD ?? DEFAULT_AUTH_PASSWORD,
      stop: async () => {},
    }
  }
  if (!existsSync(SERVER_ENTRY))
    throw new Error(`${SERVER_ENTRY} is missing: build the app (pnpm build) or set E2E_AUTH_BASE_URL.`)

  const password = options.password ?? `e2e-${randomBytes(8).toString('hex')}`
  const port = await freePort()
  const baseURL = `http://127.0.0.1:${port}`
  const dataDir = await mkdtemp(join(tmpdir(), 'hf-e2e-auth-'))
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HF_HOST: '127.0.0.1',
      HF_PORT: String(port),
      HF_DATA_DIR: dataDir,
      HF_PASSWORD: password,
      HF_MOCK_PROVIDER: '1',
      HF_OFFLINE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  const append = (chunk: Buffer) => {
    log = (log + chunk.toString('utf8')).slice(-8000)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)

  const stop = async () => {
    await stopChild(child)
    await rm(dataDir, { recursive: true, force: true })
  }
  try {
    await waitForHealth(baseURL, child, () => log)
  }
  catch (error) {
    await stop()
    throw error
  }
  return { baseURL, password, stop }
}
