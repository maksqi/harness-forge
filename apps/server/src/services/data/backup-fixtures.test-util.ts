// Test helpers of the Phase 10 backup and restore tests (W10.6-T2): the `dataApp` of ./fixtures.test-util.ts (the fake
// chats service, the real files service, a recording event bus, a fake runner and the fake checkpoint service) with the
// C30 fake customization service (`createFakeCustomizationService`, personal definitions in memory, `customization.changed`
// on the app's event bus), plus definition builders. Close the apps with `closeCustomizedApps()` in `afterEach`.
//
// Phase 11 (W11.7-T6): `realDataApp()` runs the real services (chats, customizations, settings, projects, secrets) on a
// fresh data dir, and `seedPhase11()` writes what a v1.7 server holds besides chats: the settings `outputStyle` /
// `hooksEnabled`, a personal output style, personal commands with and without `!` spans, a personal hook, a project
// with an approval and a project MCP variable, and a chat of that project with hook records. Every value that must
// never reach a backup carries a `*-SENTINEL` marker.
// Phase 12 (W12.3-T7): `seedPhase12()` adds what a v1.8 server holds besides that: a marketplace row, a Claude Code
// plugin row (format `claude`, a trust pin and an origin), a hook transcript of the chat and a home-folder import plan
// kept in memory, each carrying a `*-SENTINEL` marker of `PHASE12_SENTINELS`.
// Phase 14 (W14.6-T3): `seedPhase14()` adds what a v1.9 server holds besides chats: the web search settings, a personal
// http MCP server with `oauth` settings, the MCP OAuth records and client secret of every origin and the `core-search`
// keys (each a `*-SENTINEL` of `PHASE14_SENTINELS`), and a chat whose reply holds the Phase 14 records.
import type { CustomizationKind, HarnessUIMessage } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCustomizationService } from '../../testing/fake-customizations.ts'
import type { FakeChatRunner, RecordingEventBus } from '../../testing/fakes.ts'
import type { AppDeps } from '../../types.ts'
import type { CustomizationService } from '../customizations/types.ts'
import type { DataServiceOptions } from './index.ts'
import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHookId, createMarketplaceId } from '@harness-forge/shared'
import { hooks, marketplaces, mcpServers, plugins, projectTrust, secrets } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeCheckpointService } from '../../testing/fake-checkpoints.ts'
import { createFakeCustomizationService } from '../../testing/fake-customizations.ts'
import { createFakeChatRunner, createFakeChatsService, createRecordingEventBus } from '../../testing/fakes.ts'
import { recordMessages } from '../chats/records.test-util.ts'
import { createFilesService } from '../files/index.ts'
import { createDataService } from './index.ts'

export interface CustomizedDataApp {
  t: TestApp
  deps: AppDeps
  events: RecordingEventBus
  runs: FakeChatRunner
  /** The fake behind `deps.customizations` (before `wrap`). */
  customizations: FakeCustomizationService
}

export interface CustomizedDataAppOptions {
  data?: DataServiceOptions
  /** Wraps the fake customization service (e.g. a failing `exportBackup`). */
  wrap?: (service: FakeCustomizationService) => CustomizationService
}

const apps: TestApp[] = []

export async function customizedDataApp(options: CustomizedDataAppOptions = {}): Promise<CustomizedDataApp> {
  const events = createRecordingEventBus()
  const runs = createFakeChatRunner()
  let fake!: FakeCustomizationService
  const t = await createTestApp({
    start: false,
    overrides: { events, runs, checkpoints: createFakeCheckpointService() },
    factories: {
      chats: deps => createFakeChatsService(deps),
      data: deps => createDataService(deps, options.data),
      files: deps => createFilesService(deps),
      customizations: (deps) => {
        fake = createFakeCustomizationService({ events: deps.events })
        return options.wrap?.(fake) ?? fake
      },
    },
  })
  apps.push(t)
  return { t, deps: t.deps, events, runs, customizations: fake }
}

export async function closeCustomizedApps(): Promise<void> {
  for (const app of apps.splice(0))
    await app.close()
}

