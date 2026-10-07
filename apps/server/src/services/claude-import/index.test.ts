// The home-folder import service (W12.3): `home()` (one `stat`, never a file read), `scan()` (fresh auth first; 409
// `disabled`; 404 for a missing folder; the plan statuses against the current state), `upload()` (the same plan as the
// scan from folder files and from a zip), the DTO / log hygiene (the canaries, env and header values never leave the
// server) and the plan store (10 minutes, at most 4, dropped on `key.rotated` and `stop()`). Temp folders only: the real
// `~/.claude` is never touched. Apply has its own file (./apply.test.ts).
import type { ClaudeImportPlan } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { ClaudeImportServiceOptions } from './index.ts'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { claudeImportHomeSchema, claudeImportPlanSchema, conflictDetailsSchema, createHookId, HarnessError, LIMITS, setDefinitionName } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { hooks } from '../../db/schema.ts'
import { freshAuthRequiredError } from '../../http/middleware/fresh-auth.ts'
import { CLAUDE_HOME_CANARIES, fakeClaudeHomeFiles } from '../../testing/claude-fixtures.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { NODE_DISK_FS } from './collect-disk.ts'
import { cleanupImportFixtures, hasCanary, planItems, uploadOfHome, writeFakeHome, zipOfHome } from './fixtures.test-util.ts'
import { claudeImportHome, createClaudeImportService, scanStoppedError } from './index.ts'

const apps: TestApp[] = []
const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup()
  await cleanupImportFixtures()
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hf-claude-home-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function app(claudeHome: string, options?: ClaudeImportServiceOptions): Promise<TestApp> {
  const t = await createTestApp({
    start: false,
    builtins: [],
    env: { HF_CLAUDE_HOME: claudeHome },
    ...(options === undefined ? {} : { factories: { claudeImport: deps => createClaudeImportService(deps, options) } }),
  })
  apps.push(t)
  return t
}

const FRESH = { requireFreshAuth: () => {} }

/** The fake home plus an agent with a builtin name (conflict) and an agent that does not parse (invalid). */
function extendedHome(): ReturnType<typeof fakeClaudeHomeFiles> {
  return {
    ...fakeClaudeHomeFiles(),
    '.claude/agents/explore.md': { content: '---\nname: explore\ndescription: My own explorer.\n---\nExplore.\n', mode: 0o644 },
    '.claude/agents/broken.md': { content: '---\nname: broken\n---\nNo description.\n', mode: 0o644 },
  }
}

function statusOf(plan: ClaudeImportPlan, kind: string, name: string): string | undefined {
  return plan.items.find(item => item.kind === kind && item.name === name)?.status
}

describe('claudeImportHome (GET /claude-import/home)', () => {
  it('hF_CLAUDE_HOME=0: disabled, no path', async () => {
    expect(await claudeImportHome({ claudeHome: null })).toEqual({ available: false, reason: 'disabled', path: null })
  })

  it('a folder is available; a missing folder, a file or a path through a file is missing', async () => {
    const root = tempDir()
    const home = join(root, '.claude')
    expect(await claudeImportHome({ claudeHome: home })).toEqual({ available: false, reason: 'missing', path: home })
    mkdirSync(home)
    expect(await claudeImportHome({ claudeHome: home })).toEqual({ available: true, path: home })
    writeFileSync(join(root, 'file'), 'x')
    expect(await claudeImportHome({ claudeHome: join(root, 'file') })).toEqual({ available: false, reason: 'missing', path: join(root, 'file') })
    expect(await claudeImportHome({ claudeHome: join(root, 'file', 'inside') })).toEqual({ available: false, reason: 'missing', path: join(root, 'file', 'inside') })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a folder whose parent cannot be searched is unreadable', async () => {
    const root = tempDir()
    const locked = join(root, 'locked')
    mkdirSync(join(locked, '.claude'), { recursive: true })
    chmodSync(locked, 0o000)
    cleanups.push(() => chmodSync(locked, 0o700))
    expect(await claudeImportHome({ claudeHome: join(locked, '.claude') })).toEqual({ available: false, reason: 'unreadable', path: join(locked, '.claude') })
  })

  it('never reads a file of the folder: an unreadable settings.json does not change the answer', async () => {
    const home = join(tempDir(), '.claude')
    mkdirSync(home)
    writeFileSync(join(home, 'settings.json'), '{}')
    chmodSync(join(home, 'settings.json'), 0o000)
    cleanups.push(() => chmodSync(join(home, 'settings.json'), 0o600))
    expect(await claudeImportHome({ claudeHome: home })).toEqual({ available: true, path: home })
  })

  it('answers through the route (HF_CLAUDE_HOME=0 → disabled; a missing folder → missing; a folder → available)', async () => {
    const disabled = await app('0')
    const response = await disabled.request('/api/claude-import/home')
    expect(response.status).toBe(200)
    expect(claudeImportHomeSchema.parse(await response.json())).toEqual({ available: false, reason: 'disabled', path: null })
    const home = join(tempDir(), '.claude')
    const missing = await app(home)
    expect(await (await missing.request('/api/claude-import/home')).json()).toEqual({ available: false, reason: 'missing', path: home })
    mkdirSync(home)
    expect(await (await missing.request('/api/claude-import/home')).json()).toEqual({ available: true, path: home })
  })
})

