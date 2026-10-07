// The project definition editor (Phase 12, ADR-056; W12.4-T1 … T5): read, write and remove a project's definition files,
// the `hooks` key of its settings files and the `mcpServers` key of `.mcp.json` through the path guard, the file lock and
// the stale check; not journaled, `workspace.changed { source: 'user' }`, the pending count, and saving never approves.
import type { HarnessError, ProjectDefinitionWriteBody } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeChatRunner, RecordingEventBus } from '../../testing/fakes.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chats, projectTrust, workspaceChanges } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeChatRunner, createRecordingEventBus } from '../../testing/fakes.ts'
import { HOOK_LOG_FILE, writeHookScript } from '../../testing/hook-scripts.ts'
import { withFileLock } from '../../workspace/file-lock.ts'
import { createProjectDefinitionsService } from './index.ts'

const cleanups: Array<() => Promise<void>> = []
const CHAT = '0199a8f0-0000-7000-8000-00000000d0f1'
const SENTINEL = 'body-sentinel-5c1e'
const AGENT = `---\nname: reviewer\ndescription: Reviews code.\n---\nReview carefully. ${SENTINEL}\n`
const AGENT_2 = `---\nname: reviewer\ndescription: Reviews code twice.\ncolor: purple\nfoo: bar\n---\nReview twice. ${SENTINEL}\n`
const UNKNOWN_PROJECT = 'prj_AAAAAAAAAAAAAAAA'

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

interface Harness {
  t: TestApp
  events: RecordingEventBus
  runs: FakeChatRunner
  projectId: string
  base: string
  root: string
  put: (rel: string, content: string | Uint8Array) => Promise<void>
  text: (rel: string) => Promise<string>
}

async function setup(): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const events = createRecordingEventBus()
  const runs = createFakeChatRunner({}, { events })
  const t = await createTestApp({ builtins: [], workspaceRoots: [base], overrides: { events, runs } })
  cleanups.push(() => t.close())
  const project = await t.deps.projects.create({ name: 'Demo', path: base, newFolder: 'demo' })
  const root = join(base, 'demo')
  const put = async (rel: string, content: string | Uint8Array): Promise<void> => {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  const text = async (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
  events.clear()
  return { t, events, runs, projectId: project.id, base, root, put, text }
}

function sha(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

async function refusal(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a refusal')
}

function userChanges(h: Harness): unknown[] {
  return h.events.ofType('workspace.changed').map(event => event.data)
}

function settings(hooks: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, hooks })
}

