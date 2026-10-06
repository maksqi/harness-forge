/* eslint-disable no-template-curly-in-string -- `${VAR}` references of MCP servers are test data */
import type { ClaudeHomeFile, ClaudeImportBaseline, ClaudeImportKind, ClaudeImportPlanDraft, ClaudeImportPlanItem } from './claude-import.ts'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../limits.ts'
import {
  classifyClaudeHomePath,
  CLAUDE_HOME_LIMITS,
  CLAUDE_IMPORT_ACTIONS,
  CLAUDE_IMPORT_INSTRUCTIONS_MAX_CHARS,
  CLAUDE_IMPORT_KINDS,
  CLAUDE_IMPORT_STATUSES,
  CLAUDE_IMPORT_WARNINGS,
  CLAUDE_JSON_PATH,
  claudeImportHookIdentity,
  claudeImportItemKey,
  claudeImportMcpFingerprint,
  extractClaudeJsonMcpServers,
  isClaudeHomeImportPath,
  normalizeClaudeHomePath,
  planClaudeImport,
} from './claude-import.ts'
import { parseDefinition, setDefinitionName } from './definitions.ts'

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures (an in-memory fake home; nothing is written to disk)

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const EMPTY_BASELINE: ClaudeImportBaseline = {
  definitions: [],
  reservedNames: [],
  hooks: [],
  mcpServers: [],
  shellRules: [],
  toolDenies: [],
  instructions: '',
  styles: ['default', 'explanatory', 'learning'],
}

/** Values that must never leave the server-side payloads (or never appear at all). */
const CANARIES = {
  oauth: 'canary-oauth@example.invalid',
  account: 'CANARY-ACCOUNT-UUID',
  primaryKey: 'sk-ant-CANARY-PRIMARY-KEY',
  userId: 'CANARY-USER-ID',
  history: 'CANARY-HISTORY-PROMPT',
  credentials: 'CANARY-CREDENTIALS-FILE',
  transcript: 'CANARY-TRANSCRIPT-LINE',
  envValue: 'ghp_CANARY_ENV_VALUE',
  hookArg: 'CANARY-HOOK-ARG',
  serverArg: 'CANARY-SERVER-PASSWORD',
  headerValue: 'CANARY-HEADER-VALUE',
}

const REVIEW_COMMAND = 'Review the current diff and list problems.\n'

const SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  model: 'sonnet',
  outputStyle: 'Terse',
  env: { 'GITHUB_TOKEN': CANARIES.envValue, 'DEBUG': 1, 'bad name': 'x' },
  permissions: {
    allow: [
      'Bash(npm run test:*)',
      'Bash(git status)',
      'Bash(git diff *)',
      'Bash(sudo:*)',
      'Bash',
      'Read(./src/**)',
      'WebFetch(domain:docs.example.invalid)',
      'Bash(npm run test:*)',
      'Bash(npm run test *)',
      42,
    ],
    ask: ['Bash(git push:*)'],
    deny: ['WebFetch', 'Read(./.env)', 'Write', 'UnknownTool', 'mcp__github__*'],
    defaultMode: 'acceptEdits',
    additionalDirectories: ['../docs'],
  },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `~/.claude/hooks/check-bash.sh --token ${CANARIES.hookArg}`, timeout: 30 }] }],
    PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx prettier --write' }, { type: 'http', url: 'https://hooks.example.invalid' }] }],
    Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check that every task is complete. $ARGUMENTS' }] }],
    Elicitation: [{ hooks: [{ type: 'command', command: 'echo x' }] }],
    SessionStart: [{ matcher: '(bad', hooks: [{ type: 'command', command: 'echo start' }] }],
  },
  statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
  apiKeyHelper: '~/bin/get-key.sh',
  enabledPlugins: { 'formatter@acme-tools': true },
  extraKnownMarketplaces: { 'acme-tools': { source: { source: 'github', repo: 'acme-corp/claude-plugins' } } },
  includeCoAuthoredBy: false,
  cleanupPeriodDays: 30,
}

const GITHUB_SERVER = { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } }

const CLAUDE_JSON = {
  numStartups: 12,
  oauthAccount: { emailAddress: CANARIES.oauth, accountUuid: CANARIES.account },
  primaryApiKey: CANARIES.primaryKey,
  userID: CANARIES.userId,
  mcpServers: {
    github: GITHUB_SERVER,
    docs: { type: 'http', url: 'https://docs.example.invalid/mcp', headers: { 'Authorization': 'Bearer ${DOCS_TOKEN}', 'X-Static': CANARIES.headerValue } },
    socket: { type: 'ws', url: 'wss://example.invalid/socket' },
  },
  projects: {
    '/Users/me/work/app': {
      history: [{ display: CANARIES.history }],
      mcpServers: {
        'local-db': { command: 'node', args: ['db-server.mjs', '--password', CANARIES.serverArg] },
        'github': GITHUB_SERVER,
      },
      allowedTools: [],
    },
    '/Users/me/other': { history: [{ display: CANARIES.history }] },
  },
}