describe('scan', () => {
  it('asks for fresh auth before anything is read; 409 disabled; 404 for a missing folder', async () => {
    const { claudeHome } = await writeFakeHome()
    const opened: string[] = []
    const open: typeof NODE_DISK_FS.open = async (path, flags) => {
      opened.push(path)
      return NODE_DISK_FS.open(path, flags)
    }
    const t = await app(claudeHome, { fs: { ...NODE_DISK_FS, open } })
    await expect(t.deps.claudeImport.scan({ requireFreshAuth: () => {
      throw freshAuthRequiredError()
    } })).rejects.toMatchObject({ code: 'forbidden', action: 'login' })
    expect(opened).toEqual([])

    const disabled = await app('0')
    await expect(disabled.deps.claudeImport.scan(FRESH)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })
    const missing = await app(join(tempDir(), '.claude'))
    await expect(missing.deps.claudeImport.scan(FRESH)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('plans every status against the current state; no canary, env or header value in the plan or the logs', async () => {
    const { claudeHome } = await writeFakeHome(extendedHome())
    const t = await app(claudeHome)
    // update: a personal agent of the same name with other content; unchanged: the same command hook as a personal row.
    await t.deps.customizations.create({ kind: 'agent', content: '---\nname: reviewer\ndescription: Mine.\n---\nMine.\n' })
    const cleanGone = setDefinitionName(fakeClaudeHomeFiles()['.claude/commands/clean_gone.md']!.content as string, 'clean-gone')
    await t.deps.customizations.create({ kind: 'command', content: cleanGone })
    const at = Date.now()
    await t.deps.db.insert(hooks).values({ id: createHookId(), event: 'PreToolUse', matcher: 'Bash', command: 'sh ~/.claude/hooks/check-bash.sh', timeout: 10, enabled: false, createdAt: at, updatedAt: at })
    await t.deps.shellRules.create({ projectId: null, prefix: 'npm run test' })

    const plan = claudeImportPlanSchema.parse(await t.deps.claudeImport.scan(FRESH))
    expect(plan).toMatchObject({ source: 'scan', root: claudeHome })
    expect(plan.expiresAt - plan.createdAt).toBe(LIMITS.claudeImportPlanTtlMs)
    expect(new Set(plan.items.map(item => item.status))).toEqual(new Set(['new', 'update', 'unchanged', 'conflict', 'unsupported', 'invalid']))
    expect(statusOf(plan, 'agent', 'reviewer')).toBe('update')
    expect(statusOf(plan, 'agent', 'explore')).toBe('conflict')
    expect(statusOf(plan, 'agent', 'broken')).toBe('invalid')
    expect(statusOf(plan, 'command', 'clean-gone')).toBe('unchanged')
    expect(statusOf(plan, 'hook', 'PreToolUse (Bash)')).toBe('unchanged')
    expect(statusOf(plan, 'shell-rule', 'npm run test')).toBe('unchanged')
    expect(statusOf(plan, 'shell-rule', 'git status')).toBe('new')
    expect(statusOf(plan, 'mcp-server', 'docs-api')).toBe('new')
    expect(plan.items.find(item => item.kind === 'mcp-server' && item.name === 'app-db')).toMatchObject({ warnings: expect.arrayContaining(['project-server']), executable: true })
    expect(plan.items.find(item => item.kind === 'command' && item.name === 'deploy')).toMatchObject({ executable: true, warnings: ['runs-commands'] })

    const answer = JSON.stringify(plan)
    expect(hasCanary(answer)).toBe(false)
    expect(answer).not.toContain('payload')
    expect(hasCanary(t.logs.text())).toBe(false)
    expect(t.logs.records.filter(record => record.level === 'info').map(record => record.msg)).toContain('claude import planned')
    // The root path only at debug.
    expect(t.logs.records.filter(record => record.level !== 'debug').some(record => JSON.stringify(record).includes(claudeHome))).toBe(false)
  })

  it('stop() during a scan: 409 conflict busy with the stopped message (W12.18-T3); nothing is kept', async () => {
    const { claudeHome } = await writeFakeHome()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => {}
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const realpath: typeof NODE_DISK_FS.realpath = async (path) => {
      entered()
      await gate
      return NODE_DISK_FS.realpath(path)
    }
    const t = await app(claudeHome, { fs: { ...NODE_DISK_FS, realpath } })
    const scan = t.deps.claudeImport.scan(FRESH).then(() => null, (error: unknown) => error)
    await reading
    await t.deps.claudeImport.stop()
    release()
    const error = await scan
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ code: 'conflict', message: 'The scan of the Claude Code folder was stopped.', details: { reason: 'busy' } })
    expect(conflictDetailsSchema.parse((error as HarnessError).details)).toEqual({ reason: 'busy' })
    expect(scanStoppedError().toJSON()).toEqual({ error: { code: 'conflict', message: 'The scan of the Claude Code folder was stopped.', details: { reason: 'busy' } } })
    expect(t.logs.records.map(record => record.msg)).not.toContain('claude import planned')
  })

  it('the same fake home as folder files and as a zip gives the same plan as the scan', async () => {
    const tree = fakeClaudeHomeFiles()
    const { claudeHome } = await writeFakeHome(tree)
    const t = await app(claudeHome)
    const scanned = await t.deps.claudeImport.scan(FRESH)
    const files = await t.deps.claudeImport.upload(uploadOfHome(tree))
    const zip = await t.deps.claudeImport.upload({ label: 'claude.zip', zip: new Blob([new Uint8Array(zipOfHome(tree))]) })
    expect(planItems(files)).toEqual(planItems(scanned))
    expect(planItems(zip)).toEqual(planItems(scanned))
    expect(files).toMatchObject({ source: 'upload', root: '.claude' })
    expect(zip.root).toBe('claude.zip')
    expect(new Set([scanned.id, files.id, zip.id]).size).toBe(3)
    // The zip's other files are listed by name only.
    expect(zip.skipped.map(entry => entry.path)).toEqual(expect.arrayContaining(['.credentials.json', 'history.jsonl', 'settings.local.json']))
    expect(hasCanary(JSON.stringify([scanned, files, zip]))).toBe(false)
    expect(hasCanary(t.logs.text())).toBe(false)
    for (const value of [CLAUDE_HOME_CANARIES.envValue, CLAUDE_HOME_CANARIES.mcpEnvValue])
      expect(t.logs.text()).not.toContain(value)
  })
})