/** A valid personal definition of `kind`: frontmatter `name` and `description`, then the body. */
export function definition(kind: CustomizationKind, name: string, body = `The ${name} body.`): string {
  if (kind === 'command')
    return `---\nname: ${name}\ndescription: The ${name} command.\n---\n${body} $ARGUMENTS\n`
  return `---\nname: ${name}\ndescription: The ${name} ${kind}.\n---\n${body}\n`
}

// ---------- Phase 11 (W11.7-T6) ----------

/** An app with the real services on a fresh data dir (no builtins, nothing started). */
export async function realDataApp(): Promise<TestApp> {
  const t = await createTestApp({ start: false, builtins: [] })
  apps.push(t)
  return t
}

/** Values that must never leave the server in a backup. */
export const PHASE11_SENTINELS = {
  hookCommand: 'sh PERSONAL-HOOK-SENTINEL.sh',
  trustLabel: 'TRUST-LABEL-SENTINEL',
  trustSha256: 'a'.repeat(64),
  variable: 'VARIABLE-VALUE-SENTINEL',
} as const

/** A personal output style (kind `style`, ADR-051). */
export const STYLE_CONTENT = '---\nname: terse\ndescription: Short answers.\nkeep-coding-instructions: true\n---\nAnswer in at most three sentences.\n'
/** A personal command whose body runs a `!` span (ADR-052). */
export const SPAN_COMMAND_CONTENT = '---\nname: status\ndescription: The git status.\n---\nStatus: !`git status --short` for $ARGUMENTS\n'
/** A personal command without spans. */
export const PLAIN_COMMAND_CONTENT = '---\nname: review\ndescription: Review the changes.\n---\nReview $ARGUMENTS\n'

/** A `data-hook` part (ADR-048). */
export function hookPart(n: number, event: string, outcome: string, extra: Record<string, unknown> = {}): HarnessUIMessage['parts'][number] {
  return {
    type: 'data-hook',
    data: { id: `hev_backuphook00000${n}`, event, outcome, createdAt: 3, hooks: [{ source: 'personal', label: 'sh check.sh', exitCode: 0, durationMs: 7 }], ...extra },
  } as HarnessUIMessage['parts'][number]
}

/** A chat path with a prompt context, tool hook records and the carrier of a Stop continuation. */
export function hookChatMessages(): HarnessUIMessage[] {
  return [
    { id: 'msg_backuphook000001', role: 'user', parts: [{ type: 'text', text: 'Write it' }, hookPart(1, 'UserPromptSubmit', 'context', { context: 'Branch: main' })] },
    {
      id: 'msg_backuphook000002',
      role: 'assistant',
      metadata: { modelRef: 'mock:hooks', startedAt: 2, finishedAt: 3 },
      parts: [{ type: 'text', text: 'Done', state: 'done' }, hookPart(2, 'PostToolUse', 'context', { toolCallId: 'call_1', toolName: 'write_file', context: 'Run the tests.' })],
    },
    { id: 'msg_backuphook000003', role: 'user', parts: [hookPart(3, 'Stop', 'continued', { reason: 'Run the tests first.' })] },
    { id: 'msg_backuphook000004', role: 'assistant', metadata: { modelRef: 'mock:hooks', startedAt: 4, finishedAt: 5 }, parts: [{ type: 'text', text: 'Tests pass.', state: 'done' }] },
  ] as HarnessUIMessage[]
}

export interface Phase11Seed {
  projectId: string
  chatId: string
}

