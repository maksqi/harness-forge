// Hooks, project trust, project MCP and output style helpers for the Phase 11 specs (docs/UI.md 2.18, 7.31 – 7.33, 9.13,
// 13.12; docs/PROVIDERS.md 8 "Hook mocks (Phase 11)"; ADR-048 … ADR-052).
//
// - Hook scripts are the POSIX `sh` files of the server's tests and gate probes (`apps/server/src/testing/hook-scripts.ts`,
//   re-exported here): written into the spec's own project folder (default `.harness/hooks/<name>.sh`) and invoked as
//   `sh <relative path>` from the project folder, never as an inline `sh -c` string.
// - Project hooks live in the project's `.harness/settings.json` (`projectSettings`); nothing in a project runs before
//   it is approved (`approveProjectItems`, `POST /api/projects/:id/trust`; the e2e server has no password, so no fresh
//   login is needed). Prefer project hooks for behavior: they run only in that project's chats, so a spec never changes
//   what another spec's chats do.
// - Personal hooks and the settings `hooksEnabled` / `outputStyle` are global state of the server: every helper that
//   changes them registers the undo through the `cleanup` fixture first.
import type { Locator, Page } from '@playwright/test'
import type { HookScriptName, HookScriptOptions } from '../../apps/server/src/testing/hook-scripts.ts'
import type {
  HookCreate,
  HookEvent,
  HookList,
  PersonalHook,
  ProjectMcpList,
  ProjectTrustList,
  TrustItem,
} from '../../packages/shared/src/index.ts'
import type { ProjectChat } from './agent.ts'
import type { HarnessApi } from './api.ts'
import type { CleanupTask } from './fixtures.ts'
import type { DataAttributes } from './locators.ts'
import type { SeedFolderOptions } from './workspace.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect } from '@playwright/test'
import { writeHookScript } from '../../apps/server/src/testing/hook-scripts.ts'
import { seedProjectChat } from './agent.ts'
import { byTestId } from './locators.ts'
import { testIds } from './testids.ts'

export {
  HOOK_LOG_FILE,
  HOOK_SCRIPT_DIR,
  HOOK_SCRIPT_TEXT,
  hookScriptCommand,
  hookScriptPath,
  hookScriptSource,
  readHookLog,
  writeHookScript,
} from '../../apps/server/src/testing/hook-scripts.ts'
export type { HookScriptName, HookScriptOptions } from '../../apps/server/src/testing/hook-scripts.ts'

// ---------- the hook mock (docs/PROVIDERS.md 8 "Hook mocks (Phase 11)") ----------

/** Drives hooks, project MCP servers, output styles and command extras (`call <tool> <json>`, `run <cmd>`, `context?`, `style?`, `mcp?`, `tools?`). */
export const MOCK_HOOKS_MODEL = 'mock:hooks'

/** The `mock:hooks` line that calls a tool once with a JSON input: `call write_file {"path":"a.txt","content":"a\n"}`. */
export function mockCall(tool: string, input: Readonly<Record<string, unknown>>): string {
  return `call ${tool} ${JSON.stringify(input)}`
}

/** What `mock:hooks` answers after the call of `tool` (`<status>` ok / denied / failed; `<detail>`; the hook lines after it). */
export function mockCalled(tool: string, status: 'ok' | 'denied' | 'failed', detail: string, hooks = 'none'): string {
  return `Called ${tool}: ${status} | ${detail} | hooks: ${hooks}`
}

/** What `mock:hooks` answers to any other turn: `Hooks mock: <user text>`. */
export function mockHooksEcho(text: string): string {
  return `Hooks mock: ${text}`
}

// ---------- project files ----------

/** One handler of a Claude Code `hooks` list. */
export interface HookHandler {
  type: 'command'
  command: string
  timeout?: number
}

/** A matcher group of a Claude Code `hooks` list. */
export interface HookGroup {
  matcher?: string
  hooks: HookHandler[]
}

/** A Claude Code `hooks` object (`{ PreToolUse: [group, …], … }`). */
export type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>

/** One matcher group: `hookGroup('sh .harness/hooks/deny.sh', { matcher: 'Bash' })`. */
export function hookGroup(commands: string | readonly string[], options: { matcher?: string, timeout?: number } = {}): HookGroup {
  const list = typeof commands === 'string' ? [commands] : [...commands]
  return {
    ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
    hooks: list.map(command => ({ type: 'command', command, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) })),
  }
}

