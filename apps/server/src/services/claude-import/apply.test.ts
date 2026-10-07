/* eslint-disable no-template-curly-in-string -- `${VAR}` references are literal `.claude.json` content */
// Apply of the home-folder import (W12.3-T4) against the C43 fakes of the customization and hook services (their real
// `importDefinitions` / `importPersonal` belong to W12.7 / W12.5), a recording MCP manager (no client, no network) and
// the real shell rules, tool overrides and settings: fresh auth first; one `customization.changed` and one
// `hooks.changed`; command hooks, `!` commands and stdio servers off unless enabled, prompt hooks on, per-project
// servers always off; overwrite / rename; Bash rules → global shell rules; `${VAR}` from the body, then the imported
// `env`, then the default, never `process.env`; `CLAUDE.md` append / replace; the re-check against the current state;
// 400 / 404; no canary in an answer or a log.
import type { ClaudeImportApplyBody, ClaudeImportPlan, ServerEvent } from '@harness-forge/shared'
import type { FixtureTree } from '../../testing/claude-fixtures.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../../testing/fake-customizations.ts'
import type { FakeHookService } from '../../testing/fake-hooks.ts'
import type { RecordingMcpManager } from './fixtures.test-util.ts'
import process from 'node:process'
import { claudeImportApplyResultSchema, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { freshAuthRequiredError } from '../../http/middleware/fresh-auth.ts'
import { CLAUDE_HOME_CANARIES, fakeClaudeHomeFiles } from '../../testing/claude-fixtures.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { cleanupImportFixtures, createRecordingMcpManager, hasCanary, recordEvents, uploadOfHome } from './fixtures.test-util.ts'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  await cleanupImportFixtures()
})

const FRESH = { requireFreshAuth: () => {} }
const STALE = { requireFreshAuth: () => {
  throw freshAuthRequiredError()
} }

interface Harness {
  t: TestApp
  customizations: FakeCustomizationService
  hooks: FakeHookService
  mcp: RecordingMcpManager
  events: ServerEvent[]
}

async function harness(options: { mcp?: RecordingMcpManager | 'real', builtins?: boolean } = {}): Promise<Harness> {
  const mcp = options.mcp === 'real' ? null : options.mcp ?? createRecordingMcpManager()
  const t = await createTestApp({
    start: false,
    ...(options.builtins === true ? {} : { builtins: [] }),
    env: { HF_CLAUDE_HOME: '0' },
    customizations: 'fake',
    hooks: 'fake',
    ...(mcp === null ? {} : { overrides: { mcp } }),
  })
  apps.push(t)
  return {
    t,
    customizations: t.deps.customizations as FakeCustomizationService,
    hooks: t.deps.hooks as FakeHookService,
    mcp: mcp ?? createRecordingMcpManager(),
    events: recordEvents(t.deps),
  }
}

async function planOf(h: Harness, tree: FixtureTree = fakeClaudeHomeFiles()): Promise<ClaudeImportPlan> {
  return h.t.deps.claudeImport.upload(uploadOfHome(tree))
}

function item(plan: ClaudeImportPlan, kind: string, name: string): ClaudeImportPlan['items'][number] {
  const found = plan.items.find(entry => entry.kind === kind && entry.name === name)
  if (found === undefined)
    throw new Error(`no ${kind} ${name} in the plan`)
  return found
}

/** Every item that offers its default action other than skip, picked with it. */
function defaults(plan: ClaudeImportPlan): ClaudeImportApplyBody['items'] {
  return plan.items.filter(entry => entry.actions.includes(entry.defaultAction) && entry.defaultAction !== 'skip').map(entry => ({ key: entry.key, action: entry.defaultAction }))
}

function changed(events: readonly ServerEvent[], type: ServerEvent['type']): number {
  return events.filter(event => event.type === type).length
}

