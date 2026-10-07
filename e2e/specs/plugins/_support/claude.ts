/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` is literal Claude Code plugin content */
// Claude Code plugins and marketplaces of the Phase 12 plugin specs (docs/UI.md 2.19, 8.13; ADR-053, ADR-054): small
// e2e copies of the shapes of `apps/server/src/testing/claude-fixtures.ts` (`review-kit`, `notes-only`, the `acme-tools`
// marketplace), built as `FileTree`s and written into temporary folders outside the repository (`seedTempTree`), zipped
// (`zipTree`) or listed by a local-folder marketplace (no network: the e2e server runs with `HF_OFFLINE=1`).
//
// - `claudeKitTree(name)`: a Claude Code plugin that needs trust (its PostToolUse command hook only matches the tool
//   name `E2eNeverMatches`, so it never runs in another spec's chat), with `userConfig` (the URL `API_URL`, the secret
//   `API_TOKEN`), two commands (`review`, `db/migrate` = `<name>:db:migrate`), an agent `reviewer`, a skill `notes` and
//   the parts Claude Code knows but the harness ignores (`.lsp.json`, `bin/`, an `http` hook handler).
// - `claudeNotesTree(name, version)`: commands only (`note`), with a manifest: no trust needed.
// - `marketplaceTree(name, plugins)`: `.claude-plugin/marketplace.json` with relative entries for the given plugins
//   (their folders under `plugins/<name>/`) plus two unsupported entries (a `command` source and git on another host).
//
// Plugins and marketplaces are global state of the server: specs remove what they add through the `cleanup` fixture
// (`useCleanPlugin`, `useCleanMarketplace`), and also what an earlier run left behind (by plugin id / marketplace name).
import type { Locator, Page } from '@playwright/test'
import type { MarketplaceDetail, MarketplaceSummary } from '../../../../packages/shared/src/index.ts'
import type { FileTree } from '../../../helpers/claude.ts'
import type { HarnessApi } from '../../../helpers/index.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { frontmatterFile, inFolder, jsonText, script } from '../../../helpers/claude.ts'
import { testIds } from './testids.ts'
import { byTestId } from './ui.ts'

// ---------- plugin trees ----------

/** The description of `claudeKitTree` plugins. */
export const KIT_DESCRIPTION = 'An e2e Claude Code plugin: review commands, a reviewer agent, a notes skill and a format hook.'
/** The body of its `review` command (`$ARGUMENTS` is the text after the command). */
export const KIT_REVIEW_BODY = 'Review the changed files. Focus on $ARGUMENTS.'
/** The matcher of its hook: no tool has this name, so the hook never runs. */
export const KIT_HOOK_MATCHER = 'E2eNeverMatches'
/** Its hook command, as `hooks/hooks.json` has it. */
export const KIT_HOOK_COMMAND = 'sh ${CLAUDE_PLUGIN_ROOT}/hooks/format.sh'

/** A Claude Code plugin that needs trust (see the module comment). */
export function claudeKitTree(name: string, version = '1.0.0'): FileTree {
  return {
    '.claude-plugin/plugin.json': jsonText({
      name,
      version,
      description: KIT_DESCRIPTION,
      author: { name: 'E2E Tools' },
      userConfig: {
        API_URL: { type: 'string', title: 'API URL', description: 'Base URL of the review API.', default: 'https://review.example.com', required: false },
        API_TOKEN: { type: 'string', title: 'API token', description: 'Token of the review API.', sensitive: true, required: true },
      },
    }),
    'commands/review.md': frontmatterFile({ 'description': 'Review the changed files', 'argument-hint': '"[focus]"' }, KIT_REVIEW_BODY),
    'commands/db/migrate.md': frontmatterFile({ description: 'Plan a database migration' }, 'Plan a migration of the table $1.'),
    'agents/reviewer.md': frontmatterFile({ name: 'reviewer', description: 'Reviews code for bugs and missing tests.', tools: 'Read, Grep' }, 'Review the code you are given.'),
    'skills/notes/SKILL.md': frontmatterFile({ name: 'notes', description: 'Writes release notes.' }, 'Write release notes for the changes.'),
    'hooks/hooks.json': jsonText({
      hooks: {
        PostToolUse: [{
          matcher: KIT_HOOK_MATCHER,
          hooks: [
            { type: 'command', command: KIT_HOOK_COMMAND, timeout: 10 },
            { type: 'http', url: 'https://hooks.example.com/e2e-kit' },
          ],
        }],
      },
    }),
    'hooks/format.sh': script('#!/bin/sh\n# e2e fixture: never runs (its matcher names no tool).\ncat > /dev/null\n'),
    '.lsp.json': jsonText({ go: { command: 'gopls', args: ['serve'], extensionToLanguage: { '.go': 'go' } } }),
    'bin/tool': script('#!/bin/sh\n# Never run by the harness (bin/ is ignored).\nexit 0\n'),
    'README.md': `# ${name}\n\nA Claude Code plugin of the harness-forge e2e specs.\n`,
  }
}

