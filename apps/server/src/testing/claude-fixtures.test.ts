/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` / `${user_config.KEY}` references are the subject of these tests */
// Smoke tests of the fixture builders (C45-T4): each tree written into a `realpath(mkdtemp())` folder and read back with
// the shared Claude parsers (C41 / C42): plugin manifests, marketplace entries, hooks, `.mcp.json`, definitions and the
// home-folder import plan. The plugin scripts run once through `runShellCommand` (POSIX only).
import type { ClaudeImportBaseline, CustomizationKind } from '@harness-forge/shared'
import type { FixtureTree } from './claude-fixtures.ts'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  buildHookPayload,
  CLAUDE_JSON_PATH,
  extractClaudeJsonMcpServers,
  isClaudeHomeImportPath,
  mergeEntryOverlay,
  parseClaudePluginManifest,
  parseDefinition,
  parseMarketplaceJson,
  parseMcpJson,
  planClaudeImport,
  readHookOutput,
  readHooksConfig,
} from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capturedText, runShellCommand } from '../workspace/shell.ts'
import {
  CLAUDE_HOME_CANARIES,
  CLAUDE_HOME_CANARY_PREFIX,
  CLAUDE_MARKETPLACE,
  CLAUDE_MARKETPLACE_ENTRIES,
  CLAUDE_MARKETPLACE_INVALID_ENTRIES,
  CLAUDE_PLUGIN_FIXTURE_NAMES,
  claudeHomeImportFiles,
  claudeMarketplaceArchive,
  claudeMarketplaceFiles,
  claudePluginFiles,
  fakeClaudeHomeFiles,
  inFolder,
  registerClaudeMarketplaceRemote,
  REVIEW_KIT_FORMAT_CONTEXT,
  REVIEW_KIT_FORMAT_MARKER,
  UID_MARK_FILE,
  writeFileTree,
} from './claude-fixtures.ts'
import { createFakeRemoteRoutes, createFakeSafeFetch } from './fake-remote.ts'

const posix = process.platform !== 'win32'
const decoder = new TextDecoder()
let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function text(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8')
}

async function modeOf(path: string): Promise<number> {
  return (await stat(join(root, path))).mode & 0o777
}

function kindOf(path: string): CustomizationKind | null {
  if (path.endsWith('SKILL.md'))
    return 'skill'
  if (path.includes('agents/'))
    return 'agent'
  if (path.includes('commands/'))
    return 'command'
  if (path.includes('output-styles/'))
    return 'style'
  return null
}

/** Every markdown definition of a tree parses without an error diagnostic. */
function expectDefinitionsParse(files: FixtureTree): number {
  let count = 0
  for (const [path, entry] of Object.entries(files)) {
    const kind = kindOf(path)
    if (kind === null || !path.endsWith('.md'))
      continue
    const segments = path.split('/')
    // The catalog slugs path names (`clean_gone` → `clean-gone`) before it parses; the fixture keeps Claude's file names.
    const result = parseDefinition(kind, String(entry.content), { fileName: segments.at(-1)?.replaceAll('_', '-'), folderName: segments.at(-2) })
    expect(result.definition, path).not.toBeNull()
    expect(result.diagnostics.filter(diagnostic => diagnostic.level === 'error'), path).toEqual([])
    count++
  }
  return count
}

const EMPTY_BASELINE: ClaudeImportBaseline = {
  definitions: [],
  reservedNames: [],
  hooks: [],
  mcpServers: [],
  shellRules: [],
  toolDenies: [],
  instructions: '',
  styles: [],
}

describe('writeFileTree', () => {
  it('writes every file with its mode and refuses bad paths and folders inside the repository', async () => {
    const written = await writeFileTree(root, { 'a/b.txt': { content: 'b', mode: 0o644 }, 'run.sh': { content: '#!/bin/sh\n', mode: 0o755 }, 'raw.bin': new Uint8Array([1, 2]) })
    expect(written).toEqual([join(root, 'a/b.txt'), join(root, 'raw.bin'), join(root, 'run.sh')])
    if (posix) {
      expect(await modeOf('run.sh')).toBe(0o755)
      expect(await modeOf('a/b.txt')).toBe(0o644)
    }
    await expect(writeFileTree(root, { '../x': 'x' })).rejects.toThrow(TypeError)
    await expect(writeFileTree(root, { '/abs': 'x' })).rejects.toThrow(TypeError)
    await expect(writeFileTree('relative/folder', { a: 'x' })).rejects.toThrow(TypeError)
    const repository = fileURLToPath(new URL('../../../../', import.meta.url))
    await expect(writeFileTree(join(repository, 'apps/server/src/testing/never'), { '.claude/x.md': 'x' })).rejects.toThrow(/inside the repository/)
    expect(inFolder('plugins/x/', { 'a.md': { content: 'a', mode: 0o644 } })).toEqual({ 'plugins/x/a.md': { content: 'a', mode: 0o644 } })
  })
})

describe('claude plugin fixtures', () => {
  it('lists six fixtures', () => {
    expect(CLAUDE_PLUGIN_FIXTURE_NAMES).toEqual(['review-kit', 'notes-only', 'single-skill', 'broken', 'broken-manifest', 'uid-mark'])
  })

  it('review-kit: manifest with userConfig and an http server, .mcp.json stdio server, every component, hooks, exec bits', async () => {
    const files = claudePluginFiles('review-kit')
    await writeFileTree(root, files)
    const manifest = parseClaudePluginManifest(await text('.claude-plugin/plugin.json'))
    expect(manifest.diagnostics.filter(diagnostic => diagnostic.level !== 'info')).toEqual([])
    expect(manifest.manifest).toMatchObject({ name: 'review-kit', version: '1.2.0', defaultEnabled: true })
    expect(manifest.manifest?.userConfig.map(option => [option.key, option.type, option.sensitive, option.required])).toEqual([['API_URL', 'string', false, true], ['API_TOKEN', 'string', true, true]])
    expect(manifest.manifest?.mcpServers?.inline).toEqual([{ 'review-api': { type: 'http', url: '${user_config.API_URL}', headers: { Authorization: 'Bearer ${user_config.API_TOKEN}' } } }])
    const mcp = parseMcpJson(await text('.mcp.json'))
    expect(mcp.servers.map(server => [server.name, server.transport.type])).toEqual([['review-tools', 'stdio']])
    expect(mcp.servers[0]?.transport).toMatchObject({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/servers/mcp-min.mjs', '--name', 'review-tools'] })
    expect(await text('servers/mcp-min.mjs')).toContain('dependency-free stdio MCP server')
    const hooks = readHooksConfig((JSON.parse(await text('hooks/hooks.json')) as { hooks: unknown }).hooks, { source: 'plugin', prompts: true })
    expect(hooks.items.map(item => [item.event, item.matcher, item.command])).toEqual([['PostToolUse', 'Write|Edit', '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh']])
    expect(hooks.diagnostics.length).toBeGreaterThanOrEqual(2)
    expect(expectDefinitionsParse(files)).toBe(6)
    expect(Object.keys(files).filter(path => files[path]!.mode === 0o755).sort()).toEqual(['bin/tool', 'hooks/format.sh', 'skills/pdf/scripts/fill.sh'])
    if (posix) {
      for (const path of ['bin/tool', 'hooks/format.sh', 'skills/pdf/scripts/fill.sh'])
        expect(await modeOf(path), path).toBe(0o755)
    }
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['.lsp.json', 'commands/db/migrate.md', 'commands/clean_gone.md', 'skills/pdf/reference.md', 'output-styles/terse.md']))
  })

  it.skipIf(!posix)('review-kit: hooks/format.sh records the run and answers PostToolUse context', async () => {
    await writeFileTree(root, claudePluginFiles('review-kit'))
    const payload = buildHookPayload('PostToolUse', { chatId: '0199a8f0-0000-7000-8000-000000000001', projectId: null, modelRef: 'mock:hooks', origin: 'request', cwd: root, toolMode: 'auto', source: 'plugin', tool: { name: 'write_file', callId: 'c1', input: { path: 'a.txt' }, output: 'ok' } })
    const result = await runShellCommand({ command: '"${CLAUDE_PLUGIN_ROOT}/hooks/format.sh"', cwd: root, timeoutMs: 10_000, input: payload.json, env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: root } })
    expect(result.exitCode).toBe(0)
    const outcome = readHookOutput('PostToolUse', { exitCode: result.exitCode, timedOut: result.timedOut, stdout: capturedText(result.stdout), stdoutTruncated: false, stderr: capturedText(result.stderr) })
    expect(outcome).toMatchObject({ status: 'ok', context: REVIEW_KIT_FORMAT_CONTEXT })
    expect(await text(REVIEW_KIT_FORMAT_MARKER)).toBe('formatted\n')
  })

  it('notes-only and single-skill: no manifest, valid definitions', async () => {
    for (const name of ['notes-only', 'single-skill'] as const) {
      const files = claudePluginFiles(name)
      expect(Object.keys(files).some(path => path.startsWith('.claude-plugin/')), name).toBe(false)
      expect(expectDefinitionsParse(files), name).toBe(name === 'notes-only' ? 2 : 1)
    }
    expect(Object.keys(claudePluginFiles('single-skill'))).toEqual(['SKILL.md', 'reference.md'])
  })

  it('broken: paths outside the root are errors (dropped), hooks and .mcp.json are not JSON; broken-manifest is unusable', async () => {
    await writeFileTree(root, claudePluginFiles('broken'))
    const broken = parseClaudePluginManifest(await text('.claude-plugin/plugin.json'))
    expect(broken.manifest?.name).toBe('broken')
    expect(broken.diagnostics.filter(diagnostic => diagnostic.code === 'path-outside-root').length).toBeGreaterThanOrEqual(3)
    expect(() => JSON.parse(String(claudePluginFiles('broken')['hooks/hooks.json']!.content))).toThrow(SyntaxError)
    expect(parseMcpJson(await text('.mcp.json')).diagnostics.some(diagnostic => diagnostic.level === 'error')).toBe(true)
    const unusable = parseClaudePluginManifest(String(claudePluginFiles('broken-manifest')['.claude-plugin/plugin.json']!.content))
    expect(unusable.manifest).toBeNull()
    expect(unusable.diagnostics.map(diagnostic => diagnostic.code)).toContain('invalid-json')
  })

  it.skipIf(!posix)('uid-mark: a UserPromptSubmit hook whose script writes id -u', async () => {
    const files = claudePluginFiles('uid-mark')
    await writeFileTree(root, files)
    expect(parseClaudePluginManifest(await text('.claude-plugin/plugin.json')).manifest?.name).toBe('uid-mark')
    const hooks = readHooksConfig((JSON.parse(await text('hooks/hooks.json')) as { hooks: unknown }).hooks, { source: 'plugin' })
    expect(hooks.items.map(item => [item.event, item.command])).toEqual([['UserPromptSubmit', '${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh']])
    const result = await runShellCommand({ command: '"${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh"', cwd: root, timeoutMs: 10_000, input: '{}', env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: root } })
    expect(result.exitCode).toBe(0)
    expect(await text(UID_MARK_FILE)).toBe(`${process.getuid?.()}\n`)
  })
})

describe('claude marketplace fixture', () => {
  it('has one entry of every source kind, a strict: false entry, invalid entries and the relative plugin folders', async () => {
    const files = claudeMarketplaceFiles()
    await writeFileTree(root, files)
    const { marketplace, diagnostics } = parseMarketplaceJson(await text('.claude-plugin/marketplace.json'))
    expect(marketplace?.name).toBe(CLAUDE_MARKETPLACE.name)
    expect(marketplace?.pluginRoot).toBeDefined()
    expect(marketplace?.plugins.map(entry => entry.name)).toEqual([...CLAUDE_MARKETPLACE_ENTRIES, ...CLAUDE_MARKETPLACE_INVALID_ENTRIES.slice(2)])
    const byName = new Map(marketplace?.plugins.map(entry => [entry.name, entry]))
    expect(Object.fromEntries([...byName].map(([name, entry]) => [name, [entry.source.kind, entry.supported]]))).toEqual({
      'review-kit': ['relative', true],
      'notes-only': ['relative', true],
      'bare-notes': ['relative', true],
      'gh-plugin': ['github', true],
      'url-plugin': ['github', true],
      'subdir-plugin': ['github', true],
      'archive-plugin': ['archive', true],
      'npm-plugin': ['npm', true],
      'private-plugin': ['npm', false],
      'command-plugin': ['command', false],
      'gitlab-plugin': ['url', false],
      'inline-tools': ['relative', true],
      'bad-github': ['unknown', false],
      'escape': ['unknown', false],
    })
    expect(byName.get('archive-plugin')?.source).toEqual({ kind: 'archive', url: CLAUDE_MARKETPLACE.archiveUrl, sha256: claudeMarketplaceArchive().sha256 })
    expect(byName.get('subdir-plugin')?.source).toMatchObject({ kind: 'github', repo: CLAUDE_MARKETPLACE.monorepo, path: CLAUDE_MARKETPLACE.subdirPath })
    expect(diagnostics.filter(diagnostic => diagnostic.level === 'warning').map(diagnostic => diagnostic.code)).toEqual(['invalid-name', 'invalid-source', 'invalid-source', 'path-outside-root'])
    const inline = byName.get('inline-tools')!
    expect(inline.strict).toBe(false)
    const merged = mergeEntryOverlay(null, inline)
    expect(merged.manifest?.commands?.paths).toEqual(['commands/hello.md'])
    for (const folder of ['plugins/review-kit/.claude-plugin/plugin.json', 'plugins/notes-only/commands/note.md', 'plugins/inline-tools/commands/hello.md'])
      expect(Object.keys(files), folder).toContain(folder)
  })

  it('registers the remote sources on the fake remote (repositories, archive with its sha256, npm, hosted json)', async () => {
    const routes = createFakeRemoteRoutes()
    const commits = registerClaudeMarketplaceRemote(routes)
    expect(routes.resolve(CLAUDE_MARKETPLACE.repo, 'HEAD')).toBe(commits.marketplace)
    expect(routes.resolve(CLAUDE_MARKETPLACE.githubRepo, CLAUDE_MARKETPLACE.githubRef)).toBe(commits.githubPlugin)
    const { safeFetch } = createFakeSafeFetch(routes)
    const raw = await safeFetch(`https://raw.githubusercontent.com/${CLAUDE_MARKETPLACE.repo}/${commits.marketplace}/.claude-plugin/marketplace.json`, { maxBytes: 1_048_576 })
    expect(parseMarketplaceJson(decoder.decode(raw.body)).marketplace?.name).toBe(CLAUDE_MARKETPLACE.name)
    const archive = await safeFetch(CLAUDE_MARKETPLACE.archiveUrl, { maxBytes: 1_048_576 })
    expect(createHash('sha256').update(archive.body).digest('hex')).toBe(claudeMarketplaceArchive().sha256)
    expect(decoder.decode((await safeFetch(CLAUDE_MARKETPLACE.jsonUrl, { maxBytes: 1_048_576 })).body)).toContain('"acme-tools"')
    expect((await safeFetch(`https://registry.npmjs.org/${CLAUDE_MARKETPLACE.npmPackage}`, { maxBytes: 1_048_576 })).status).toBe(200)
    const subdir = await safeFetch(`https://raw.githubusercontent.com/${CLAUDE_MARKETPLACE.monorepo}/main/${CLAUDE_MARKETPLACE.subdirPath}/commands/note.md`, { maxBytes: 1024 })
    expect(subdir.status).toBe(200)
  })
})