describe('projectDefinitions.read (W12.4-T2)', () => {
  it('answers each kind with its raw text, sha256 and the diagnostics of its parser; a missing file is exists: false', async () => {
    const h = await setup()
    const command = 'Deploy now: !`git status`\n'
    const skill = '---\nname: pdf\ndescription: PDF tools.\n---\nUse the PDF tools.\n'
    const style = '---\nname: Terse\ndescription: Short answers.\n---\nBe short.\n'
    const settingsText = settings({ Nope: [], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh .claude/hooks/check.sh' }] }] }, { permissions: {} })
    const mcp = JSON.stringify({ mcpServers: { broken: { type: 'ftp', url: 'ftp://example.invalid' } } })
    await h.put('.claude/agents/reviewer.md', AGENT_2)
    await h.put('.claude/commands/ops/deploy.md', command)
    await h.put('.harness/skills/pdf/SKILL.md', skill)
    await h.put('.claude/output-styles/terse.md', style)
    await h.put('.claude/settings.json', settingsText)
    await h.put('.mcp.json', mcp)
    const definitions = h.t.deps.projectDefinitions

    expect(await definitions.read(h.projectId, '.claude/agents/reviewer.md')).toEqual({
      path: '.claude/agents/reviewer.md',
      kind: 'agent',
      exists: true,
      content: AGENT_2,
      sha256: sha(AGENT_2),
      diagnostics: [{ level: 'info', code: 'ignored-key', message: 'Line 5: The key "foo" is ignored.', line: 5 }],
    })
    expect(await definitions.read(h.projectId, '.claude/commands/ops/deploy.md')).toMatchObject({ kind: 'command', exists: true, content: command, sha256: sha(command), diagnostics: [] })
    expect(await definitions.read(h.projectId, '.harness/skills/pdf/SKILL.md')).toMatchObject({ kind: 'skill', content: skill, diagnostics: [] })
    expect(await definitions.read(h.projectId, '.claude/output-styles/terse.md')).toMatchObject({ kind: 'style', content: style, diagnostics: [] })
    const settingsFile = await definitions.read(h.projectId, '.claude/settings.json')
    expect(settingsFile).toMatchObject({ kind: 'settings', content: settingsText, sha256: sha(settingsText) })
    expect(settingsFile.diagnostics.map(item => item.code)).toEqual(['unknown-event'])
    const mcpFile = await definitions.read(h.projectId, '.mcp.json')
    expect(mcpFile).toMatchObject({ kind: 'mcp', content: mcp, diagnostics: [{ level: 'error', code: 'unsupported-type' }] })

    for (const path of ['.claude/agents/missing.md', '.harness/settings.local.json', '.harness/skills/none/SKILL.md']) {
      const missing = await definitions.read(h.projectId, path)
      expect(missing, path).toMatchObject({ path, exists: false, content: null, sha256: null, diagnostics: [] })
    }
    // Never a content in the logs.
    expect(JSON.stringify(h.t.logs.records)).not.toContain(SENTINEL)
  })

  it('a definition over 64 KiB or a binary file: content null with its sha256 and an error; a BOM survives', async () => {
    const h = await setup()
    const big = `---\nname: big\ndescription: Big.\n---\n${'x'.repeat(70_000)}\n`
    await h.put('.claude/agents/big.md', big)
    expect(await h.t.deps.projectDefinitions.read(h.projectId, '.claude/agents/big.md')).toMatchObject({
      exists: true,
      content: null,
      sha256: sha(big),
      diagnostics: [{ level: 'error', code: 'too-large' }],
    })
    const binary = Buffer.from([0x2D, 0x2D, 0x2D, 0x0A, 0x00, 0x01])
    await h.put('.claude/agents/bin.md', binary)
    expect(await h.t.deps.projectDefinitions.read(h.projectId, '.claude/agents/bin.md')).toMatchObject({ content: null, sha256: sha(binary), diagnostics: [{ code: 'binary' }] })
    const withBom = `\uFEFF${AGENT}`
    await h.put('.claude/agents/bom.md', withBom)
    const file = await h.t.deps.projectDefinitions.read(h.projectId, '.claude/agents/bom.md')
    expect(file.content).toBe(withBom)
    expect(file.sha256).toBe(sha(withBom))
  })

  it('404 for an unknown project and an unavailable folder; 400 for a refused path', async () => {
    const h = await setup()
    expect((await refusal(h.t.deps.projectDefinitions.read(UNKNOWN_PROJECT, '.claude/agents/a.md'))).code).toBe('not_found')
    for (const path of ['../x', '.git/config', '.env', '.claude/agents/../../x.md'])
      expect((await refusal(h.t.deps.projectDefinitions.read(h.projectId, path))).code, path).toBe('validation_error')
    await rename(h.root, join(h.base, 'gone'))
    expect((await refusal(h.t.deps.projectDefinitions.read(h.projectId, '.claude/agents/a.md'))).code).toBe('not_found')
  })
})

describe.skipIf(process.platform === 'win32')('the path guard (W12.4-T1)', () => {
  it('refuses a linked .claude folder, a linked file and a link out of the project for read, write and remove', async () => {
    const h = await setup()
    await h.put('elsewhere/agents/a.md', AGENT)
    await symlink(join(h.root, 'elsewhere'), join(h.root, '.claude'))
    const outside = join(h.base, 'outside')
    await mkdir(outside)
    await symlink(outside, join(h.root, '.harness'))
    const definitions = h.t.deps.projectDefinitions

    for (const path of ['.claude/agents/a.md', '.claude/settings.json', '.harness/agents/a.md', '.harness/settings.json']) {
      expect((await refusal(definitions.read(h.projectId, path))).code, path).toBe('validation_error')
      const body: ProjectDefinitionWriteBody = path.endsWith('.md') ? { path, expectedSha256: null, content: AGENT } : { path, expectedSha256: null, hooks: {} }
      expect((await refusal(definitions.write(h.projectId, body))).code, path).toBe('validation_error')
    }
    expect((await refusal(definitions.remove(h.projectId, '.claude/agents/a.md', sha(AGENT)))).code).toBe('validation_error')
    expect(await h.text('elsewhere/agents/a.md')).toBe(AGENT)
    expect(existsSync(join(h.root, 'elsewhere', 'settings.json'))).toBe(false)
    expect(existsSync(join(outside, 'agents'))).toBe(false)

    await rm(join(h.root, '.claude'))
    await h.put('.claude/agents/real.md', AGENT)
    await symlink(join(h.root, '.claude', 'agents', 'real.md'), join(h.root, '.claude', 'agents', 'linked.md'))
    expect((await refusal(definitions.read(h.projectId, '.claude/agents/linked.md'))).message).toContain('symbolic link')
    expect((await refusal(definitions.write(h.projectId, { path: '.claude/agents/linked.md', expectedSha256: sha(AGENT), content: AGENT_2 }))).code).toBe('validation_error')
    expect(await h.text('.claude/agents/real.md')).toBe(AGENT)
    expect(userChanges(h)).toEqual([])
  })

  it('refuses .git, secret-looking names and paths outside the editable set', async () => {
    const h = await setup()
    for (const path of ['.git/config', '.env', '../x', '.claude/agents/../../x.md', '.claude/commands/.git/x.md', '.claude/commands/secrets.md', 'src/index.ts']) {
      expect((await refusal(h.t.deps.projectDefinitions.write(h.projectId, { path, expectedSha256: null, content: AGENT }))).code, path).toBe('validation_error')
    }
    expect(existsSync(join(h.root, '.claude'))).toBe(false)
  })
})

describe('projectDefinitions.write (W12.4-T3)', () => {
  it('creates and updates a definition byte for byte, not journaled, with workspace.changed source user', async () => {
    const h = await setup()
    const definitions = h.t.deps.projectDefinitions
    const created = await definitions.write(h.projectId, { path: '.claude/agents/reviewer.md', expectedSha256: null, content: AGENT })
    expect(created).toEqual({ path: '.claude/agents/reviewer.md', sha256: sha(AGENT), created: true, diagnostics: [], trust: { pending: 0 } })
    expect(await h.text('.claude/agents/reviewer.md')).toBe(AGENT)

    const updated = await definitions.write(h.projectId, { path: '.claude/agents/reviewer.md', expectedSha256: created.sha256, content: AGENT_2 })
    expect(updated).toMatchObject({ sha256: sha(AGENT_2), created: false, diagnostics: [{ level: 'info', code: 'ignored-key' }] })
    expect(await h.text('.claude/agents/reviewer.md')).toBe(AGENT_2)

    expect(userChanges(h)).toEqual([
      { projectId: h.projectId, chatId: null, batchId: null, source: 'user', paths: ['.claude/agents/reviewer.md'] },
      { projectId: h.projectId, chatId: null, batchId: null, source: 'user', paths: ['.claude/agents/reviewer.md'] },
    ])
    // Not journaled: no change row (and so no checkpoint blob).
    expect(await h.t.db.select().from(workspaceChanges)).toEqual([])
    // The catalog sees the new file at once (the event dropped its cache).
    const catalog = await h.t.deps.customizations.catalog(h.projectId)
    expect(catalog.entries.some(entry => entry.kind === 'agent' && entry.name === 'reviewer' && entry.source === 'project')).toBe(true)
    // Contents are never logged; the path only at debug.
    const logged = h.t.logs.records.filter(record => record.msg === 'project definition saved')
    expect(logged).toHaveLength(2)
    expect(JSON.stringify(h.t.logs.records)).not.toContain(SENTINEL)
  })

  it('creates skills, nested commands and output styles under both roots', async () => {
    const h = await setup()
    const definitions = h.t.deps.projectDefinitions
    const skill = '---\nname: pdf\ndescription: PDF tools.\n---\nUse them.\n'
    expect((await definitions.write(h.projectId, { path: '.harness/skills/pdf/SKILL.md', expectedSha256: null, content: skill })).created).toBe(true)
    expect((await definitions.write(h.projectId, { path: '.claude/commands/db/migrate.md', expectedSha256: null, content: 'Migrate the database.\n' })).created).toBe(true)
    expect((await definitions.write(h.projectId, { path: '.claude/output-styles/terse.md', expectedSha256: null, content: '---\nname: Terse\ndescription: Short.\n---\nBe short.\n' })).created).toBe(true)
    expect(await h.text('.harness/skills/pdf/SKILL.md')).toBe(skill)
    expect(await h.text('.claude/commands/db/migrate.md')).toBe('Migrate the database.\n')
  })

  it('400 with details.diagnostics for an invalid definition; nothing written, no event', async () => {
    const h = await setup()
    const error = await refusal(h.t.deps.projectDefinitions.write(h.projectId, { path: '.claude/agents/bad.md', expectedSha256: null, content: '---\nname: Bad Name\n---\nx' }))
    expect(error).toMatchObject({
      code: 'validation_error',
      details: {
        diagnostics: expect.arrayContaining([expect.objectContaining({ level: 'error', code: 'invalid-name', line: 2 }), expect.objectContaining({ code: 'missing-field' })]),
        issues: [{ path: ['content'] }],
      },
    })
    expect(existsSync(join(h.root, '.claude'))).toBe(false)
    expect(userChanges(h)).toEqual([])
  })

  it('409 stale: another sha, null for an existing file, a sha for a missing file; the file is unchanged', async () => {
    const h = await setup()
    await h.put('.claude/agents/reviewer.md', AGENT)
    const definitions = h.t.deps.projectDefinitions
    for (const expectedSha256 of [null, sha('other'), 'f'.repeat(64)]) {
      const error = await refusal(definitions.write(h.projectId, { path: '.claude/agents/reviewer.md', expectedSha256, content: AGENT_2 }))
      expect(error).toMatchObject({ code: 'conflict', message: 'The file changed on disk. Load it again or overwrite it.', details: { reason: 'stale' } })
    }
    expect(await h.text('.claude/agents/reviewer.md')).toBe(AGENT)
    expect((await refusal(definitions.write(h.projectId, { path: '.claude/agents/new.md', expectedSha256: sha(AGENT), content: AGENT }))).details).toEqual({ reason: 'stale' })
    expect(existsSync(join(h.root, '.claude', 'agents', 'new.md'))).toBe(false)
    expect(userChanges(h)).toEqual([])
  })

  it('the stale check runs under the lock: two saves of one version, one wins; a file created while waiting is stale', async () => {
    const h = await setup()
    await h.put('.claude/agents/reviewer.md', AGENT)
    const definitions = h.t.deps.projectDefinitions
    const results = await Promise.allSettled([
      definitions.write(h.projectId, { path: '.claude/agents/reviewer.md', expectedSha256: sha(AGENT), content: AGENT_2 }),
      definitions.write(h.projectId, { path: '.claude/agents/reviewer.md', expectedSha256: sha(AGENT), content: AGENT.replace('carefully', 'quickly') }),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })

    // A file created by someone else between the path check and the lock (the lock held meanwhile).
    await mkdir(join(h.root, '.harness', 'agents'), { recursive: true })
    const target = join(h.root, '.harness', 'agents', 'race.md')
    let release!: () => void
    const held = withFileLock(target, () => new Promise<void>((done) => {
      release = done
    }))
    const save = definitions.write(h.projectId, { path: '.harness/agents/race.md', expectedSha256: null, content: AGENT })
    await sleep(100)
    await writeFile(target, 'written by another editor\n')
    release()
    await held
    expect(await refusal(save)).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    expect(await h.text('.harness/agents/race.md')).toBe('written by another editor\n')
  })

  it('a settings file: the hooks splice keeps the other keys and their order; null removes the key; a missing file is created', async () => {
    const h = await setup()
    const original = JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [] }, env: { A: '1' } }, null, 4)
    await h.put('.claude/settings.json', original)
    const definitions = h.t.deps.projectDefinitions
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh .claude/hooks/check.sh', timeout: 5 }] }] }
    const saved = await definitions.write(h.projectId, { path: '.claude/settings.json', expectedSha256: sha(original), hooks })
    const text = await h.text('.claude/settings.json')
    expect(text).toBe(`${JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks, env: { A: '1' } }, null, 2)}\n`)
    expect(saved).toMatchObject({ path: '.claude/settings.json', sha256: sha(text), created: false, diagnostics: [] })
    expect(saved.trust.pending).toBe(1)

    const removed = await definitions.write(h.projectId, { path: '.claude/settings.json', expectedSha256: saved.sha256, hooks: null })
    expect(JSON.parse(await h.text('.claude/settings.json'))).toEqual({ permissions: { allow: ['Bash(ls)'] }, env: { A: '1' } })
    expect(removed.trust.pending).toBe(0)

    const createdLocal = await definitions.write(h.projectId, { path: '.harness/settings.local.json', expectedSha256: null, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } })
    expect(createdLocal.created).toBe(true)
    expect(JSON.parse(await h.text('.harness/settings.local.json'))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } })
  })

  it('settings: hook errors are 400 with diagnostics, warnings are kept, a broken file on disk is refused', async () => {
    const h = await setup()
    const definitions = h.t.deps.projectDefinitions
    const error = await refusal(definitions.write(h.projectId, { path: '.claude/settings.json', expectedSha256: null, hooks: { PreToolUse: 'not a list' } }))
    expect(error).toMatchObject({ code: 'validation_error', details: { diagnostics: [{ level: 'error', code: 'not-an-object' }], issues: [{ path: ['hooks'] }] } })
    expect(existsSync(join(h.root, '.claude'))).toBe(false)

    const warned = await definitions.write(h.projectId, {
      path: '.claude/settings.json',
      expectedSha256: null,
      hooks: { Nope: [], Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the task done? $ARGUMENTS' }, { type: 'agent' }] }] },
    })
    expect(warned.diagnostics.map(item => [item.level, item.code])).toEqual([['info', 'unknown-event'], ['warning', 'unsupported-type']])

    const broken = '{"hooks": '
    await h.put('.harness/settings.json', broken)
    expect(await refusal(definitions.write(h.projectId, { path: '.harness/settings.json', expectedSha256: sha(broken), hooks: {} })))
      .toMatchObject({ code: 'validation_error', details: { diagnostics: [{ code: 'invalid-json' }] } })
    expect(await h.text('.harness/settings.json')).toBe(broken)
  })

  it('.mcp.json: mcpServers saved, other keys kept, null removes it, an invalid server is 400', async () => {
    const h = await setup()
    const definitions = h.t.deps.projectDefinitions
    const original = JSON.stringify({ $schema: 'https://example.invalid/schema.json', mcpServers: { old: { command: 'node', args: ['old.mjs'] } } })
    await h.put('.mcp.json', original)
    const servers = { local: { command: 'node', args: ['./servers/mcp.mjs'] } }
    const saved = await definitions.write(h.projectId, { path: '.mcp.json', expectedSha256: sha(original), mcpServers: servers })
    expect(JSON.parse(await h.text('.mcp.json'))).toEqual({ $schema: 'https://example.invalid/schema.json', mcpServers: servers })
    expect(saved.diagnostics.map(item => item.code)).toEqual(['ignored-field'])
    expect(saved.trust.pending).toBe(1)

    const invalid = await refusal(definitions.write(h.projectId, { path: '.mcp.json', expectedSha256: saved.sha256, mcpServers: { broken: { type: 'ftp', url: 'ftp://example.invalid' } } }))
    expect(invalid).toMatchObject({ code: 'validation_error', details: { diagnostics: [{ level: 'error', code: 'unsupported-type' }], issues: [{ path: ['mcpServers'] }] } })

    const cleared = await definitions.write(h.projectId, { path: '.mcp.json', expectedSha256: saved.sha256, mcpServers: null })
    expect(JSON.parse(await h.text('.mcp.json'))).toEqual({ $schema: 'https://example.invalid/schema.json' })
    expect(cleared.trust.pending).toBe(0)
  })

  it('a body whose field does not match the kind of its path is 400', async () => {
    const h = await setup()
    const definitions = h.t.deps.projectDefinitions
    expect((await refusal(definitions.write(h.projectId, { path: '.claude/agents/a.md', expectedSha256: null, hooks: {} } as ProjectDefinitionWriteBody))).code).toBe('validation_error')
    expect((await refusal(definitions.write(h.projectId, { path: '.claude/settings.json', expectedSha256: null, content: AGENT } as ProjectDefinitionWriteBody))).code).toBe('validation_error')
    expect((await refusal(definitions.write(UNKNOWN_PROJECT, { path: '.claude/agents/a.md', expectedSha256: null, content: AGENT }))).code).toBe('not_found')
  })

  it('works while a chat of the project runs (no idle rule)', async () => {
    const h = await setup()
    await h.t.db.insert(chats).values({ id: CHAT, projectId: h.projectId })
    h.runs.phases.set(CHAT, 'streaming')
    expect(h.t.deps.runs.hasRun(CHAT)).toBe(true)
    const saved = await h.t.deps.projectDefinitions.write(h.projectId, { path: '.claude/agents/reviewer.md', expectedSha256: null, content: AGENT })
    expect(saved.created).toBe(true)
    expect(h.runs.stopped).toEqual([])
  })
})