/** The text of a project settings file (`.harness/settings.json`) with these hooks and any other keys. */
export function projectSettings(hooks: HooksConfig, extra: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({ ...extra, hooks }, null, 2)}\n`
}

/** Writes (or replaces) a file of a project folder, creating its folders. */
export async function writeProjectFile(folder: string, relative: string, content: string): Promise<void> {
  const file = join(folder, relative)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

// ---------- project trust (docs/UI.md 7.33; API `/projects/:id/trust`) ----------

/** The trust list of a project (a fresh scan of its folder). */
export function projectTrust(api: HarnessApi, projectId: string): Promise<ProjectTrustList> {
  return api.client.projectTrust.list({ params: { id: projectId } })
}

/** The pending items of a project's trust list. */
export async function pendingTrustItems(api: HarnessApi, projectId: string): Promise<TrustItem[]> {
  return (await projectTrust(api, projectId)).items.filter(item => item.state === 'pending')
}

/**
 * Approves every pending item of a project that matches `match` (default: all) through the API and returns the new list;
 * fails when nothing matched. Use it after every file the items name exists (a script is part of its hook's hash).
 */
export async function approveProjectItems(
  api: HarnessApi,
  projectId: string,
  match: (item: TrustItem) => boolean = () => true,
): Promise<ProjectTrustList> {
  const pending = (await pendingTrustItems(api, projectId)).filter(match)
  expect(pending.length, `pending trust items of project ${projectId} to approve`).toBeGreaterThan(0)
  return api.client.projectTrust.approve({ params: { id: projectId }, body: { items: pending.map(item => ({ kind: item.kind, sha256: item.sha256 })) } })
}

/** A `.mcp.json` variable reference: `mcpVariable('TOKEN')` is `${TOKEN}`, `mcpVariable('TOKEN', 'abc')` is `${TOKEN:-abc}`. */
export function mcpVariable(name: string, fallback?: string): string {
  return `\${${name}${fallback === undefined ? '' : `:-${fallback}`}}`
}

/** The project MCP servers and variables of a project. */
export function projectMcp(api: HarnessApi, projectId: string): Promise<ProjectMcpList> {
  return api.client.projectMcp.list({ params: { id: projectId } })
}

// ---------- a project chat with hooks ----------

/** A script to write into the project: its name and options (`{ text }`, `{ file }`, `{ seconds }`). */
export type HookScriptSpec = HookScriptName | readonly [HookScriptName, HookScriptOptions]

export interface HookProjectOptions extends SeedFolderOptions {
  /** The chat's model (default `mock:hooks`). */
  modelRef?: string
  /** Scripts written into the project before the settings file (their hashes are part of the hooks' trust hashes). */
  scripts?: readonly HookScriptSpec[]
  /** The project's hooks, written to `.harness/settings.json` (none: no settings file). */
  hooks?: HooksConfig
  /** Approve every pending item after seeding (default true). */
  approve?: boolean
  /** The project name (default: the folder name). */
  name?: string
  title?: string
}

export interface HookProjectChat extends ProjectChat {
  /** The commands of the written scripts (`sh .harness/hooks/<file>.sh`), by file name (without `.sh`). */
  commands: Record<string, string>
}

/**
 * A project chat (`seedProjectChat`, default model `mock:hooks`) whose folder holds the hook scripts and
 * `.harness/settings.json` with `hooks`, approved through the API unless `approve: false`. Everything is undone through
 * `cleanup`. `hooks` may be a function of the script commands.
 */
export async function seedHookProjectChat(
  api: HarnessApi,
  cleanup: (task: CleanupTask) => void,
  options: Omit<HookProjectOptions, 'hooks'> & { hooks?: HooksConfig | ((commands: Record<string, string>) => HooksConfig) },
): Promise<HookProjectChat> {
  const seeded = await seedProjectChat(api, cleanup, {
    modelRef: options.modelRef ?? MOCK_HOOKS_MODEL,
    prefix: options.prefix ?? 'hooks',
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.title === undefined ? {} : { title: options.title }),
  })
  const commands: Record<string, string> = {}
  for (const spec of options.scripts ?? []) {
    const [name, scriptOptions] = typeof spec === 'string' ? [spec as HookScriptName, {}] : spec as readonly [HookScriptName, HookScriptOptions]
    commands[scriptOptions.file ?? name] = await writeHookScript(seeded.folder.path, name, scriptOptions)
  }
  const hooks = typeof options.hooks === 'function' ? options.hooks(commands) : options.hooks
  if (hooks !== undefined) {
    await writeProjectFile(seeded.folder.path, '.harness/settings.json', projectSettings(hooks))
    if (options.approve !== false)
      await approveProjectItems(api, seeded.project.id, item => item.kind === 'hook')
  }
  return { ...seeded, commands }
}

// ---------- personal hooks and global settings ----------

/** Deletes a personal hook (a hook that is already gone is fine). */
export async function removePersonalHook(api: HarnessApi, id: string): Promise<void> {
  try {
    await api.client.hooks.remove({ params: { id } })
  }
  catch (error) {
    if ((error as { code?: unknown }).code !== 'not_found')
      throw error
  }
}

/** Deletes every personal hook whose command contains `marker` (for hooks a spec creates through the UI). */
export async function removePersonalHooksWith(api: HarnessApi, marker: string): Promise<void> {
  const { items } = await api.client.hooks.list({ query: {} })
  for (const entry of items) {
    if (entry.source === 'personal' && entry.kind === 'command' && entry.id && entry.command.includes(marker))
      await removePersonalHook(api, entry.id)
  }
}

/** Creates a personal hook through the API (`POST /api/hooks`), removed again through `cleanup`. */
export async function createPersonalHook(api: HarnessApi, cleanup: (task: CleanupTask) => void, body: HookCreate): Promise<PersonalHook> {
  const hook = await api.client.hooks.create({ body })
  cleanup(api => removePersonalHook(api, hook.id))
  return hook
}

/** `GET /api/hooks` (with a project: its hooks too). */
export function listHooks(api: HarnessApi, projectId?: string): Promise<HookList> {
  return api.client.hooks.list({ query: projectId === undefined ? {} : { projectId } })
}

/** Sets the "Run hooks" switch (`hooksEnabled`) for one test, restored through `cleanup` (registered first). */
export async function useHooksEnabled(api: HarnessApi, cleanup: (task: CleanupTask) => void, value: boolean): Promise<void> {
  const before = (await api.getSettings()).hooksEnabled
  cleanup(() => api.updateSettings({ hooksEnabled: before }))
  await api.updateSettings({ hooksEnabled: value })
}

/** Sets the global default output style (`outputStyle`) for one test, restored through `cleanup` (registered first). */
export async function useOutputStyleSetting(api: HarnessApi, cleanup: (task: CleanupTask) => void, value: string): Promise<void> {
  const before = (await api.getSettings()).outputStyle
  cleanup(() => api.updateSettings({ outputStyle: before }))
  await api.updateSettings({ outputStyle: value })
}

// ---------- locators ----------

/** A hook note (`hook-note`) by its data attributes, e.g. `{ 'data-outcome': 'denied', 'data-variant': 'tool' }`. */
export function hookNote(scope: Page | Locator, attributes: DataAttributes = {}): Locator {
  return byTestId(scope, testIds.hookNote, attributes)
}

/** A tool row's hook badge (`tool-row-hook`), e.g. `{ 'data-value': 'denied' }`. */
export function toolRowHook(scope: Page | Locator, attributes: DataAttributes = {}): Locator {
  return byTestId(scope, testIds.toolRowHook, attributes)
}

/** The composer's refusal card (`composer-refusal`). */
export function composerRefusal(page: Page): Locator {
  return page.getByTestId(testIds.composerRefusal)
}

/** A row of the Hooks tab (`hook-row`) by its data attributes. */
export function hookRow(scope: Page | Locator, attributes: DataAttributes): Locator {
  return byTestId(scope, testIds.hookRow, attributes)
}

/** A trust item of the project trust dialog by its data attributes (`data-kind`, `data-state`, `data-key`). */
export function trustItem(scope: Page | Locator, attributes: DataAttributes): Locator {
  return byTestId(scope, testIds.projectTrustItem, attributes)
}
