// A password-protected server (`HF_PASSWORD`, docs/UI.md 9.7) for the login, share and data specs. The main e2e server
// runs without a password, so these specs use a second instance:
// - `E2E_AUTH_BASE_URL` (+ `E2E_AUTH_PASSWORD`, default `secret`): use a server that is already running (never for
//   `dedicated: true`);
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
  /** The data directory of a server this helper started (undefined for `E2E_AUTH_BASE_URL`). */
  dataDir?: string
  /** Stops a server this helper started (no-op for `E2E_AUTH_BASE_URL`). */
  stop: () => Promise<void>
}

export interface PasswordServerOptions {
  /** The password of a started server (default: a random one). */
  password?: string
  /**
   * Always start a server of its own with an empty data directory, even when `E2E_AUTH_BASE_URL` is set: for specs
   * that delete every chat or count what the server holds (the data spec).
   */
  dedicated?: boolean
  /** Prefix of the temporary data directory of a started server (default `hf-e2e-auth`). */
  label?: string
}

/** Starts (or points at) a server that requires a password. Call `stop()` in `afterAll`. */
export async function startPasswordServer(options: PasswordServerOptions = {}): Promise<PasswordServer> {
  const external = options.dedicated ? undefined : process.env.E2E_AUTH_BASE_URL
  if (external) {
    return {
      baseURL: external.replace(/\/+$/, ''),
      password: process.env.E2E_AUTH_PASSWORD ?? DEFAULT_AUTH_PASSWORD,
      stop: async () => {},
    }
  }
  const password = options.password ?? `e2e-${randomBytes(8).toString('hex')}`
  const server = await startServer({ env: { HF_PASSWORD: password }, label: options.label ?? 'hf-e2e-auth' })
  return { ...server, password }
}
