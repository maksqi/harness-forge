// A server of its own for a spec, started from the production build (`apps/server/dist/main.mjs`): a free port on
// 127.0.0.1, a temporary data directory, the mock provider, offline mode and no provider keys (every `*_API_KEY` of the
// environment and the documented provider variables are set empty, which also beats a repository `.env`). Used for a
// password (`startPasswordServer`) and for the screenshots, which need a data directory with nothing but their own
// chats. `stop()` ends the process and removes the directory.
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** The repository root (the working directory of the servers this helper starts). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SERVER_ENTRY = join(REPO_ROOT, 'apps/server/dist/main.mjs')
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000

/** Provider key variables (docs/PROVIDERS.md): emptied for servers started here, so no real key is ever used. */
const PROVIDER_KEY_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'MINIMAX_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'ALIBABA_API_KEY',
  'DASHSCOPE_API_KEY',
  'ZAI_API_KEY',
  'ZHIPU_API_KEY',
]

export interface StartServerOptions {
  /** More environment variables, e.g. `{ HF_PASSWORD: 'secret' }` (they win over the defaults of this helper). */
  env?: Record<string, string>
  /** Prefix of the temporary data directory. */
  label?: string
}

export interface StartedServer {
  /** `http://127.0.0.1:<port>` */
  baseURL: string
  /**
   * Its temporary data directory (a realpath: macOS `/var` is a link to `/private/var`), e.g. to place a leftover blob
   * for the storage cleanup (Phase 7). Its default workspace root is `<dataDir>/workspaces`.
   */
  dataDir: string
  /** Ends the server and removes its data directory. */
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
      throw new Error(`The server exited with code ${child.exitCode}:\n${output()}`)
    try {
      const response = await fetch(`${baseURL}/api/health`)
      if (response.ok)
        return
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The server did not answer within ${START_TIMEOUT_MS} ms:\n${output()}`)
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

/** Every provider key variable, set empty. */
function withoutProviderKeys(): Record<string, string> {
  const names = new Set(PROVIDER_KEY_VARIABLES)
  for (const name of Object.keys(process.env)) {
    if (name.endsWith('_API_KEY'))
      names.add(name)
  }
  return Object.fromEntries([...names].map(name => [name, '']))
}

/** Starts a server from the build; call `stop()` in `afterAll`. */
export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  if (!existsSync(SERVER_ENTRY))
    throw new Error(`${SERVER_ENTRY} is missing: build the app first (pnpm build).`)

  const port = await freePort()
  const baseURL = `http://127.0.0.1:${port}`
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), `${options.label ?? 'hf-e2e'}-`)))
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...withoutProviderKeys(),
      HF_HOST: '127.0.0.1',
      HF_PORT: String(port),
      HF_DATA_DIR: dataDir,
      HF_MOCK_PROVIDER: '1',
      HF_OFFLINE: '1',
      ...options.env,
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
  return { baseURL, dataDir, stop }
}