/** Runs `task` with `process.env` canaries for the variables of the fake home (proves they are never read). */
async function withProcessEnvCanaries<T>(task: () => Promise<T>): Promise<T> {
  const saved = { REVIEW_API_TOKEN: process.env.REVIEW_API_TOKEN, TEAM_ID: process.env.TEAM_ID, HOST: process.env.HOST }
  process.env.REVIEW_API_TOKEN = CLAUDE_HOME_CANARIES.processEnv
  process.env.TEAM_ID = CLAUDE_HOME_CANARIES.processEnv
  process.env.HOST = CLAUDE_HOME_CANARIES.processEnv
  try {
    return await task()
  }
  finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined)
        delete process.env[name]
      else
        process.env[name] = value
    }
  }
}

describe('apply', () => {
  it('asks for fresh auth first: 403 changes nothing and keeps the plan', async () => {
    const h = await harness()
    const plan = await planOf(h)
    const body = { planId: plan.id, items: defaults(plan) }
    await expect(h.t.deps.claudeImport.apply(body, STALE)).rejects.toMatchObject({ code: 'forbidden', action: 'login' })
    expect(h.customizations.calls.importDefinitions + h.hooks.calls.importPersonal + h.mcp.created.length).toBe(0)
    expect(changed(h.events, 'customization.changed') + changed(h.events, 'hooks.changed')).toBe(0)
    await expect(h.t.deps.claudeImport.apply(body, FRESH)).resolves.toMatchObject({ counts: { failed: expect.any(Number) } })
  })

  it('applies the defaults in one pass: executables off, prompt hooks on, Bash rules → global shell rules, servers, CLAUDE.md, outputStyle; one event of each', async () => {
    const h = await harness()
    const plan = await planOf(h)
    const deploy = item(plan, 'command', 'deploy')
    const result = claudeImportApplyResultSchema.parse(await withProcessEnvCanaries(() => h.t.deps.claudeImport.apply({ planId: plan.id, items: defaults(plan) }, FRESH)))

    expect(changed(h.events, 'customization.changed')).toBe(1)
    expect(changed(h.events, 'hooks.changed')).toBe(1)
    expect(h.customizations.calls.importDefinitions).toBe(1)
    expect(h.hooks.calls.importPersonal).toBe(1)

    // Definitions: the `!` command arrives turned off, the others on.
    const personal = [...h.customizations.personal.values()]
    expect(personal.map(row => [row.kind, row.name, row.enabled]).sort()).toEqual([
      ['agent', 'planner', true],
      ['agent', 'reviewer', true],
      ['command', 'clean-gone', true],
      ['command', 'db-migrate-up', true],
      ['command', 'deploy', false],
      ['command', 'frontend-component', true],
      ['skill', 'pdf', true],
      ['style', 'terse', true],
    ])
    expect(result.results.find(entry => entry.key === deploy.key)).toMatchObject({ outcome: 'created', id: expect.stringMatching(/^cus_/) })

    // Hooks: command hooks off, prompt hooks on; the handler fields are kept.
    const imported = [...h.hooks.personal.values()]
    expect(imported.map(hook => [hook.event, hook.type, hook.enabled]).sort()).toEqual([
      ['PostToolUse', 'command', false],
      ['PreToolUse', 'command', false],
      ['Stop', 'prompt', true],
      ['UserPromptSubmit', 'prompt', true],
    ])
    expect(h.hooks.imported.find(hook => hook.event === 'PostToolUse')).toMatchObject({ type: 'command', matcher: 'Write|Edit', statusMessage: 'Formatting…', enabled: false })
    expect(h.hooks.imported.find(hook => hook.event === 'UserPromptSubmit')).toMatchObject({ type: 'prompt', model: 'haiku', enabled: true })
    expect(h.hooks.imported.find(hook => hook.event === 'PreToolUse')).toMatchObject({ command: 'sh ~/.claude/hooks/check-bash.sh', timeout: 10, matcher: 'Bash' })

    // Shell rules: global; the refused prefixes were never offered.
    expect((await h.t.deps.shellRules.list()).map(rule => [rule.projectId, rule.prefix])).toEqual([[null, 'git diff'], [null, 'git status'], [null, 'npm run test']])

    // MCP servers: ${VAR} from the imported env, then the default, never process.env; stdio and per-project off.
    const servers = new Map(h.mcp.created.map(input => [input.id, input]))
    expect(servers.get('docs-api')).toEqual({
      id: 'docs-api',
      name: 'docs-api',
      enabled: true,
      transport: { type: 'http', url: 'https://docs.example.com/mcp', headers: { 'Authorization': `Bearer ${CLAUDE_HOME_CANARIES.envValue}`, 'X-Team': 'core' } },
    })
    expect(servers.get('local-tools')).toMatchObject({ enabled: false, transport: { type: 'stdio', command: 'node', args: ['/opt/tools/server.mjs', '--stdio'], env: { TOOLS_TOKEN: CLAUDE_HOME_CANARIES.mcpEnvValue } } })
    expect(servers.get('app-db')).toMatchObject({ enabled: false, transport: { type: 'stdio', command: 'npx' } })
    expect(JSON.stringify(h.mcp.created)).not.toContain(CLAUDE_HOME_CANARIES.processEnv)

    // Settings: CLAUDE.md into the empty instructions, the imported output style.
    const settings = await h.t.deps.settings.get()
    expect(settings.instructions).toBe(fakeClaudeHomeFiles()['.claude/CLAUDE.md']!.content.toString().trim())
    expect(settings.outputStyle).toBe('terse')

    // The whole-tool deny names a tool this server does not have (no builtins here).
    expect(result.results.find(entry => entry.key === item(plan, 'tool-deny', 'WebFetch').key)).toEqual({ key: item(plan, 'tool-deny', 'WebFetch').key, outcome: 'failed', message: 'The tool web_fetch is not available on this server.' })
    // The default output style is a setting that existed before (`updated`); everything else is new.
    expect(result.counts).toEqual({ created: result.results.length - 2, updated: 1, unchanged: 0, skipped: 0, failed: 1 })
    // What arrived turned off is not repeated as a warning: the browser knows it from the plan and its `enable`.
    expect(result.warnings).toEqual([])
    expect(hasCanary(JSON.stringify(result))).toBe(false)
    expect(hasCanary(h.t.logs.text())).toBe(false)
    expect(h.t.logs.records.filter(record => record.level === 'info').map(record => record.msg)).toContain('claude import applied')

    // Applied once: the plan is gone.
    await expect(h.t.deps.claudeImport.apply({ planId: plan.id, items: defaults(plan) }, FRESH)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('enable turns executables on; a stdio server create asks the MCP manager for fresh auth again', async () => {
    const h = await harness()
    const plan = await planOf(h)
    const picks = ['command:deploy', 'hook:PreToolUse (Bash)', 'mcp-server:local-tools', 'mcp-server:app-db'].map((id) => {
      const [kind, ...rest] = id.split(':')
      return item(plan, kind!, rest.join(':'))
    })
    const result = await h.t.deps.claudeImport.apply({ planId: plan.id, items: picks.map(entry => ({ key: entry.key, action: 'import', enable: true })) }, FRESH)
    expect(result.counts).toMatchObject({ created: 4, failed: 0 })
    expect([...h.customizations.personal.values()].map(row => [row.name, row.enabled])).toEqual([['deploy', true]])
    expect([...h.hooks.personal.values()].map(hook => hook.enabled)).toEqual([true])
    expect(h.mcp.created.map(input => [input.id, input.enabled])).toEqual([['local-tools', true], ['app-db', false]])
    expect(h.mcp.freshAuthCalls).toBe(2)
    expect(result.warnings).toEqual([])
    // Nothing of a kind changed: the apply still sends one event of each.
    expect(changed(h.events, 'customization.changed')).toBe(1)
    expect(changed(h.events, 'hooks.changed')).toBe(1)
  })

  it('overwrite keeps enabled, rename gives <name>-2; the statuses are checked again at apply', async () => {
    const h = await harness()
    const mine = await h.customizations.create({ kind: 'agent', content: '---\nname: reviewer\ndescription: Mine.\n---\nMine.\n' })
    await h.customizations.update(mine.id, { enabled: false })
    const plan = await planOf(h)
    const reviewer = item(plan, 'agent', 'reviewer')
    expect(reviewer).toMatchObject({ status: 'update', actions: ['skip', 'overwrite', 'rename'], defaultAction: 'skip', renameTo: 'reviewer-2' })
    const overwrite = await h.t.deps.claudeImport.apply({ planId: plan.id, items: [{ key: reviewer.key, action: 'overwrite' }] }, FRESH)
    expect(overwrite.results).toEqual([{ key: reviewer.key, outcome: 'updated', id: mine.id }])
    expect(h.customizations.personal.get(mine.id)).toMatchObject({ enabled: false, description: 'Reviews code for bugs and missing tests.' })

    // The same content again is unchanged; a new plan renames.
    const again = await planOf(h)
    expect(item(again, 'agent', 'reviewer').status).toBe('unchanged')
    await h.customizations.update(mine.id, { content: '---\nname: reviewer\ndescription: Mine again.\n---\nMine.\n' })
    const third = await planOf(h)
    const renamed = await h.t.deps.claudeImport.apply({ planId: third.id, items: [{ key: item(third, 'agent', 'reviewer').key, action: 'rename', renameTo: 'reviewer-2' }] }, FRESH)
    expect(renamed.counts).toMatchObject({ created: 1 })
    expect([...h.customizations.personal.values()].map(row => row.name).sort()).toEqual(['reviewer', 'reviewer-2'])

    // Created after the plan was read: the import fails instead of overwriting; an existing shell rule is unchanged.
    const fourth = await planOf(h)
    await h.customizations.create({ kind: 'agent', content: '---\nname: planner\ndescription: Another planner.\n---\nPlan.\n' })
    await h.t.deps.shellRules.create({ projectId: null, prefix: 'git diff' })
    const late = await h.t.deps.claudeImport.apply({ planId: fourth.id, items: [{ key: item(fourth, 'agent', 'planner').key, action: 'import' }, { key: item(fourth, 'shell-rule', 'git diff').key, action: 'import' }] }, FRESH)
    expect(late.results).toEqual([
      { key: item(fourth, 'agent', 'planner').key, outcome: 'failed', message: 'The item changed since the folder was read. Read the folder again.' },
      { key: item(fourth, 'shell-rule', 'git diff').key, outcome: 'unchanged' },
    ])
  })

  it('mCP conflicts: overwrite, rename, a plugin server; variables from the body, unresolved ones fail the item', async () => {
    const mcp = createRecordingMcpManager([{ id: 'plugin-api', name: 'plugin-api', transport: { type: 'http', url: 'https://plugin.example.com/mcp' } }])
    await mcp.create({ id: 'docs-api', name: 'docs-api', transport: { type: 'http', url: 'https://old.example.com/mcp' } })
    mcp.created.length = 0
    const h = await harness({ mcp })
    const tree: FixtureTree = {
      ...fakeClaudeHomeFiles(),
      '.claude.json': { content: JSON.stringify({ mcpServers: {
        'docs-api': { type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer ${REVIEW_API_TOKEN}' } },
        'plugin-api': { type: 'http', url: 'https://other.example.com/mcp' },
        'host-api': { type: 'http', url: 'https://${HOST}/mcp' },
      } }), mode: 0o644 },
    }
    const plan = await planOf(h, tree)
    expect(item(plan, 'mcp-server', 'docs-api')).toMatchObject({ status: 'conflict', actions: ['skip', 'overwrite', 'rename'], renameTo: 'docs-api-2' })
    expect(item(plan, 'mcp-server', 'host-api')).toMatchObject({ status: 'new', variables: ['HOST'], warnings: ['needs-variables'] })
    const body: ClaudeImportApplyBody = {
      planId: plan.id,
      items: [
        { key: item(plan, 'mcp-server', 'docs-api').key, action: 'overwrite' },
        { key: item(plan, 'mcp-server', 'plugin-api').key, action: 'overwrite' },
        { key: item(plan, 'mcp-server', 'host-api').key, action: 'import' },
      ],
    }
    const first = await withProcessEnvCanaries(() => h.t.deps.claudeImport.apply(body, FRESH))
    expect(first.results).toEqual([
      { key: body.items[0]!.key, outcome: 'updated', id: 'docs-api' },
      { key: body.items[1]!.key, outcome: 'failed', message: 'The MCP server plugin-api belongs to a plugin and cannot be changed.' },
      { key: body.items[2]!.key, outcome: 'failed', message: 'Set the variables HOST to import this server (needs-variables).' },
    ])
    expect(mcp.updated).toEqual([{ id: 'docs-api', patch: { name: 'docs-api', transport: { type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: `Bearer ${CLAUDE_HOME_CANARIES.envValue}` } } } }])

    const second = await planOf(h, tree)
    const renamed = await withProcessEnvCanaries(() => h.t.deps.claudeImport.apply({
      planId: second.id,
      items: [
        { key: item(second, 'mcp-server', 'plugin-api').key, action: 'rename', renameTo: 'other-api' },
        { key: item(second, 'mcp-server', 'host-api').key, action: 'import' },
      ],
      variables: { [item(second, 'mcp-server', 'host-api').key]: { HOST: 'api.example.com' } },
    }, FRESH))
    expect(renamed.counts).toMatchObject({ created: 2, failed: 0 })
    expect(mcp.created.map(input => [input.id, input.transport])).toEqual([
      ['other-api', { type: 'http', url: 'https://other.example.com/mcp', headers: {} }],
      ['host-api', { type: 'http', url: 'https://api.example.com/mcp', headers: {} }],
    ])
  })

  it('through the real MCP manager (never started: no client): the servers are stored and the next plan finds them unchanged', async () => {
    const h = await harness({ mcp: 'real' })
    const plan = await planOf(h)
    const servers = ['docs-api', 'local-tools', 'app-db'].map(name => item(plan, 'mcp-server', name))
    const result = await h.t.deps.claudeImport.apply({ planId: plan.id, items: servers.map(entry => ({ key: entry.key, action: 'import' })) }, FRESH)
    expect(result.counts).toMatchObject({ created: 3, failed: 0 })
    const stored = await h.t.deps.mcp.list()
    expect(stored.map(server => [server.id, server.enabled, server.transport.type]).sort()).toEqual([['app-db', false, 'stdio'], ['docs-api', true, 'http'], ['local-tools', false, 'stdio']])
    const again = await planOf(h)
    expect(['docs-api', 'local-tools', 'app-db'].map(name => item(again, 'mcp-server', name).status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(hasCanary(JSON.stringify(stored))).toBe(false)
  })

  it('cLAUDE.md: append after a blank line, replace, and a failure past 20000 characters', async () => {
    const h = await harness()
    const text = fakeClaudeHomeFiles()['.claude/CLAUDE.md']!.content.toString().trim()
    await h.t.deps.settings.update({ instructions: 'Existing.' })
    const first = await planOf(h)
    const instructions = item(first, 'instructions', 'CLAUDE.md')
    expect(instructions).toMatchObject({ status: 'update', actions: ['append', 'replace', 'skip'], defaultAction: 'append', warnings: ['imports-kept'] })
    expect((await h.t.deps.claudeImport.apply({ planId: first.id, items: [{ key: instructions.key, action: 'append' }] }, FRESH)).results).toEqual([{ key: instructions.key, outcome: 'updated' }])
    expect((await h.t.deps.settings.get()).instructions).toBe(`Existing.\n\n${text}`)

    await h.t.deps.settings.update({ instructions: 'Other.' })
    const second = await planOf(h)
    await h.t.deps.claudeImport.apply({ planId: second.id, items: [{ key: item(second, 'instructions', 'CLAUDE.md').key, action: 'replace' }] }, FRESH)
    expect((await h.t.deps.settings.get()).instructions).toBe(text)

    // Planned while it fitted; the instructions grew before the apply.
    await h.t.deps.settings.update({ instructions: 'Short.' })
    const third = await planOf(h)
    await h.t.deps.settings.update({ instructions: 'x'.repeat(LIMITS.instructionsMaxChars - 10) })
    const late = await h.t.deps.claudeImport.apply({ planId: third.id, items: [{ key: item(third, 'instructions', 'CLAUDE.md').key, action: 'append' }] }, FRESH)
    expect(late.results[0]).toMatchObject({ outcome: 'failed', message: 'Appending would make the global instructions longer than 20000 characters.' })
    expect((await h.t.deps.settings.get()).instructions).toHaveLength(LIMITS.instructionsMaxChars - 10)
  })

  it('a whole-tool deny becomes the tool override deny', async () => {
    const h = await harness({ builtins: true })
    await h.t.deps.plugins.start()
    const plan = await planOf(h)
    const deny = item(plan, 'tool-deny', 'WebFetch')
    const result = await h.t.deps.claudeImport.apply({ planId: plan.id, items: [{ key: deny.key, action: 'import' }] }, FRESH)
    expect(result.results).toEqual([{ key: deny.key, outcome: 'created' }])
    expect((await h.t.deps.tools.prefs()).get('web_fetch')).toEqual({ enabled: true, override: 'deny' })
    expect(item(await planOf(h), 'tool-deny', 'WebFetch').status).toBe('unchanged')
  })

  it('400 for an unknown key, an action the item does not offer, an invalid rename, variables of another item (the plan is kept); 404 for an unknown plan', async () => {
    const h = await harness()
    const plan = await planOf(h)
    const agent = item(plan, 'agent', 'reviewer')
    const unsupported = item(plan, 'setting', 'apiKeyHelper')
    for (const [items, variables, path] of [
      [[{ key: 'agent:nope:agents/nope.md', action: 'import' }], undefined, ['items', 0, 'key']],
      [[{ key: unsupported.key, action: 'import' }], undefined, ['items', 0, 'action']],
      [[{ key: agent.key, action: 'overwrite' }], undefined, ['items', 0, 'action']],
      [[{ key: item(plan, 'mcp-server', 'docs-api').key, action: 'import' }], { [agent.key]: { X: '1' } }, ['variables', agent.key]],
    ] as const) {
      const body = { planId: plan.id, items: items.map(entry => ({ ...entry })), ...(variables === undefined ? {} : { variables }) } as ClaudeImportApplyBody
      await expect(h.t.deps.claudeImport.apply(body, FRESH)).rejects.toMatchObject({ code: 'validation_error', details: { issues: [expect.objectContaining({ path: [...path] })] } })
    }
    const mine = await h.customizations.create({ kind: 'agent', content: '---\nname: reviewer\ndescription: Mine.\n---\nMine.\n' })
    void mine
    const second = await planOf(h)
    await expect(h.t.deps.claudeImport.apply({ planId: second.id, items: [{ key: item(second, 'agent', 'reviewer').key, action: 'rename', renameTo: 'Reviewer Two' }] }, FRESH))
      .rejects
      .toMatchObject({ code: 'validation_error', details: { issues: [expect.objectContaining({ path: ['items', 0, 'renameTo'] })] } })
    // The plans are still there after a 400.
    await expect(h.t.deps.claudeImport.apply({ planId: plan.id, items: [{ key: agent.key, action: 'skip' }] }, FRESH)).resolves.toMatchObject({ counts: { skipped: 1 } })
    await expect(h.t.deps.claudeImport.apply({ planId: 'cip_AAAAAAAAAAAAAAAA', items: [{ key: agent.key, action: 'import' }] }, FRESH)).rejects.toMatchObject({ code: 'not_found' })
  })
})