const HOME: ClaudeHomeFile[] = [
  { path: 'agents/code-reviewer.md', text: '---\nname: code-reviewer\ndescription: Reviews code for quality.\ntools: Read, Grep, Glob\nmodel: sonnet\n---\n\nYou review code.\n' },
  { path: 'agents/general.md', text: '---\nname: general\ndescription: A general helper.\n---\n\nHelp.\n' },
  { path: 'agents/broken.md', text: '---\nname: broken\ndescription: never closed\n' },
  { path: 'commands/review.md', text: REVIEW_COMMAND },
  { path: 'commands/db/migrate.md', text: '---\ndescription: Run the migrations\nargument-hint: [env]\n---\nRun the migrations for $ARGUMENTS.\n' },
  { path: 'commands/clean_gone.md', text: 'Clean up gone branches.\n\n!`git branch -vv`\n' },
  { path: 'commands/help.md', text: 'My own help.\n' },
  { path: 'commands/a/b/c/deep.md', text: 'Deep command.\n' },
  { path: 'skills/pdf/SKILL.md', text: '---\nname: pdf\ndescription: Fill PDF forms.\n---\n\nUse the scripts.\n' },
  { path: 'skills/My_Skill/SKILL.md', text: '---\ndescription: Something useful.\n---\n\nDo it.\n' },
  { path: 'output-styles/terse.md', text: '---\nname: Terse\ndescription: Short answers.\n---\n\nBe brief.\n' },
  { path: 'settings.json', text: JSON.stringify(SETTINGS, null, 2) },
  { path: 'CLAUDE.md', text: '# Personal rules\r\n\r\nAlways run the tests.\r\n@~/.claude/extra-rules.md\r\n' },
  { path: CLAUDE_JSON_PATH, text: JSON.stringify(CLAUDE_JSON) },
  // Never on the allowlist (the browser and the scan filter them; the planner skips them again).
  { path: '.credentials.json', text: CANARIES.credentials },
  { path: 'projects/-Users-me-work-app/session.jsonl', text: CANARIES.transcript },
  { path: 'history.jsonl', text: CANARIES.history },
  { path: 'settings.local.json', text: '{}' },
  { path: 'plugins/known_marketplaces.json', text: '{}' },
  { path: 'todos/a.json', text: '[]' },
  { path: 'agents/nested/deep.md', text: 'x' },
  { path: 'commands/a/b/c/d/too-deep.md', text: 'x' },
]

const BASELINE: ClaudeImportBaseline = {
  definitions: [
    { kind: 'command', name: 'review', content: setDefinitionName(REVIEW_COMMAND, 'review') },
    { kind: 'skill', name: 'pdf', content: '---\nname: pdf\ndescription: Old.\n---\n\nOld body.\n' },
  ],
  reservedNames: [{ kind: 'skill', name: 'my-skill' }],
  hooks: [claudeImportHookIdentity('PostToolUse', 'Edit|Write', { type: 'command', command: 'npx prettier --write' })],
  mcpServers: [{ id: 'docs', fingerprint: claudeImportMcpFingerprint({ type: 'http', url: 'https://other.example.invalid/mcp', headers: {} }) }],
  shellRules: ['git  status'],
  toolDenies: ['web_fetch'],
  instructions: 'Be kind.',
  styles: ['default', 'explanatory', 'learning'],
}

function find(draft: ClaudeImportPlanDraft, kind: ClaudeImportKind, name: string, project?: string): ClaudeImportPlanItem {
  const item = draft.items.find(entry => entry.kind === kind && entry.name === name && entry.source.project === project)
  if (item === undefined)
    throw new Error(`no ${kind} item ${name}: ${draft.items.map(entry => `${entry.kind}:${entry.name}`).join(', ')}`)
  return item
}

