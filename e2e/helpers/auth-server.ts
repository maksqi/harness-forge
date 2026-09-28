// A password-protected server for the login spec (`HF_PASSWORD`, docs/UI.md 9.7). The main e2e server runs without a
// password, so login is tested against a second instance:
// - `E2E_AUTH_BASE_URL` (+ `E2E_AUTH_PASSWORD`, default `secret`): use a server that is already running;
// - otherwise the production build is started with `startServer()` (./server.ts: a free port, a temporary data
//   directory), and `stop()` ends it and removes the directory.
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import { startServer } from './server.ts'

export const DEFAULT_AUTH_PASSWORD = 'secret'

export interface PasswordServer {
  /** `http://127.0.0.1:<port>` */
  baseURL: string
  password: string
  /** Stops a server this helper started (no-op for `E2E_AUTH_BASE_URL`). */
  stop: () => Promise<void>
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
  const password = options.password ?? `e2e-${randomBytes(8).toString('hex')}`
  const server = await startServer({ env: { HF_PASSWORD: password }, label: 'hf-e2e-auth' })
  return { ...server, password }
}