/** Writes the Phase 11 state of a v1.7 server (see the module comment) into `t`. */
export async function seedPhase11(t: TestApp): Promise<Phase11Seed> {
  const { deps } = t
  await deps.settings.update({ outputStyle: 'terse', hooksEnabled: false })
  await deps.customizations.create({ kind: 'style', content: STYLE_CONTENT })
  await deps.customizations.create({ kind: 'command', content: SPAN_COMMAND_CONTENT, enabled: true })
  await deps.customizations.create({ kind: 'command', content: PLAIN_COMMAND_CONTENT, enabled: true })
  const at = Date.now()
  await deps.db.insert(hooks).values({ id: createHookId(), event: 'PreToolUse', matcher: 'Bash', command: PHASE11_SENTINELS.hookCommand, timeout: null, enabled: true, createdAt: at, updatedAt: at })
  const folder = join(t.env.paths.workspaces, 'demo')
  mkdirSync(folder, { recursive: true })
  const project = await deps.projects.create({ name: 'Demo', path: folder })
  await deps.projects.update(project.id, { outputStyle: 'terse' })
  await deps.db.insert(projectTrust).values({ projectId: project.id, sha256: PHASE11_SENTINELS.trustSha256, kind: 'hook', label: PHASE11_SENTINELS.trustLabel, createdAt: at })
  // A project MCP variable as the secret store keeps it (scope `project:<projectId>`, name `mcp.var.<NAME>`), written as
  // a raw row: the backup must never read the `secrets` table, whatever the row holds.
  await deps.db.insert(secrets).values({ scope: `project:${project.id}`, name: 'mcp.var.MCP_TOKEN', ciphertext: Buffer.from(PHASE11_SENTINELS.variable), hint: PHASE11_SENTINELS.variable, keyVersion: 1, updatedAt: at })
  const chat = await deps.chats.create({ title: 'Hooks', projectId: project.id, settings: { toolMode: 'ask', outputStyle: 'terse' }, messages: hookChatMessages() })
  return { projectId: project.id, chatId: chat.id }
}

// ---------- Phase 12 (W12.3-T7) ----------

/** Values of the Phase 12 state that must never reach a backup. */
export const PHASE12_SENTINELS = {
  marketplace: 'MARKETPLACE-SENTINEL',
  pluginTrust: 'b'.repeat(64),
  pluginOrigin: 'PLUGIN-ORIGIN-SENTINEL',
  transcript: 'TRANSCRIPT-SENTINEL',
  importPlan: 'IMPORT-PLAN-SENTINEL',
} as const

/** The id of the seeded Claude Code plugin row. */
export const PHASE12_PLUGIN_ID = 'review-kit'

export interface Phase12Seed {
  marketplaceId: string
  /** The seeded transcript file (`<dataDir>/transcripts/<chatId>.jsonl`). */
  transcript: string
  /** The import plan kept by the home-folder import. */
  planId: string
}

