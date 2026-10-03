// Offline `rotate-key` CLI (W7.7-T5, ADR-034, ARCHITECTURE.md 6.14) on temp data directories: it refuses (exit 2) while
// a server answers `/api/health` or `server.lock` names a live local process, needs `--force` for a lock of another
// host; env mode needs `HF_NEW_MASTER_KEY` (validated, different, never generated or printed) and round-trips: a restart
// with the new key reports `keyCheck: ok`, with the old one `mismatch`; file mode generates the key and runs the
// write-ahead flow. Everything goes to stderr; no key text is ever written.
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestApp } from '../../testing/create-test-app.ts'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../db/client.ts'
import { chats, messages, secrets, settings } from '../../db/schema.ts'
import { loadEnv } from '../../env.ts'
import { createMemoryLogger } from '../../logger.ts'
import { createKeyring, deriveSubkey, encodeMasterKey, readMasterKeyFile } from '../../security/keyring.ts'
import { createRedactor } from '../../security/redact.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { decryptSecret, secretAad } from '../secrets/crypto.ts'
import { keyCheckOfMasterKey } from './check.ts'
import { CLI_EXIT, CLI_PREFIX, healthProbeUrl, isRotateKeyCommand, NEW_MASTER_KEY_VARIABLE, runRotateKeyCommand } from './cli.ts'
import { nextKeyPath, recoverKeyState } from './recover.ts'
import { currentHostname, SERVER_LOCK_FILE } from './server-lock.ts'
import { KEY_ROTATION_DENIAL_REASON, KEY_STATE_SETTING } from './types.ts'

const dirs: string[] = []
const servers: Server[] = []
const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  for (const server of servers.splice(0))
    await new Promise<void>(resolve => server.close(() => resolve()))
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const CHAT = '0199a8f0-0000-7000-8000-00000000e001'
const SECRET_VALUE = 'sk-test-openai-cli-0001'

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hf-cli-')))
  dirs.push(dir)
  return dir
}

/** Opens the data directory like a server would (real keyring at `keyVersion`), started off. */
async function openApp(dataDir: string, env: Record<string, string> = {}, keyVersion = 1): Promise<TestApp> {
  const t = await createTestApp({
    dataDir,
    databasePath: join(dataDir, 'harness.db'),
    start: false,
    env,
    factories: { keyring: deps => createKeyring(deps, { keyVersion }) },
  })
  apps.push(t)
  return t
}

/**
 * A stopped server's data directory: the boot recovery ran (`_keys`), one provider secret, a chat waiting for a tool
 * approval.
 */
async function seed(env: Record<string, string> = {}): Promise<string> {
  const dataDir = tempDir()
  const t = await openApp(dataDir, env)
  await recoverKeyState({ env: t.env, db: t.db, logger: t.deps.logger, redactor: t.deps.redactor })
  await t.deps.secrets.set('provider:openai', 'apiKey', SECRET_VALUE)
  await t.deps.chats.create({ id: CHAT, title: 'Pending' })
  await t.db.insert(messages).values({
    id: 'msg_asst000000000009',
    chatId: CHAT,
    parentId: null,
    seq: 0,
    role: 'assistant',
    parts: [{ type: 'tool-web_fetch', toolCallId: 'call_1', state: 'approval-requested', input: { url: 'https://example.com' }, approval: { id: 'apr_9' } }] as never,
    searchText: '',
  })
  await t.db.update(chats).set({ pendingApproval: true, activeLeafId: 'msg_asst000000000009' }).where(eq(chats.id, CHAT))
  apps.splice(apps.indexOf(t), 1)
  await t.close()
  return dataDir
}

interface CliRun {
  code: number
  output: string
}

async function cli(vars: Record<string, string | undefined>, args: string[] = []): Promise<CliRun> {
  let output = ''
  const code = await runRotateKeyCommand(args, {
    vars: { HF_PORT: '0', ...vars },
    stderr: { write: (text: string) => (output += text) },
  })
  return { code, output }
}

/** The stored key state and every secret row, read straight from the database file. */
async function inspect(dataDir: string) {
  const database = await openDatabase({ path: join(dataDir, 'harness.db') })
  try {
    const [state] = await database.db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY_STATE_SETTING))
    const rows = await database.db.select().from(secrets)
    const [message] = await database.db.select({ parts: messages.parts }).from(messages).where(eq(messages.id, 'msg_asst000000000009'))
    const [chat] = await database.db.select({ pending: chats.pendingApproval }).from(chats).where(eq(chats.id, CHAT))
    return { state: state?.value as { version: number, check: string } | undefined, rows, parts: message?.parts as unknown as Record<string, unknown>[], pending: chat?.pending }
  }
  finally {
    database.close()
  }
}