function visible(draft: ClaudeImportPlanDraft): string {
  return JSON.stringify({
    items: draft.items.map(({ payload: _payload, ...item }) => item),
    skipped: draft.skipped,
    diagnostics: draft.diagnostics,
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Allowlist

describe('isClaudeHomeImportPath', () => {
  it.each([
    ['agents/reviewer.md', 'agent'],
    ['./agents/reviewer.md', 'agent'],
    ['agents//reviewer.md', 'agent'],
    ['commands/review.md', 'command'],
    ['commands/db/migrate.md', 'command'],
    ['commands/a/b/c/x.md', 'command'],
    ['skills/pdf/SKILL.md', 'skill'],
    ['output-styles/terse.md', 'style'],
    ['settings.json', 'settings'],
    ['CLAUDE.md', 'instructions'],
    ['.claude.json', 'claude-json'],
    ['./.claude.json', 'claude-json'],
  ])('allows %j', (path, kind) => {
    expect(isClaudeHomeImportPath(path)).toBe(true)
    expect(classifyClaudeHomePath(path)).toBe(kind)
  })

  it.each([
    '.credentials.json',
    'projects/x/session.jsonl',
    'history.jsonl',
    'todos/a.json',
    'shell-snapshots/s.sh',
    'statsig/x',
    'plugins/known_marketplaces.json',
    'plugins/cache/x/commands/a.md',
    'settings.local.json',
    'agents/nested/deep.md',
    'agents/.hidden.md',
    'agents/.md',
    'agents/reviewer.txt',
    'agents/reviewer.MD',
    'commands/a/b/c/d/x.md',
    'commands/.git/x.md',
    'commands/.md',
    'skills/pdf/skill.md',
    'skills/pdf/reference.md',
    'skills/pdf/scripts/SKILL.md',
    'skills/SKILL.md',
    'output-styles/a/b.md',
    'claude.md',
    'Settings.json',
    '/settings.json',
    '../settings.json',
    'agents/../settings.json',
    'agents\\reviewer.md',
    'agents/re\u0000viewer.md',
    '.claude/settings.json',
    '.claude.json/x',
    '',
    '.',
    `agents/${'x'.repeat(1100)}.md`,
  ])('refuses %j', (path) => {
    expect(isClaudeHomeImportPath(path)).toBe(false)
  })

  it('normalizes paths', () => {
    expect(normalizeClaudeHomePath('./commands//db/./migrate.md')).toBe('commands/db/migrate.md')
    expect(normalizeClaudeHomePath('.claude.json')).toBe('.claude.json')
    expect(normalizeClaudeHomePath('x/.claude.json')).toBeNull()
    expect(normalizeClaudeHomePath(7 as unknown as string)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

describe('identities and keys', () => {
  it('builds stable, bounded, unambiguous item keys', () => {
    expect(claudeImportItemKey('agent', 'reviewer', 'agents/reviewer.md')).toBe('agent:reviewer:agents/reviewer.md')
    expect(claudeImportItemKey('hook', 'a:b', 'c')).not.toBe(claudeImportItemKey('hook', 'a', 'b:c'))
    expect(claudeImportItemKey('permission', 'x\ny%', 'f')).toBe('permission:x%0Ay%25:f')
    const long = claudeImportItemKey('mcp-server', 'x'.repeat(400), CLAUDE_JSON_PATH)
    expect(long).toHaveLength(256)
    expect(long).toMatch(/~[\da-f]{8}$/)
    expect(claudeImportItemKey('mcp-server', 'x'.repeat(400), CLAUDE_JSON_PATH)).toBe(long)
    expect(claudeImportItemKey('mcp-server', `${'x'.repeat(399)}y`, CLAUDE_JSON_PATH)).not.toBe(long)
  })

  it('normalizes hook identities', () => {
    const a = claudeImportHookIdentity('PreToolUse', ' Bash ', { type: 'command', command: ' run.sh ', timeout: 29.5, extra: 1 })
    const b = claudeImportHookIdentity('PreToolUse', 'Bash', { command: 'run.sh', timeout: 30, async: false })
    expect(a).toBe(b)
    expect(claudeImportHookIdentity('Stop', '', { type: 'prompt', prompt: 'x' })).toBe(claudeImportHookIdentity('Stop', null, { type: 'prompt', prompt: 'x', continueOnBlock: false }))
    expect(claudeImportHookIdentity('Stop', null, { type: 'command', command: 'x', asyncRewake: true })).toBe(claudeImportHookIdentity('Stop', null, { type: 'command', command: 'x', async: true }))
    expect(claudeImportHookIdentity('Stop', null, { command: 'x' })).not.toBe(claudeImportHookIdentity('Stop', null, { command: 'x', args: ['a'] }))
    expect(claudeImportHookIdentity('Stop', null, { command: 'x', timeout: 9999 })).toBe(claudeImportHookIdentity('Stop', null, { command: 'x', timeout: 600 }))
  })

  it('fingerprints MCP servers by command, args, url and names only', () => {
    const stdio = claudeImportMcpFingerprint({ command: 'npx', args: ['-y', 'x'], env: { B: 'secret-1', A: 'secret-2' } })
    expect(stdio).toBe(claudeImportMcpFingerprint({ type: 'stdio', command: ' npx ', args: ['-y', 'x'], env: ['A', 'B'] }))
    expect(stdio).not.toContain('secret')
    expect(stdio).not.toBe(claudeImportMcpFingerprint({ command: 'npx', args: ['-y', 'y'], env: { A: '', B: '' } }))
    const remote = claudeImportMcpFingerprint({ type: 'http', url: 'https://x.example.invalid', headers: { Authorization: 'Bearer secret-3' } })
    expect(remote).not.toContain('secret')
    expect(remote).not.toBe(claudeImportMcpFingerprint({ type: 'sse', url: 'https://x.example.invalid', headers: { Authorization: '' } }))
    expect(claudeImportMcpFingerprint(null as unknown as object)).toBe(claudeImportMcpFingerprint({}))
  })
})

describe('extractClaudeJsonMcpServers', () => {
  it('keeps only the MCP server maps', () => {
    const result = extractClaudeJsonMcpServers(JSON.stringify(CLAUDE_JSON))
    expect(Object.keys(result.servers)).toEqual(['github', 'docs', 'socket'])
    expect(result.projects).toEqual([{ path: '/Users/me/work/app', servers: CLAUDE_JSON.projects['/Users/me/work/app'].mcpServers }])
    const text = JSON.stringify(result)
    for (const canary of [CANARIES.oauth, CANARIES.account, CANARIES.primaryKey, CANARIES.userId, CANARIES.history])
      expect(text).not.toContain(canary)
    expect(result.diagnostics).toEqual([])
  })

  it('reports unusable files without quoting them', () => {
    expect(extractClaudeJsonMcpServers('{').diagnostics.map(entry => entry.code)).toEqual(['invalid-json'])
    expect(extractClaudeJsonMcpServers('[1]').diagnostics.map(entry => entry.code)).toEqual(['not-an-object'])
    const odd = extractClaudeJsonMcpServers(JSON.stringify({ primaryApiKey: CANARIES.primaryKey, mcpServers: [CANARIES.primaryKey], projects: { [`/p/${CANARIES.userId}\u0007`]: { mcpServers: { a: {} } } } }))
    expect(odd.servers).toEqual({})
    expect(odd.projects).toEqual([])
    expect(odd.diagnostics.map(entry => entry.code)).toEqual(['not-an-object', 'invalid-project'])
    expect(JSON.stringify(odd)).not.toContain('CANARY')
    expect(extractClaudeJsonMcpServers(`{"x":"${'a'.repeat(CLAUDE_HOME_LIMITS.claudeJsonBytes)}"}`).diagnostics.map(entry => entry.code)).toEqual(['too-large'])
  })

  it('keeps __proto__ keys as plain server names', () => {
    const result = extractClaudeJsonMcpServers('{"mcpServers":{"__proto__":{"command":"x"}}}')
    expect(Object.keys(result.servers)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(result.servers)).toBe(Object.prototype)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The planner

describe('planClaudeImport', () => {
  const draft = planClaudeImport(HOME, BASELINE)

  it('plans definitions with names from the path', () => {
    expect(find(draft, 'agent', 'code-reviewer')).toMatchObject({ status: 'new', actions: ['import', 'skip'], defaultAction: 'import', executable: false, warnings: ['model-alias'] })
    const reserved = find(draft, 'agent', 'general')
    expect(reserved).toMatchObject({ status: 'conflict', actions: ['skip', 'rename'], defaultAction: 'skip', renameTo: 'general-2' })
    expect(reserved.payload).toEqual({ kind: 'definition', definitionKind: 'agent', content: HOME[1]?.text })
    expect(find(draft, 'agent', 'broken')).toMatchObject({ status: 'invalid', actions: [], payload: { kind: 'none' } })
    expect(find(draft, 'command', 'review')).toMatchObject({ status: 'unchanged', actions: [], defaultAction: 'skip' })
    const migrate = find(draft, 'command', 'db-migrate')
    expect(migrate).toMatchObject({ status: 'new', source: { file: 'commands/db/migrate.md' }, summary: 'Command /db-migrate: Run the migrations' })
    expect(migrate.diagnostics.map(entry => entry.code)).toContain('name-from-path')
    const migrateContent = migrate.payload.kind === 'definition' ? migrate.payload.content : ''
    expect(parseDefinition('command', migrateContent).definition?.fields.name).toBe('db-migrate')
    expect(migrateContent).toContain('argument-hint: [env]')
    const clean = find(draft, 'command', 'clean-gone')
    expect(clean).toMatchObject({ status: 'new', executable: true, warnings: ['runs-commands'] })
    expect(clean.diagnostics.map(entry => entry.code)).toContain('name-from-path')
    expect(find(draft, 'command', 'help')).toMatchObject({ status: 'conflict', renameTo: 'help-2' })
    expect(find(draft, 'command', 'a-b-c-deep').status).toBe('new')
    expect(find(draft, 'skill', 'pdf')).toMatchObject({ status: 'update', actions: ['skip', 'overwrite', 'rename'], defaultAction: 'skip', renameTo: 'pdf-2' })
    const mySkill = find(draft, 'skill', 'my-skill')
    expect(mySkill).toMatchObject({ status: 'conflict', renameTo: 'my-skill-2' })
    expect(mySkill.payload.kind === 'definition' && parseDefinition('skill', mySkill.payload.content).definition?.fields.name).toBe('my-skill')
    expect(find(draft, 'style', 'terse')).toMatchObject({ status: 'new', summary: 'Output style Terse: Short answers.' })
  })

  it('plans the hooks of settings.json, one item per handler', () => {
    const pre = find(draft, 'hook', 'PreToolUse (Bash)')
    expect(pre).toMatchObject({ status: 'new', executable: true, warnings: ['runs-commands'], summary: 'Runs a command on PreToolUse for Bash: ~/.claude/hooks/check-bash.sh' })
    expect(pre.payload).toEqual({ kind: 'hook', event: 'PreToolUse', matcher: 'Bash', handler: SETTINGS.hooks.PreToolUse[0]?.hooks[0] })
    const post = draft.items.filter(entry => entry.kind === 'hook' && entry.name.startsWith('PostToolUse'))
    expect(post.map(entry => entry.status).sort()).toEqual(['unchanged', 'unsupported'])
    expect(post.find(entry => entry.status === 'unsupported')?.summary).toBe('A http hook on PostToolUse is not supported.')
    expect(find(draft, 'hook', 'Stop')).toMatchObject({ status: 'new', executable: false, warnings: [], summary: 'Asks a model on Stop.' })
    expect(find(draft, 'hook', 'Elicitation')).toMatchObject({ status: 'unsupported' })
    expect(find(draft, 'hook', 'SessionStart ((bad)')).toMatchObject({ status: 'invalid', actions: [] })
  })

  it('maps permission rules', () => {
    const tests = draft.items.filter(entry => entry.kind === 'shell-rule' && entry.name === 'npm run test')
    expect(tests.map(entry => [entry.summary, entry.status])).toEqual([
      ['Run commands that start with npm run test without asking (from Bash(npm run test *)).', 'unchanged'],
      ['Run commands that start with npm run test without asking (from Bash(npm run test:*)).', 'new'],
    ])
    expect(tests[1]).toMatchObject({ warnings: [], payload: { kind: 'shell-rule', prefix: 'npm run test' } })
    expect(tests[0]?.diagnostics.map(entry => entry.code)).toEqual(['duplicate'])
    expect(find(draft, 'shell-rule', 'git status')).toMatchObject({ status: 'unchanged', warnings: ['prefix-broader'] })
    expect(find(draft, 'shell-rule', 'git diff')).toMatchObject({ status: 'new' })
    expect(find(draft, 'tool-deny', 'WebFetch')).toMatchObject({ status: 'unchanged', payload: { kind: 'tool-deny', tools: ['web_fetch'] } })
    expect(find(draft, 'tool-deny', 'Write')).toMatchObject({ status: 'new', payload: { kind: 'tool-deny', tools: ['write_file'] } })
    expect(find(draft, 'tool-deny', 'mcp__github__*')).toMatchObject({ status: 'new', payload: { kind: 'tool-deny', tools: ['mcp__github__*'] } })
    for (const name of ['Bash(sudo:*)', 'Bash', 'Read(./src/**)', 'WebFetch(domain:docs.example.invalid)', 'Bash(git push:*)', 'Read(./.env)', 'UnknownTool', 'permissions.defaultMode', 'permissions.additionalDirectories'])
      expect(find(draft, 'permission', name)).toMatchObject({ status: 'unsupported', actions: [], payload: { kind: 'none' } })
    expect(find(draft, 'permission', 'Bash(sudo:*)').summary).toContain('command runners')
    expect(draft.diagnostics.map(entry => entry.code)).toContain('invalid-rule')
  })

  it('plans the other settings', () => {
    expect(find(draft, 'setting', 'outputStyle')).toMatchObject({ status: 'new', payload: { kind: 'setting', key: 'outputStyle', value: 'terse' } })
    expect(find(draft, 'setting', 'model')).toMatchObject({ status: 'unsupported', summary: expect.stringContaining('sonnet') })
    expect(find(draft, 'setting', 'statusLine').status).toBe('unsupported')
    expect(find(draft, 'setting', 'apiKeyHelper').status).toBe('unsupported')
    expect(find(draft, 'env', 'env')).toMatchObject({ status: 'unsupported', summary: expect.stringContaining('GITHUB_TOKEN, DEBUG') })
    expect(find(draft, 'plugin', 'formatter@acme-tools').summary).toContain('Install plugins from Plugins → Marketplaces.')
    expect(find(draft, 'marketplace', 'acme-tools').summary).toContain('GitHub acme-corp/claude-plugins')
    expect(draft.env).toEqual({ GITHUB_TOKEN: CANARIES.envValue, DEBUG: '1' })
    const ignored = draft.diagnostics.find(entry => entry.code === 'ignored-settings')
    expect(ignored?.message).toBe('settings.json: these settings are not imported: includeCoAuthoredBy, cleanupPeriodDays.')
  })

  it('plans CLAUDE.md as instructions', () => {
    const instructions = find(draft, 'instructions', 'CLAUDE.md')
    expect(instructions).toMatchObject({ status: 'update', actions: ['append', 'replace', 'skip'], defaultAction: 'append', warnings: ['imports-kept'] })
    expect(instructions.payload).toEqual({ kind: 'instructions', text: '# Personal rules\n\nAlways run the tests.\n@~/.claude/extra-rules.md' })
  })

  it('plans the MCP servers of .claude.json', () => {
    const github = find(draft, 'mcp-server', 'github')
    expect(github).toMatchObject({ status: 'new', executable: true, warnings: ['runs-commands'], summary: 'Starts npx on this server (stdio).' })
    expect(github.variables).toBeUndefined()
    expect(github.payload).toEqual({ kind: 'mcp-server', name: 'github', id: 'github', raw: GITHUB_SERVER })
    const docs = find(draft, 'mcp-server', 'docs')
    expect(docs).toMatchObject({ status: 'conflict', actions: ['skip', 'overwrite', 'rename'], renameTo: 'docs-2', variables: ['DOCS_TOKEN'], warnings: ['needs-variables'], executable: false })
    expect(docs.summary).toBe('Connects to docs.example.invalid (http).')
    expect(find(draft, 'mcp-server', 'socket')).toMatchObject({ status: 'unsupported' })
    const local = find(draft, 'mcp-server', 'local-db', '/Users/me/work/app')
    expect(local).toMatchObject({ status: 'new', executable: true, warnings: ['runs-commands', 'project-server'], source: { file: CLAUDE_JSON_PATH, project: '/Users/me/work/app' } })
    expect(local.payload).toMatchObject({ kind: 'mcp-server', id: 'local-db', project: '/Users/me/work/app' })
    expect(find(draft, 'mcp-server', 'github', '/Users/me/work/app')).toMatchObject({ status: 'unchanged' })
  })

  it('skips files that are not on the allowlist', () => {
    expect(draft.skipped.map(entry => entry.path)).toEqual([
      '.credentials.json',
      'agents/nested/deep.md',
      'commands/a/b/c/d/too-deep.md',
      'history.jsonl',
      'plugins/known_marketplaces.json',
      'projects/-Users-me-work-app/session.jsonl',
      'settings.local.json',
      'todos/a.json',
    ])
    expect(draft.skipped.every(entry => entry.reason === 'not on the import allowlist')).toBe(true)
  })

  it('never shows values or canaries outside the server-side payloads', () => {
    const shown = visible(draft)
    for (const canary of Object.values(CANARIES))
      expect(shown, canary).not.toContain(canary)
    const everything = JSON.stringify(draft)
    for (const canary of [CANARIES.oauth, CANARIES.account, CANARIES.primaryKey, CANARIES.userId, CANARIES.history, CANARIES.credentials, CANARIES.transcript])
      expect(everything, canary).not.toContain(canary)
    for (const item of draft.items)
      expect(item.summary.length).toBeLessThanOrEqual(CLAUDE_HOME_LIMITS.summaryMaxChars)
  })

  it('is deterministic, sorted and uses only known values', () => {
    expect(planClaudeImport([...HOME].reverse(), BASELINE)).toEqual(draft)
    const order = draft.items.map(item => CLAUDE_IMPORT_KINDS.indexOf(item.kind))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(draft.items.map(item => item.key)).size).toBe(draft.items.length)
    for (const item of draft.items) {
      expect(CLAUDE_IMPORT_STATUSES).toContain(item.status)
      expect(CLAUDE_IMPORT_ACTIONS).toContain(item.defaultAction)
      for (const action of item.actions)
        expect(CLAUDE_IMPORT_ACTIONS).toContain(action)
      for (const warning of item.warnings)
        expect(CLAUDE_IMPORT_WARNINGS).toContain(warning)
      if (['unchanged', 'unsupported', 'invalid'].includes(item.status))
        expect(item.actions).toEqual([])
      if (item.status === 'new')
        expect(item.actions).toContain('import')
    }
  })

  it('imports everything as new into an empty harness', () => {
    const fresh = planClaudeImport(HOME, EMPTY_BASELINE)
    expect(find(fresh, 'skill', 'pdf').status).toBe('new')
    expect(find(fresh, 'skill', 'my-skill').status).toBe('new')
    expect(find(fresh, 'command', 'review').status).toBe('new')
    expect(find(fresh, 'instructions', 'CLAUDE.md')).toMatchObject({ status: 'new', defaultAction: 'append' })
    expect(find(fresh, 'mcp-server', 'docs')).toMatchObject({ status: 'new', payload: { id: 'docs' } })
    expect(find(fresh, 'shell-rule', 'git status').status).toBe('new')
  })
})

describe('planClaudeImport details', () => {
  it('marks definitions with byte-equal content unchanged and renames around taken names', () => {
    const text = '---\nname: lint\ndescription: Lint.\n---\nLint it.\n'
    const baseline: ClaudeImportBaseline = {
      ...EMPTY_BASELINE,
      definitions: [
        { kind: 'command', name: 'lint', content: `${text}\n` },
        { kind: 'command', name: 'lint-2', content: 'x' },
      ],
      reservedNames: [{ kind: 'command', name: 'lint-3' }],
    }
    const draft = planClaudeImport([{ path: 'commands/lint.md', text }, { path: 'commands/other/lint.md', text }], baseline)
    expect(draft.items.map(item => [item.source.file, item.status, item.renameTo])).toEqual([
      ['commands/lint.md', 'update', 'lint-4'],
      ['commands/other/lint.md', 'conflict', 'lint-5'],
    ])
    expect(draft.items[1]?.diagnostics.map(entry => entry.code)).toContain('duplicate-name')
    const same = planClaudeImport([{ path: 'commands/lint.md', text }], { ...baseline, definitions: [{ kind: 'command', name: 'lint', content: text }] })
    expect(same.items[0]?.status).toBe('unchanged')
  })

  it('cuts long nested command names to 32 characters', () => {
    const draft = planClaudeImport([{ path: 'commands/very-long-folder-name/another_long_folder/the-command.md', text: 'Do it.\n' }], EMPTY_BASELINE)
    const item = draft.items[0]
    expect(item?.name).toBe('very-long-folder-name-another-lo')
    expect(item?.name.length).toBeLessThanOrEqual(32)
    expect(item?.status).toBe('new')
  })

  it('reports files whose names cannot be slugged', () => {
    const draft = planClaudeImport([{ path: 'commands/2fa.md', text: 'x\n' }, { path: 'agents/日本.md', text: '---\ndescription: d\n---\nx\n' }], EMPTY_BASELINE)
    expect(draft.items.map(item => item.status)).toEqual(['invalid', 'invalid'])
    expect(draft.items.every(item => item.diagnostics.some(entry => entry.code === 'invalid-name'))).toBe(true)
  })

  it('applies the caps', () => {
    const files: ClaudeHomeFile[] = [
      { path: 'agents/huge.md', text: `---\ndescription: d\n---\n${'x'.repeat(CLAUDE_HOME_LIMITS.definitionBytes)}` },
      { path: 'agents/binary.md', text: 'a\u0000b' },
      { path: 'agents/twice.md', text: '---\ndescription: d\n---\nx\n' },
      { path: './agents/twice.md', text: '---\ndescription: d\n---\nx\n' },
      { path: 'settings.json', text: `{"x":"${'a'.repeat(CLAUDE_HOME_LIMITS.settingsBytes)}"}` },
      { path: 'CLAUDE.md', text: 'x'.repeat(CLAUDE_IMPORT_INSTRUCTIONS_MAX_CHARS + 1) },
      ...Array.from({ length: CLAUDE_HOME_LIMITS.definitionsPerKindMax + 3 }, (_, index) => ({ path: `commands/c${String(index).padStart(3, '0')}.md`, text: 'Do it.\n' })),
      { path: 'skills/x/SKILL.md', text: 7 as unknown as string },
      7 as unknown as ClaudeHomeFile,
    ]
    const draft = planClaudeImport(files, EMPTY_BASELINE)
    const reasons = Object.fromEntries(draft.skipped.map(entry => [entry.path, entry.reason]))
    expect(reasons['agents/huge.md']).toBe('larger than 64 KiB')
    expect(reasons['agents/binary.md']).toBe('binary')
    expect(reasons['agents/twice.md']).toBe('listed twice')
    expect(reasons['settings.json']).toBe('larger than 256 KiB')
    expect(reasons['skills/x/SKILL.md']).toBe('not a text file')
    expect(reasons['(unnamed)']).toBe('not a file')
    expect(draft.skipped.filter(entry => entry.reason === 'more than 200 commands')).toHaveLength(3)
    expect(find(draft, 'instructions', 'CLAUDE.md')).toMatchObject({ status: 'invalid', actions: [] })
    expect(draft.items.filter(item => item.kind === 'command')).toHaveLength(CLAUDE_HOME_LIMITS.definitionsPerKindMax)
  })

  it('stops at the total byte budget', () => {
    const padding = 'p'.repeat(CLAUDE_HOME_LIMITS.claudeJsonBytes - 1024)
    const body = 'b'.repeat(60_000)
    const files: ClaudeHomeFile[] = [
      { path: CLAUDE_JSON_PATH, text: JSON.stringify({ padding }) },
      ...Array.from({ length: 150 }, (_, index) => ({ path: `agents/a${String(index).padStart(3, '0')}.md`, text: `---\ndescription: d\n---\n${body}` })),
      ...Array.from({ length: 150 }, (_, index) => ({ path: `commands/c${String(index).padStart(3, '0')}.md`, text: body })),
    ]
    const draft = planClaudeImport(files, EMPTY_BASELINE)
    const over = draft.skipped.filter(entry => entry.reason === 'over the 32 MiB import limit')
    expect(over.length).toBeGreaterThan(0)
    expect(over.every(entry => entry.path.startsWith('commands/'))).toBe(true)
    expect(draft.items.length + over.length).toBe(300)
  })

  it('caps the plan at 1000 items', () => {
    const settings = { permissions: { allow: Array.from({ length: 500 }, (_, index) => `Read(./f${index})`), ask: Array.from({ length: 500 }, (_, index) => `Edit(./f${index})`), deny: Array.from({ length: 500 }, (_, index) => `Write(./f${index})`) } }
    const draft = planClaudeImport([{ path: 'settings.json', text: JSON.stringify(settings) }], EMPTY_BASELINE)
    expect(draft.items).toHaveLength(CLAUDE_HOME_LIMITS.itemsMax)
    expect(draft.diagnostics.map(entry => entry.code)).toContain('too-many')
  })

  it('handles CLAUDE.md edge cases', () => {
    const contained = planClaudeImport([{ path: 'CLAUDE.md', text: 'Always run the tests.\n' }], { ...EMPTY_BASELINE, instructions: 'Rules:\n\nAlways run the tests.\n' })
    expect(contained.items[0]).toMatchObject({ status: 'unchanged', actions: [] })
    const empty = planClaudeImport([{ path: 'CLAUDE.md', text: ' \n\n' }], EMPTY_BASELINE)
    expect(empty.items[0]).toMatchObject({ status: 'unchanged' })
    const full = planClaudeImport([{ path: 'CLAUDE.md', text: 'y'.repeat(15_000) }], { ...EMPTY_BASELINE, instructions: 'x'.repeat(10_000) })
    expect(full.items[0]).toMatchObject({ status: 'update', actions: ['replace', 'skip'], defaultAction: 'skip' })
    expect(full.items[0]?.diagnostics.map(entry => entry.code)).toEqual(['append-too-long'])
    expect(CLAUDE_IMPORT_INSTRUCTIONS_MAX_CHARS).toBe(LIMITS.instructionsMaxChars)
  })

  it('checks the output style setting against existing and imported styles', () => {
    const missing = planClaudeImport([{ path: 'settings.json', text: '{"outputStyle":"Fancy Style"}' }], EMPTY_BASELINE)
    expect(missing.items[0]).toMatchObject({ kind: 'setting', name: 'outputStyle', status: 'invalid' })
    const builtin = planClaudeImport([{ path: 'settings.json', text: '{"outputStyle":"Explanatory"}' }], { ...EMPTY_BASELINE, outputStyle: 'explanatory' })
    expect(builtin.items[0]).toMatchObject({ status: 'unchanged', payload: { kind: 'setting', key: 'outputStyle', value: 'explanatory' } })
    const imported = planClaudeImport([
      { path: 'settings.json', text: '{"outputStyle":"Fancy Style"}' },
      { path: 'output-styles/fancy.md', text: '---\nname: Fancy Style\ndescription: d\n---\nBe fancy.\n' },
    ], EMPTY_BASELINE)
    expect(find(imported, 'setting', 'outputStyle')).toMatchObject({ status: 'new', payload: { value: 'fancy-style' } })
  })

  it('reports unusable settings files and MCP variables', () => {
    const broken = planClaudeImport([{ path: 'settings.json', text: '{ nope' }, { path: CLAUDE_JSON_PATH, text: '[]' }], EMPTY_BASELINE)
    expect(broken.items).toEqual([])
    expect(broken.diagnostics.map(entry => entry.code)).toEqual(['invalid-json', 'not-an-object'])
    const vars = planClaudeImport([{ path: CLAUDE_JSON_PATH, text: JSON.stringify({ mcpServers: { api: { type: 'http', url: '${API_BASE:-https://x.example.invalid}/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } } } }) }], EMPTY_BASELINE)
    expect(vars.items[0]).toMatchObject({ status: 'new', variables: ['API_KEY'], warnings: ['needs-variables'], summary: 'Connects to a URL with variables (http).' })
  })

  it('gives colliding server ids distinct ids', () => {
    const draft = planClaudeImport([{ path: CLAUDE_JSON_PATH, text: JSON.stringify({ mcpServers: { 'my.server': { command: 'a' }, 'my_server': { command: 'b' } } }) }], EMPTY_BASELINE)
    expect(draft.items.map(item => item.payload.kind === 'mcp-server' ? item.payload.id : null)).toEqual(['my-server', 'my-server-2'])
    expect(draft.items.map(item => item.status)).toEqual(['new', 'new'])
  })

  it('never shows assignment values or arguments of hook commands', () => {
    const settings = {
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: `API_KEY=${CANARIES.hookArg} B="x ${CANARIES.hookArg}" "./my hook.sh" --x` },
            { type: 'command', command: `TOKEN=${CANARIES.hookArg}` },
            { type: 'command', command: `'/opt/hooks/run' --token ${CANARIES.hookArg}` },
          ],
        }],
      },
    }
    const draft = planClaudeImport([{ path: 'settings.json', text: JSON.stringify(settings) }], EMPTY_BASELINE)
    expect(draft.items.map(item => item.summary)).toEqual(['Runs a command on Stop: ./my hook.sh', 'Runs a command on Stop: a command', 'Runs a command on Stop: /opt/hooks/run'])
    expect(visible(draft)).not.toContain(CANARIES.hookArg)
  })

  it('marks linked files', () => {
    const draft = planClaudeImport([{ path: 'agents/linked.md', text: '---\ndescription: d\n---\nx\n', linked: true }], EMPTY_BASELINE)
    expect(draft.items[0]?.warnings).toEqual(['linked'])
  })

  it('never throws on malformed input', () => {
    expect(planClaudeImport(null as unknown as ClaudeHomeFile[], null as unknown as ClaudeImportBaseline)).toEqual({ items: [], skipped: [], diagnostics: [], env: {} })
    const odd = planClaudeImport([{ path: 'settings.json', text: '{"hooks":7,"permissions":[],"env":"x","enabledPlugins":[1],"outputStyle":7}' }], { definitions: 'x', hooks: [1] } as unknown as ClaudeImportBaseline)
    expect(odd.items.map(item => `${item.kind}:${item.status}`)).toEqual(['setting:invalid'])
    expect(odd.diagnostics.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Fuzzing

const PATHS = ['agents/a.md', 'agents/b.md', 'commands/x.md', 'commands/d/y.md', 'skills/s/SKILL.md', 'output-styles/o.md', 'settings.json', 'CLAUDE.md', CLAUDE_JSON_PATH, 'projects/p.jsonl', '../x']
const PIECES = ['---\n', 'name: x\n', 'description: d\n', 'model: sonnet\n', '!`ls`', '{', '}', '[', ']', '"hooks":', '"permissions":', '"allow":', '"Bash(ls:*)"', '"mcpServers":', '"command":"node"', ',', ':', 'é', '\u0000', '\r\n', '@a/b.md', '${X}']

describe('fuzzing', () => {
  it('never throws on random home folders and keeps the invariants', () => {
    const random = prng(0xC41F00D)
    const started = Date.now()
    for (let round = 0; round < 400; round++) {
      const files: ClaudeHomeFile[] = []
      for (let count = Math.floor(random() * 6); count > 0; count--) {
        let text = ''
        for (let length = Math.floor(random() * 14); length > 0; length--)
          text += PIECES[Math.floor(random() * PIECES.length)]
        files.push({ path: PATHS[Math.floor(random() * PATHS.length)] as string, text, linked: random() < 0.2 })
      }
      const draft = planClaudeImport(files, random() < 0.5 ? EMPTY_BASELINE : BASELINE)
      expect(draft.items.length).toBeLessThanOrEqual(CLAUDE_HOME_LIMITS.itemsMax)
      expect(new Set(draft.items.map(item => item.key)).size).toBe(draft.items.length)
      for (const item of draft.items) {
        expect(CLAUDE_IMPORT_STATUSES).toContain(item.status)
        expect(item.summary.length).toBeLessThanOrEqual(CLAUDE_HOME_LIMITS.summaryMaxChars)
        expect(item.actions.includes(item.defaultAction) || item.actions.length === 0 || item.defaultAction === 'skip').toBe(true)
      }
      extractClaudeJsonMcpServers(files[0]?.text ?? '')
    }
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})