/** The body of the `note` command of `claudeNotesTree` plugins. */
export const NOTES_NOTE_BODY = 'Write a short note about: $ARGUMENTS'

/** A Claude Code plugin with commands only (no executables: no trust). */
export function claudeNotesTree(name: string, version = '1.0.0'): FileTree {
  return {
    '.claude-plugin/plugin.json': jsonText({ name, version, description: 'Two note commands of the e2e specs.' }),
    'commands/note.md': frontmatterFile({ description: 'Write a note about the current task' }, NOTES_NOTE_BODY),
    'commands/summarize.md': frontmatterFile({ description: 'Summarize the conversation' }, 'Summarize this conversation in five bullet points.'),
  }
}

// ---------- marketplaces ----------

export interface MarketplacePluginEntry {
  /** The entry name (= the plugin's `name`, so the installed plugin id). */
  name: string
  tree: FileTree
  version?: string
  description?: string
  category?: string
  tags?: string[]
}

/** The two unsupported entries of `marketplaceTree`. */
export const UNSUPPORTED_ENTRIES = {
  command: 'e2e-command-plugin',
  gitlab: 'e2e-gitlab-plugin',
} as const

/** The `marketplace.json` text of a marketplace with relative entries for `plugins` and two unsupported entries. */
export function marketplaceJson(name: string, plugins: readonly MarketplacePluginEntry[]): string {
  return jsonText({
    name,
    owner: { name: 'E2E Tools' },
    metadata: { description: 'Plugins of the harness-forge e2e specs.', version: '1.0.0' },
    plugins: [
      ...plugins.map(plugin => ({
        name: plugin.name,
        source: `./plugins/${plugin.name}`,
        ...(plugin.description === undefined ? {} : { description: plugin.description }),
        ...(plugin.version === undefined ? {} : { version: plugin.version }),
        ...(plugin.category === undefined ? {} : { category: plugin.category }),
        ...(plugin.tags === undefined ? {} : { tags: plugin.tags }),
      })),
      { name: UNSUPPORTED_ENTRIES.command, source: { source: 'command', command: 'make plugin', timeout: 60 }, description: 'Built by a command.' },
      { name: UNSUPPORTED_ENTRIES.gitlab, source: { source: 'url', url: 'https://gitlab.com/acme/gitlab-plugin.git' }, description: 'Git on another host.' },
    ],
  })
}

/** A marketplace folder: `.claude-plugin/marketplace.json` and the folders of its relative entries. */
export function marketplaceTree(name: string, plugins: readonly MarketplacePluginEntry[]): FileTree {
  let tree: FileTree = {
    '.claude-plugin/marketplace.json': marketplaceJson(name, plugins),
    'README.md': `# ${name}\n\nA Claude Code marketplace of the harness-forge e2e specs.\n`,
  }
  for (const plugin of plugins)
    tree = { ...tree, ...inFolder(`plugins/${plugin.name}`, plugin.tree) }
  return tree
}

/** Rewrites the `marketplace.json` of a marketplace folder (e.g. a bumped entry version before a Refresh). */
export async function rewriteMarketplaceJson(folder: string, name: string, plugins: readonly MarketplacePluginEntry[]): Promise<void> {
  await writeFile(join(folder, '.claude-plugin', 'marketplace.json'), marketplaceJson(name, plugins))
}