function decrypts(row: { scope: string, name: string, ciphertext: Uint8Array }, key: Uint8Array): string | null {
  try {
    return decryptSecret(deriveSubkey(key, 'encryption'), secretAad(row.scope, row.name), row.ciphertext)
  }
  catch {
    return null
  }
}

/** A local HTTP server answering every request (stands in for a running harness-forge). */
async function listening(host = '127.0.0.1'): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, host, () => resolve()))
  return (server.address() as AddressInfo).port
}

function writeLock(dataDir: string, lock: Record<string, unknown>): void {
  writeFileSync(join(dataDir, SERVER_LOCK_FILE), JSON.stringify(lock))
}

/** A pid that is not running. */
const DEAD_PID = 2 ** 22 + 54_321

describe('rotate-key: dispatch and arguments', () => {
  it('is selected by argv[2] only', () => {
    expect(isRotateKeyCommand(['node', 'main.mjs', 'rotate-key'])).toBe(true)
    expect(isRotateKeyCommand(['node', 'main.mjs'])).toBe(false)
    expect(isRotateKeyCommand(['node', 'main.mjs', '--rotate-key'])).toBe(false)
  })

  it('an unknown argument fails with the usage (exit 1)', async () => {
    const dataDir = tempDir()
    const run = await cli({ HF_DATA_DIR: dataDir }, ['--yes'])
    expect(run.code).toBe(CLI_EXIT.failed)
    expect(run.output).toContain('usage: rotate-key [--force]')
  })

  it('a data directory without a database fails (exit 1) and creates nothing', async () => {
    const dataDir = tempDir()
    const run = await cli({ HF_DATA_DIR: dataDir })
    expect(run.code).toBe(CLI_EXIT.failed)
    expect(run.output).toContain('there is no database')
    expect(existsSync(join(dataDir, 'secret.key'))).toBe(false)
    expect(existsSync(join(dataDir, SERVER_LOCK_FILE))).toBe(false)
  })

  it('an invalid environment fails (exit 1)', async () => {
    const run = await cli({ HF_DATA_DIR: tempDir(), HF_PORT: 'nope' })
    expect(run.code).toBe(CLI_EXIT.failed)
    expect(run.output).toContain('HF_PORT')
  })
})

describe('rotate-key: refuses while a server runs (exit 2)', () => {
  it('when /api/health answers on HF_HOST:HF_PORT (0.0.0.0 probed as 127.0.0.1)', async () => {
    const dataDir = await seed()
    const port = await listening()
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const run = await cli({ HF_DATA_DIR: dataDir, HF_HOST: host, HF_PORT: String(port), HF_INSECURE: '1' })
      expect(run.code).toBe(CLI_EXIT.refused)
      expect(run.output).toContain(`refused: a server answers at http://127.0.0.1:${port}/api/health`)
    }
    expect(healthProbeUrl({ host: '::', port: 1 })).toBe('http://[::1]:1/api/health')
    expect(healthProbeUrl({ host: 'localhost', port: 1 })).toBe('http://localhost:1/api/health')
    expect(healthProbeUrl({ host: '127.0.0.1', port: 0 })).toBeNull()
    expect((await inspect(dataDir)).state?.version).toBe(1)
  })

  it('when server.lock names a live process on this host, even with --force', async () => {
    const dataDir = await seed()
    writeLock(dataDir, { pid: process.ppid, hostname: currentHostname(), port: 8797, startedAt: 1 })
    for (const args of [[], ['--force']]) {
      const run = await cli({ HF_DATA_DIR: dataDir }, args)
      expect(run.code).toBe(CLI_EXIT.refused)
      expect(run.output).toContain(`names a running process (pid ${process.ppid})`)
    }
    expect((await inspect(dataDir)).state?.version).toBe(1)
  })

  it('a lock written on another host needs --force; an unreadable lock too', async () => {
    const dataDir = await seed()
    writeLock(dataDir, { pid: 1, hostname: 'other-host.example', port: 8787, startedAt: 1 })
    const refused = await cli({ HF_DATA_DIR: dataDir })
    expect(refused.code).toBe(CLI_EXIT.refused)
    expect(refused.output).toContain('was written on another host (other-host.example, pid 1)')
    expect(refused.output).toContain('--force')

    writeFileSync(join(dataDir, SERVER_LOCK_FILE), 'garbage')
    expect((await cli({ HF_DATA_DIR: dataDir })).code).toBe(CLI_EXIT.refused)

    writeLock(dataDir, { pid: 1, hostname: 'other-host.example', port: 8787, startedAt: 1 })
    const forced = await cli({ HF_DATA_DIR: dataDir }, ['--force'])
    expect(forced.code).toBe(CLI_EXIT.done)
    expect(forced.output).toContain('--force: ignoring the lock of host other-host.example')
  })

  it('a stale lock of this host (dead pid) does not block', async () => {
    const dataDir = await seed()
    writeLock(dataDir, { pid: DEAD_PID, hostname: currentHostname(), port: 8787, startedAt: 1 })
    const run = await cli({ HF_DATA_DIR: dataDir })
    expect(run.code).toBe(CLI_EXIT.done)
    expect(run.output).toContain(`is stale (pid ${DEAD_PID} is not running)`)
  })
})