/** Writes the Phase 12 state of a v1.8 server (see the module comment) next to the chat `chatId`. */
export async function seedPhase12(t: TestApp, chatId: string): Promise<Phase12Seed> {
  const { deps } = t
  const at = Date.now()
  const marketplaceId = createMarketplaceId()
  await deps.db.insert(marketplaces).values({
    id: marketplaceId,
    name: 'acme-tools',
    source: { type: 'path', path: '/srv/marketplaces/acme-tools' },
    resolvedRef: null,
    catalog: { name: 'acme-tools', description: PHASE12_SENTINELS.marketplace, plugins: [] },
    fetchedAt: at,
    lastError: null,
    createdAt: at,
    updatedAt: at,
  })
  await deps.db.insert(plugins).values({
    id: PHASE12_PLUGIN_ID,
    source: 'marketplace',
    sourceRef: `review-kit@acme-tools#${PHASE12_SENTINELS.pluginOrigin}`,
    version: '1.0.0',
    enabled: true,
    trustedHash: PHASE12_SENTINELS.pluginTrust,
    format: 'claude',
    origin: { marketplace: 'acme-tools', note: PHASE12_SENTINELS.pluginOrigin },
  })
  mkdirSync(t.env.paths.transcripts, { recursive: true, mode: 0o700 })
  const transcript = join(t.env.paths.transcripts, `${chatId}.jsonl`)
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: PHASE12_SENTINELS.transcript } })}\n`, { mode: 0o600 })
  const plan = await deps.claudeImport.upload({
    label: '.claude',
    files: [{ path: 'agents/sentinel.md', file: new Blob([`---\nname: sentinel\ndescription: Kept in the plan.\n---\n${PHASE12_SENTINELS.importPlan}\n`]) }],
  })
  return { marketplaceId, transcript, planId: plan.id }
}

// ---------- Phase 14 (W14.6-T3) ----------

/** Values of the Phase 14 state that must never reach a backup (OAuth records, client secrets, search keys). */
export const PHASE14_SENTINELS = {
  accessToken: 'ACCESS-TOKEN-SENTINEL',
  refreshToken: 'REFRESH-TOKEN-SENTINEL',
  clientSecret: 'CLIENT-SECRET-SENTINEL',
  pluginRecord: 'PLUGIN-OAUTH-RECORD-SENTINEL',
  projectRecord: 'PROJECT-OAUTH-RECORD-SENTINEL',
  braveKey: 'BRAVE-KEY-SENTINEL',
  tavilyKey: 'TAVILY-KEY-SENTINEL',
  exaKey: 'EXA-KEY-SENTINEL',
  serverUrl: 'https://mcp-sentinel.example/mcp',
} as const

/** The OAuth and search secret rows `seedPhase14` writes, as `[scope, name]`. */
export const PHASE14_SECRET_ROWS: readonly (readonly [string, string])[] = [
  ['mcp:remote-docs', 'oauth.record'],
  ['mcp:remote-docs', 'oauth.clientSecret'],
  ['plugin:acme-mcp', 'mcp-oauth.docs'],
  ['project:prj_phase14project01', 'mcp-oauth.remote'],
  ['plugin:core-search', 'settings.braveApiKey'],
  ['plugin:core-search', 'settings.tavilyApiKey'],
  ['plugin:core-search', 'settings.exaApiKey'],
]

export interface Phase14Seed {
  chatId: string
  /** The personal http MCP server with an OAuth client (`transport.oauth`). */
  serverId: string
}

/**
 * Writes the Phase 14 state of a v1.9 server: the settings `webSearchDefault` / `webSearchNative`, a personal http MCP
 * server with `oauth` settings, its OAuth record and client secret, a plugin's and a project's OAuth records, the three
 * `core-search` keys (raw `secrets` rows whose ciphertext and hint hold the sentinels: the backup must never read the
 * table, whatever it holds) and a chat with web search on whose reply holds every Phase 14 record.
 */
export async function seedPhase14(t: TestApp): Promise<Phase14Seed> {
  const { deps } = t
  const at = Date.now()
  await deps.settings.update({ webSearchDefault: 'auto', webSearchNative: false })
  const serverId = 'remote-docs'
  await deps.db.insert(mcpServers).values({
    id: serverId,
    name: 'Remote docs',
    transport: { type: 'http', url: PHASE14_SENTINELS.serverUrl, headerNames: [], oauth: { clientId: 'public-client', scopes: 'docs.read' } },
    policy: 'ask',
    enabled: false,
    createdAt: at,
    updatedAt: at,
  })
  const record = JSON.stringify({ v: 1, resource: PHASE14_SENTINELS.serverUrl, clientId: 'public-client', tokens: { access_token: PHASE14_SENTINELS.accessToken, refresh_token: PHASE14_SENTINELS.refreshToken, token_type: 'Bearer', obtainedAt: at } })
  const values = [record, PHASE14_SENTINELS.clientSecret, PHASE14_SENTINELS.pluginRecord, PHASE14_SENTINELS.projectRecord, PHASE14_SENTINELS.braveKey, PHASE14_SENTINELS.tavilyKey, PHASE14_SENTINELS.exaKey]
  for (const [index, [scope, name]] of PHASE14_SECRET_ROWS.entries()) {
    const value = values[index]!
    await deps.db.insert(secrets).values({ scope, name, ciphertext: Buffer.from(value), hint: value.slice(0, 64), keyVersion: 1, updatedAt: at })
  }
  const chat = await deps.chats.create({ title: 'Web search', settings: { toolMode: 'ask', webSearch: 'auto' }, messages: recordMessages() })
  return { chatId: chat.id, serverId }
}