describe('fake claude home fixture', () => {
  const tree = fakeClaudeHomeFiles()

  it('holds the allowlisted files, the sibling .claude.json and the canaries (never on the allowlist)', async () => {
    await writeFileTree(root, tree)
    expect(Object.keys(tree)).toEqual(expect.arrayContaining([
      '.claude/agents/reviewer.md',
      '.claude/commands/frontend/component.md',
      '.claude/commands/db/migrate/up.md',
      '.claude/skills/pdf/SKILL.md',
      '.claude/output-styles/terse.md',
      '.claude/settings.json',
      '.claude/CLAUDE.md',
      '.claude.json',
    ]))
    for (const path of ['.credentials.json', 'projects/x.jsonl', 'history.jsonl', 'settings.local.json', 'skills/pdf/reference.md']) {
      expect(isClaudeHomeImportPath(path), path).toBe(false)
      expect(await text(`.claude/${path}`), path).toBeTruthy()
    }
    const canaryFiles = ['.claude/.credentials.json', '.claude/projects/x.jsonl', '.claude/history.jsonl', '.claude/settings.local.json']
    for (const path of canaryFiles)
      expect(await text(path), path).toContain(CLAUDE_HOME_CANARY_PREFIX)
    expect(new Set(Object.values(CLAUDE_HOME_CANARIES)).size).toBe(Object.keys(CLAUDE_HOME_CANARIES).length)
    for (const canary of Object.values(CLAUDE_HOME_CANARIES))
      expect(canary.startsWith(CLAUDE_HOME_CANARY_PREFIX)).toBe(true)
    expect(await text('.claude/CLAUDE.md')).toContain('@docs/style-guide.md')
  })

  it('keeps only the MCP servers of .claude.json (the account canaries are dropped)', () => {
    const extracted = extractClaudeJsonMcpServers(String(tree['.claude.json']!.content))
    expect(Object.keys(extracted.servers)).toEqual(['local-tools', 'docs-api'])
    expect(extracted.projects.map(project => [project.path, Object.keys(project.servers)])).toEqual([['/home/user/work/app', ['app-db']]])
    const kept = JSON.stringify(extracted)
    for (const canary of [CLAUDE_HOME_CANARIES.oauthAccount, CLAUDE_HOME_CANARIES.primaryApiKey, CLAUDE_HOME_CANARIES.projectHistory])
      expect(kept).not.toContain(canary)
  })

  it('plans an import of every kind; no canary reaches an item, a summary or a diagnostic', () => {
    const files = claudeHomeImportFiles(tree)
    expect(files.map(entry => entry.path)).toEqual([
      CLAUDE_JSON_PATH,
      'CLAUDE.md',
      'agents/planner.md',
      'agents/reviewer.md',
      'commands/clean_gone.md',
      'commands/db/migrate/up.md',
      'commands/deploy.md',
      'commands/frontend/component.md',
      'output-styles/terse.md',
      'settings.json',
      'skills/pdf/SKILL.md',
    ])
    const plan = planClaudeImport(files, EMPTY_BASELINE)
    const kinds = new Set(plan.items.map(item => item.kind))
    for (const kind of ['agent', 'command', 'skill', 'style', 'hook', 'mcp-server', 'shell-rule', 'tool-deny', 'instructions', 'setting', 'permission', 'env'] as const)
      expect(kinds.has(kind), kind).toBe(true)
    expect(plan.items.some(item => item.status === 'unsupported' && (item.kind === 'plugin' || item.kind === 'marketplace' || item.kind === 'setting'))).toBe(true)
    expect(plan.items.some(item => item.kind === 'command' && item.executable)).toBe(true)
    expect(plan.items.some(item => item.kind === 'hook' && item.executable)).toBe(true)
    expect(plan.items.filter(item => item.kind === 'shell-rule').map(item => item.name)).toEqual(['git diff', 'git status', 'npm run test'])
    expect(plan.items.filter(item => item.kind === 'permission' && item.name.startsWith('Bash(')).map(item => item.name)).toEqual(['Bash(*)', 'Bash(curl:*)', 'Bash(git push:*)', 'Bash(npx:*)', 'Bash(python3:*)'])
    expect(plan.items.filter(item => item.kind === 'tool-deny').map(item => item.name)).toEqual(['WebFetch'])
    expect(plan.items.some(item => item.kind === 'mcp-server' && item.warnings.includes('project-server'))).toBe(true)
    expect(plan.env).toMatchObject({ REVIEW_API_TOKEN: CLAUDE_HOME_CANARIES.envValue })
    const visible = JSON.stringify({ items: plan.items.map(({ payload: _payload, ...rest }) => rest), skipped: plan.skipped, diagnostics: plan.diagnostics })
    expect(visible).not.toContain(CLAUDE_HOME_CANARY_PREFIX)
  })
})