describe('rotate-key: env mode (HF_MASTER_KEY)', () => {
  it('needs HF_NEW_MASTER_KEY: missing, invalid or equal to the old key fails (exit 1) and changes nothing', async () => {
    const oldKey = encodeMasterKey(randomBytes(32))
    const dataDir = await seed({ HF_MASTER_KEY: oldKey })
    const missing = await cli({ HF_DATA_DIR: dataDir, HF_MASTER_KEY: oldKey })
    expect(missing.code).toBe(CLI_EXIT.failed)
    expect(missing.output).toContain(`${NEW_MASTER_KEY_VARIABLE} is not set`)
    expect(missing.output).toContain('never generated')
    for (const value of ['short', oldKey]) {
      const run = await cli({ HF_DATA_DIR: dataDir, HF_MASTER_KEY: oldKey, [NEW_MASTER_KEY_VARIABLE]: value })
      expect(run.code).toBe(CLI_EXIT.failed)
    }
    const state = await inspect(dataDir)
    expect(state.state?.version).toBe(1)
    expect(state.rows.map(row => row.keyVersion)).toEqual([1])
    expect(existsSync(join(dataDir, 'secret.key'))).toBe(false)
  })

  it('refuses an old key that does not match the stored check (exit 1)', async () => {
    const dataDir = await seed({ HF_MASTER_KEY: encodeMasterKey(randomBytes(32)) })
    const run = await cli({ HF_DATA_DIR: dataDir, HF_MASTER_KEY: encodeMasterKey(randomBytes(32)), [NEW_MASTER_KEY_VARIABLE]: encodeMasterKey(randomBytes(32)) })
    expect(run.code).toBe(CLI_EXIT.failed)
    expect(run.output).toContain('does not match the key the secrets were written with')
    expect((await inspect(dataDir)).state?.version).toBe(1)
  })

  it('round trip: re-encrypts with HF_NEW_MASTER_KEY; a restart with the new key is ok, with the old one a mismatch', async () => {
    const oldBytes = randomBytes(32)
    const newBytes = randomBytes(32)
    const oldKey = encodeMasterKey(oldBytes)
    const newKey = encodeMasterKey(newBytes)
    const dataDir = await seed({ HF_MASTER_KEY: oldKey })
    const run = await cli({ HF_DATA_DIR: dataDir, HF_MASTER_KEY: oldKey, [NEW_MASTER_KEY_VARIABLE]: newKey })
    expect(run.code, run.output).toBe(CLI_EXIT.done)
    expect(run.output).toContain(`${CLI_PREFIX} rotated the master key to version 2: 1 secret re-encrypted, 0 unreadable left unchanged, 0 share links changed, 1 pending approval expired.`)
    expect(run.output).toContain('now replace HF_MASTER_KEY with the value of HF_NEW_MASTER_KEY')
    expect(run.output).not.toContain(oldKey)
    expect(run.output).not.toContain(newKey)
    expect(existsSync(join(dataDir, 'secret.key'))).toBe(false)

    const after = await inspect(dataDir)
    expect(after.state).toMatchObject({ version: 2, check: keyCheckOfMasterKey(newBytes) })
    expect(after.rows.map(row => [row.keyVersion, decrypts(row, newBytes)])).toEqual([[2, SECRET_VALUE]])
    expect(after.parts[0]).toMatchObject({ state: 'output-denied', approval: { approved: false, reason: KEY_ROTATION_DENIAL_REASON } })
    expect(after.pending).toBe(false)

    // Restart with the new key: the boot recovery gives version 2 and the key check is ok.
    const restart = async (key: string) => {
      const dir = dataDir
      const env = loadEnv({ HF_DATA_DIR: dir, HF_MASTER_KEY: key }, { cwd: dir })
      const database = await openDatabase({ path: env.paths.db })
      const logs = createMemoryLogger()
      try {
        return await recoverKeyState({ env, db: database.db, logger: logs.logger, redactor: createRedactor() })
      }
      finally {
        database.close()
      }
    }
    const { keyVersion } = await restart(newKey)
    expect(keyVersion).toBe(2)
    const fresh = await openApp(dataDir, { HF_MASTER_KEY: newKey }, keyVersion)
    expect(await fresh.deps.keys.status()).toMatchObject({ source: 'env', keyVersion: 2, keyCheck: 'ok', unreadableSecrets: 0, pendingApprovals: 0 })
    expect(await fresh.deps.secrets.get('provider:openai', 'apiKey')).toBe(SECRET_VALUE)
    await fresh.close()
    apps.splice(apps.indexOf(fresh), 1)

    const stale = await openApp(dataDir, { HF_MASTER_KEY: oldKey }, (await restart(oldKey)).keyVersion)
    expect(await stale.deps.keys.status()).toMatchObject({ keyCheck: 'mismatch', canRotate: false })
  })

  it('warns about a stale secret.key and leaves it unchanged', async () => {
    const oldKey = encodeMasterKey(randomBytes(32))
    const dataDir = await seed({ HF_MASTER_KEY: oldKey })
    writeFileSync(join(dataDir, 'secret.key'), `${encodeMasterKey(randomBytes(32))}\n`, { mode: 0o600 })
    const before = readFileSync(join(dataDir, 'secret.key'), 'utf8')
    const run = await cli({ HF_DATA_DIR: dataDir, HF_MASTER_KEY: oldKey, [NEW_MASTER_KEY_VARIABLE]: encodeMasterKey(randomBytes(32)) })
    expect(run.code).toBe(CLI_EXIT.done)
    expect(run.output).toContain('exists but is not used while HF_MASTER_KEY is set')
    expect(readFileSync(join(dataDir, 'secret.key'), 'utf8')).toBe(before)
  })
})