describe('projectDefinitions.remove (W12.4-T4)', () => {
  it('deletes a definition with its sha; stale, missing and non-markdown paths are refused', async () => {
    const h = await setup()
    await h.put('.claude/agents/reviewer.md', AGENT)
    await h.put('.claude/settings.json', '{}')
    const definitions = h.t.deps.projectDefinitions
    expect(await refusal(definitions.remove(h.projectId, '.claude/agents/reviewer.md', sha('other')))).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    expect(await h.text('.claude/agents/reviewer.md')).toBe(AGENT)
    expect((await refusal(definitions.remove(h.projectId, '.claude/settings.json', sha('{}')))).code).toBe('validation_error')
    expect((await refusal(definitions.remove(h.projectId, '.mcp.json', sha('{}')))).code).toBe('validation_error')
    expect((await refusal(definitions.remove(h.projectId, '.claude/agents/missing.md', sha(AGENT)))).code).toBe('not_found')
    expect((await refusal(definitions.remove(UNKNOWN_PROJECT, '.claude/agents/reviewer.md', sha(AGENT)))).code).toBe('not_found')
    expect(userChanges(h)).toEqual([])

    await definitions.remove(h.projectId, '.claude/agents/reviewer.md', sha(AGENT))
    expect(existsSync(join(h.root, '.claude', 'agents', 'reviewer.md'))).toBe(false)
    expect(existsSync(join(h.root, '.claude', 'agents'))).toBe(true)
    expect(userChanges(h)).toEqual([{ projectId: h.projectId, chatId: null, batchId: null, source: 'user', paths: ['.claude/agents/reviewer.md'] }])
    expect(await h.t.db.select().from(workspaceChanges)).toEqual([])
  })

  it('removes a skill folder left empty, keeps one with other files', async () => {
    const h = await setup()
    const skill = '---\nname: pdf\ndescription: PDF tools.\n---\nUse them.\n'
    await h.put('.claude/skills/pdf/SKILL.md', skill)
    await h.put('.claude/skills/docx/SKILL.md', skill.replace('pdf', 'docx'))
    await h.put('.claude/skills/docx/scripts/convert.sh', 'echo convert\n')
    await h.t.deps.projectDefinitions.remove(h.projectId, '.claude/skills/pdf/SKILL.md', sha(skill))
    expect(existsSync(join(h.root, '.claude', 'skills', 'pdf'))).toBe(false)
    expect(existsSync(join(h.root, '.claude', 'skills'))).toBe(true)
    await h.t.deps.projectDefinitions.remove(h.projectId, '.claude/skills/docx/SKILL.md', sha(skill.replace('pdf', 'docx')))
    expect(existsSync(join(h.root, '.claude', 'skills', 'docx', 'SKILL.md'))).toBe(false)
    expect(existsSync(join(h.root, '.claude', 'skills', 'docx', 'scripts', 'convert.sh'))).toBe(true)
  })
})