/** Rewrites one file of a plugin folder of a marketplace folder (`plugins/<plugin>/<path>`). */
export async function rewriteMarketplacePluginFile(folder: string, plugin: string, path: string, content: string): Promise<void> {
  await writeFile(join(folder, 'plugins', plugin, ...path.split('/')), content)
}

// ---------- API: plugins and marketplaces (cleanup included) ----------

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'not_found'
}

/** Uninstalls a plugin through the API (a plugin that is not installed is fine). */
export async function uninstallPlugin(api: HarnessApi, id: string): Promise<void> {
  try {
    await api.client.plugins.remove({ params: { id }, query: {} })
  }
  catch (error) {
    if (!isNotFound(error))
      throw error
  }
}

/** Removes a plugin left over by an earlier run and registers its uninstall through `cleanup` (it runs after a timeout too). */
export async function useCleanPlugin(api: HarnessApi, cleanup: (task: (api: HarnessApi) => unknown) => void, id: string): Promise<void> {
  await uninstallPlugin(api, id)
  cleanup(api => uninstallPlugin(api, id))
}

/** Every marketplace of the server. */
export async function listMarketplaces(api: HarnessApi): Promise<MarketplaceSummary[]> {
  return (await api.client.marketplaces.list()).items
}

/** Removes the marketplace named `name`, if one is added. */
export async function removeMarketplaceNamed(api: HarnessApi, name: string): Promise<void> {
  for (const item of await listMarketplaces(api)) {
    if (item.name !== name)
      continue
    try {
      await api.client.marketplaces.remove({ params: { id: item.id } })
    }
    catch (error) {
      if (!isNotFound(error))
        throw error
    }
  }
}

/** Removes a marketplace of that name left over by an earlier run and registers its removal through `cleanup`. */
export async function useCleanMarketplace(api: HarnessApi, cleanup: (task: (api: HarnessApi) => unknown) => void, name: string): Promise<void> {
  await removeMarketplaceNamed(api, name)
  cleanup(api => removeMarketplaceNamed(api, name))
}

/** Adds a local-folder marketplace through the API (`POST /api/marketplaces`, source `path`). */
export function addFolderMarketplace(api: HarnessApi, path: string): Promise<MarketplaceDetail> {
  return api.client.marketplaces.add({ body: { source: { type: 'path', path } } })
}

/** Installs a marketplace entry through the API (inspect, then install the reviewed hash; `trust` for plugins that run code). */
export async function installMarketplaceEntry(api: HarnessApi, marketplaceId: string, plugin: string, options: { trust?: boolean } = {}): Promise<void> {
  const source = { source: 'marketplace' as const, marketplaceId, plugin }
  const inspection = await api.client.pluginInstall.inspect({ body: source })
  await api.client.pluginInstall.install({ body: { ...source, sha256: inspection.sha256, ...(options.trust ? { trust: true } : {}) } })
}

// ---------- UI ----------

/** The Marketplaces page (`/plugins/marketplaces`), `query` like `?m=<id>`. */
export async function openMarketplaces(page: Page, query = ''): Promise<Locator> {
  await page.goto(`/plugins/marketplaces${query}`)
  const view = page.getByTestId(testIds.marketplacesPage)
  await expect(view).toBeVisible()
  return view
}

/** The chip of a marketplace (`marketplace-row`; `''` = All). */
export function marketplaceChip(scope: Page | Locator, marketplaceId: string): Locator {
  return byTestId(scope, testIds.marketplaceRow, { 'data-marketplace-id': marketplaceId })
}

/** An entry row of the Marketplaces page by entry name. */
export function marketplaceEntry(scope: Page | Locator, name: string): Locator {
  return byTestId(scope, testIds.marketplaceEntry, { 'data-name': name })
}

/** The marketplace selected on the page: `?m=<id>` of the URL, or null for All. */
export function selectedMarketplaceId(page: Page): string | null {
  return new URL(page.url()).searchParams.get('m')
}

/** Counts the `POST /api/marketplaces` requests the page sends (the suggestion card must send none before its Add). */
export async function countMarketplaceAdds(page: Page): Promise<() => number> {
  let count = 0
  await page.route(url => url.pathname === '/api/marketplaces', async (route) => {
    if (route.request().method() === 'POST')
      count += 1
    await route.fallback()
  })
  return () => count
}