describe('plans', () => {
  it('at most 4 plans (the oldest dropped), each for 10 minutes', async () => {
    let clock = 1_000_000
    const t = await app('0', { now: () => clock })
    const upload = (): Promise<ClaudeImportPlan> => t.deps.claudeImport.upload({ files: [{ path: 'CLAUDE.md', file: new Blob(['# Notes\n']) }] })
    const plans = [await upload(), await upload(), await upload(), await upload(), await upload()]
    const apply = (plan: ClaudeImportPlan): Promise<unknown> => t.deps.claudeImport.apply({ planId: plan.id, items: [{ key: plan.items[0]!.key, action: 'skip' }] }, FRESH)
    await expect(apply(plans[0]!)).rejects.toMatchObject({ code: 'not_found', message: 'The import plan expired. Read the folder again.' })
    await expect(apply(plans[1]!)).resolves.toMatchObject({ counts: { skipped: 1 } })
    // Applied once: gone.
    await expect(apply(plans[1]!)).rejects.toMatchObject({ code: 'not_found' })
    clock += LIMITS.claudeImportPlanTtlMs
    await expect(apply(plans[2]!)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a key rotation and stop() drop every plan', async () => {
    const t = await app('0')
    const plan = await t.deps.claudeImport.upload({ files: [{ path: 'CLAUDE.md', file: new Blob(['# Notes\n']) }] })
    const body = { planId: plan.id, items: [{ key: plan.items[0]!.key, action: 'skip' as const }] }
    t.deps.events.emit('key.rotated', { keyVersion: 2, rotatedAt: 1, chatIds: [] })
    await expect(t.deps.claudeImport.apply(body, FRESH)).rejects.toMatchObject({ code: 'not_found' })
    const again = await t.deps.claudeImport.upload({ files: [{ path: 'CLAUDE.md', file: new Blob(['# Notes\n']) }] })
    await t.deps.claudeImport.stop()
    await t.deps.claudeImport.stop()
    await expect(t.deps.claudeImport.apply({ ...body, planId: again.id }, FRESH)).rejects.toMatchObject({ code: 'not_found' })
  })
})