describe('saving never approves (W12.4-T5)', () => {
  it('a saved hook stays pending: no trust row, absent from the hook snapshot and never run until approved', async () => {
    const h = await setup()
    const command = await writeHookScript(h.root, 'record')
    const saved = await h.t.deps.projectDefinitions.write(h.projectId, {
      path: '.claude/settings.json',
      expectedSha256: null,
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] },
    })
    expect(saved.trust.pending).toBeGreaterThanOrEqual(1)
    expect(await h.t.db.select().from(projectTrust)).toEqual([])
    expect((await h.t.deps.projectTrust.approved(h.projectId)).size).toBe(0)

    const opened = await h.t.deps.projects.openWorkspace(h.projectId)
    if (!opened.ok)
      throw new Error(opened.message)
    const scope = { chatId: CHAT, projectId: h.projectId, workspace: opened.workspace, toolMode: 'ask', origin: 'request', modelRef: 'mock:echo' } as const
    expect((await h.t.deps.hooks.snapshot(scope)).has('UserPromptSubmit')).toBe(false)
    expect(existsSync(join(h.root, HOOK_LOG_FILE))).toBe(false)

    // Only the fresh-auth approval makes it run.
    const list = await h.t.deps.projectTrust.list(h.projectId)
    const item = list.items.find(entry => entry.kind === 'hook' && entry.state === 'pending')
    expect(item).toBeDefined()
    await h.t.deps.projectTrust.approve(h.projectId, [{ kind: 'hook', sha256: item!.sha256 }])
    h.t.deps.hooks.invalidate(h.projectId)
    expect((await h.t.deps.hooks.snapshot(scope)).has('UserPromptSubmit')).toBe(true)
    expect(await h.t.deps.projectTrust.pending(h.projectId)).toBe(0)
  })

  it('a saved .mcp.json server and a command with ! spans are pending too', async () => {
    const h = await setup()
    const mcp = await h.t.deps.projectDefinitions.write(h.projectId, { path: '.mcp.json', expectedSha256: null, mcpServers: { local: { command: 'node', args: ['./server.mjs'] } } })
    expect(mcp.trust.pending).toBe(1)
    const spans = await h.t.deps.projectDefinitions.write(h.projectId, { path: '.claude/commands/status.md', expectedSha256: null, content: 'Status: !`git status`\n' })
    expect(spans.trust.pending).toBe(2)
    expect(await h.t.db.select().from(projectTrust)).toEqual([])
  })

  it('a save of a known project announces project-trust.changed with the new count and hooks.changed (W12.4 ↔ W12.5)', async () => {
    const h = await setup()
    // The project's config was read once (the trust chip, the hooks list), so a change is noticed against it.
    expect(await h.t.deps.projectTrust.pending(h.projectId)).toBe(0)
    h.events.clear()
    await h.t.deps.projectDefinitions.write(h.projectId, {
      path: '.harness/settings.json',
      expectedSha256: null,
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
    })
    await vi.waitFor(() => {
      expect(h.events.ofType('project-trust.changed').map(event => event.data)).toContainEqual({ projectId: h.projectId, pending: 1 })
      expect(h.events.ofType('hooks.changed').map(event => event.data)).toContainEqual({ projectId: h.projectId })
    })
  })
})

describe('createProjectDefinitionsService', () => {
  it('is the service of the deps (no state, no lifecycle)', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    const service = createProjectDefinitionsService(t.deps)
    expect(Object.keys(service).sort()).toEqual(['read', 'remove', 'write'])
    expect((await refusal(service.read(UNKNOWN_PROJECT, '.claude/agents/a.md'))).code).toBe('not_found')
  })
})