describe('rotate-key: file mode (secret.key)', () => {
  it('generates the key and runs the write-ahead flow; the server reads it after a restart', async () => {
    const dataDir = await seed()
    const oldBytes = readMasterKeyFile(join(dataDir, 'secret.key'))!
    const run = await cli({ HF_DATA_DIR: dataDir, [NEW_MASTER_KEY_VARIABLE]: encodeMasterKey(randomBytes(32)) })
    expect(run.code, run.output).toBe(CLI_EXIT.done)
    expect(run.output).toContain('is ignored: the key comes from')
    expect(run.output).toContain('holds the new key; start the server.')
    const newBytes = readMasterKeyFile(join(dataDir, 'secret.key'))!
    expect(newBytes).not.toEqual(oldBytes)
    if (process.platform !== 'win32')
      expect(statSync(join(dataDir, 'secret.key')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dataDir, 'secret.key.next'))).toBe(false)
    expect(run.output).not.toContain(encodeMasterKey(oldBytes))
    expect(run.output).not.toContain(encodeMasterKey(newBytes))

    const after = await inspect(dataDir)
    expect(after.state).toMatchObject({ version: 2, check: keyCheckOfMasterKey(newBytes) })
    expect(after.rows.map(row => [row.keyVersion, decrypts(row, newBytes)])).toEqual([[2, SECRET_VALUE]])
  })

  it('finishes an interrupted online rotation first (a committed secret.key.next)', async () => {
    const dataDir = await seed()
    // Crash after the commit: the first CLI run stops right after its transaction.
    let output = ''
    const crashed = await runRotateKeyCommand([], {
      vars: { HF_DATA_DIR: dataDir, HF_PORT: '0' },
      stderr: { write: (text: string) => (output += text) },
      onStep: (step) => {
        if (step === 'committed')
          throw new Error('injected crash')
      },
    })
    expect(crashed).toBe(CLI_EXIT.failed)
    expect(existsSync(nextKeyPath({ paths: { secretKey: join(dataDir, 'secret.key') } } as never))).toBe(true)
    const run = await cli({ HF_DATA_DIR: dataDir })
    expect(run.code, run.output).toBe(CLI_EXIT.done)
    expect(run.output).toContain('finished an interrupted key rotation')
    const after = await inspect(dataDir)
    expect(after.state?.version).toBe(3)
    const key = readMasterKeyFile(join(dataDir, 'secret.key'))!
    expect(after.rows.map(row => [row.keyVersion, decrypts(row, key)])).toEqual([[3, SECRET_VALUE]])
  })

  it('never creates a key file: no secret.key and no HF_MASTER_KEY fails (exit 1)', async () => {
    const dataDir = await seed()
    rmSync(join(dataDir, 'secret.key'))
    const run = await cli({ HF_DATA_DIR: dataDir })
    expect(run.code).toBe(CLI_EXIT.failed)
    expect(run.output).toContain('there is no master key file')
    expect(existsSync(join(dataDir, 'secret.key'))).toBe(false)
  })
})
