// A fake Claude Code home and the Import from Claude Code dialog for the Phase 12 specs (docs/UI.md 2.19, 9.14, 14;
// ADR-055). The tree is trimmed from `fakeClaudeHomeFiles()` of `apps/server/src/testing/claude-fixtures.ts` (copied
// shapes, no server import): `.claude/{agents,commands (nested),skills,output-styles}`, `settings.json` (a command hook, a
// prompt hook, an http hook, Bash allow rules, a whole-tool deny, a non-Bash allow rule, `model`, `statusLine`),
// `CLAUDE.md` and the sibling `.claude.json` (a stdio server and an http server whose header needs `${DOCS_TOKEN}`; its
// URL is loopback port 9, so an imported server never reaches the network).
//
// The home lives in a `makeTempFolder` folder outside the repository and is removed through `cleanup`. The dialog's
// folder source is a `webkitdirectory` input: Playwright uploads the `.claude` folder itself (`setInputFiles(<folder>)`,
// each file's `webkitRelativePath` starts with `.claude/`) and `.claude.json` through the second input. Call
// `stubClaudeHome(page)` (./claude.ts) before the dialog renders: the server-side scan is never triggered.
import type { Locator, Page } from '@playwright/test'
import type { FileTree, TempFolder } from './claude.ts'
import type { CleanupTask } from './fixtures.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { frontmatterFile, inFolder, jsonText, makeTempFolder, writeTree } from './claude.ts'
import { byTestId } from './locators.ts'
import { testIds } from './testids.ts'

/** The plan's item kinds the specs look at (`claude-import-item` `data-kind`). */
export type ClaudeImportItemKind = 'agent' | 'command' | 'skill' | 'style' | 'hook' | 'mcp-server' | 'shell-rule' | 'tool-deny' | 'instructions' | 'setting' | 'permission'

/** What the fake home holds, by kind and name as the import plan names them. */
export const FAKE_HOME = {
  agents: ['planner', 'reviewer'],
  /** `deploy` has a `` !`git status --short` `` line (runs commands: imported turned off); `frontend/component.md` → `frontend-component`. */
  commands: ['deploy', 'frontend-component'],
  skills: ['pdf'],
  styles: ['terse'],
  /** The PreToolUse command hook (runs commands: imported turned off) and the Stop prompt hook (imported turned on). */
  hooks: { command: 'PreToolUse (Bash)', prompt: 'Stop', http: 'Notification' },
  /** `local-tools` (stdio: imported turned off) and `docs-api` (http, needs `DOCS_TOKEN`). */
  mcpServers: { stdio: 'local-tools', http: 'docs-api' },
  mcpVariable: 'DOCS_TOKEN',
  /** Shell rules from `Bash(npm run test:*)` and `Bash(git status)` (the second one becomes a broader prefix rule). */
  shellRules: ['npm run test', 'git status'],
  deniedTools: ['WebFetch'],
  /** The selectable items a fresh server picks by default: 2 agents, 2 commands, 1 skill, 1 style, 2 hooks, 2 MCP servers, 2 shell rules, 1 denied tool, CLAUDE.md. */
  selectable: 14,
  /** Every item of the plan (the selectable ones and the unsupported http hook, `model`, `statusLine` and `Read(./src/**)`). */
  items: 18,
} as const

/** The reviewer agent's description (`reviewerDescription` changes it for a re-import that "Replaces yours"). */
export const FAKE_HOME_REVIEWER_DESCRIPTION = 'Reviews code for bugs and missing tests.'

/** The agent `builtinConflict` adds: a built-in name, so the plan lists it as a Conflict (Keep mine / Import as explore-2). */
export const FAKE_HOME_CONFLICT_AGENT = 'explore'

export interface FakeHomeOptions {
  /** The description of `agents/reviewer.md`. */
  reviewerDescription?: string
  /** Adds `agents/explore.md` (a built-in name: a `conflict` item with the resolution select). Changes `FAKE_HOME` counts. */
  builtinConflict?: boolean
}

/** The fake home: `.claude/…` and the sibling `.claude.json`, paths relative to the home folder. */
export function fakeClaudeHomeTree(options: FakeHomeOptions = {}): FileTree {
  const claude: Record<string, string> = {
    'agents/reviewer.md': frontmatterFile({
      name: 'reviewer',
      description: options.reviewerDescription ?? FAKE_HOME_REVIEWER_DESCRIPTION,
      tools: 'Read, Grep, Glob',
      model: 'sonnet',
      color: 'green',
    }, 'Review the code you are given and list problems by severity.'),
    ...(options.builtinConflict ? { [`agents/${FAKE_HOME_CONFLICT_AGENT}.md`]: frontmatterFile({ description: 'My own explorer.' }, 'Explore the code base.') } : {}),
    'agents/planner.md': frontmatterFile({ description: 'Plans multi-step work before anyone edits files.', disallowedTools: 'Bash', maxTurns: 5 }, 'Write a numbered plan. Do not edit files.'),
    'commands/deploy.md': frontmatterFile({ 'description': 'Deploy the current branch', 'argument-hint': '"[environment]"' }, 'Current status: !`git status --short`\n\nDeploy the current branch to $ARGUMENTS.'),
    'commands/frontend/component.md': frontmatterFile({ description: 'Create a component' }, 'Create a component named $1 with the props $2.'),
    'skills/pdf/SKILL.md': frontmatterFile({ name: 'pdf', description: 'Fill in PDF forms.' }, 'Fill in the form $ARGUMENTS.'),
    'output-styles/terse.md': frontmatterFile({ name: 'Terse', description: 'Short answers without preamble.' }, 'Answer in as few words as possible.'),
    'settings.json': jsonText({
      model: 'sonnet',
      permissions: { allow: ['Bash(npm run test:*)', 'Bash(git status)', 'Read(./src/**)'], deny: ['WebFetch'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh ~/.claude/hooks/check-bash.sh', timeout: 10 }] }],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check that every task of the conversation is complete. $ARGUMENTS' }] }],
        Notification: [{ hooks: [{ type: 'http', url: 'https://hooks.example.com/notify' }] }],
      },
      statusLine: { type: 'command', command: 'echo status' },
    }),
    'CLAUDE.md': '# Personal instructions\n\n- Prefer small, focused changes.\n',
  }
  return {
    ...inFolder('.claude', claude),
    '.claude.json': jsonText({
      numStartups: 3,
      mcpServers: {
        'local-tools': { type: 'stdio', command: 'node', args: ['/opt/tools/server.mjs', '--stdio'] },
        // Loopback port 9 (discard): an imported, enabled server fails to connect without leaving the machine.
        // eslint-disable-next-line no-template-curly-in-string -- `${VAR}` references are literal `.claude.json` content
        'docs-api': { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'Authorization': 'Bearer ${DOCS_TOKEN}', 'X-Team': '${TEAM_ID:-core}' } },
      },
    }),
  }
}

export interface FakeClaudeHome {
  /** The home folder (outside the repository). */
  home: string
  /** `<home>/.claude`: the folder to pick. */
  claudeDir: string
  /** `<home>/.claude.json`. */
  claudeJson: string
  /** Rewrites one file below `.claude/` (e.g. before a re-import). */
  writeClaudeFile: (relative: string, content: string) => Promise<void>
}

/** Writes the fake home into a new temp folder outside the repository, removed through `cleanup`. */
export async function seedFakeClaudeHome(cleanup: (task: CleanupTask) => void, tree: FileTree = fakeClaudeHomeTree()): Promise<FakeClaudeHome> {
  const folder: TempFolder = await makeTempFolder('claude-home')
  cleanup(() => folder.remove())
  await writeTree(folder.path, tree)
  const claudeDir = join(folder.path, '.claude')
  return {
    home: folder.path,
    claudeDir,
    claudeJson: join(folder.path, '.claude.json'),
    writeClaudeFile: (relative, content) => writeFile(join(claudeDir, ...relative.split('/')), content),
  }
}

// ---------- the dialog ----------

/** The Import from Claude Code dialog (`claude-import-dialog`, `data-step` source | preview | result). */
export function claudeImportDialog(page: Page): Locator {
  return page.getByTestId(testIds.claudeImportDialog)
}

/** Opens Settings -> Customize and the dialog from its header action; returns the dialog on its source step. */
export async function openClaudeImport(page: Page, baseURL = ''): Promise<Locator> {
  await page.goto(`${baseURL}/settings/customize`)
  await page.getByTestId(testIds.customizeImportClaude).click()
  const dialog = claudeImportDialog(page)
  await expect(dialog).toHaveAttribute('data-step', 'source')
  return dialog
}

/** Picks the fake home's `.claude` folder and its `.claude.json` (the folder source) and checks the picked line. */
export async function chooseClaudeFolder(dialog: Locator, home: FakeClaudeHome, options: { claudeJson?: boolean } = {}): Promise<void> {
  await dialog.getByTestId(testIds.claudeImportFolderInput).setInputFiles(home.claudeDir)
  await expect(dialog.locator('[data-slot="claude-import-picked"]')).toContainText(/\d+ files? picked/)
  if (options.claudeJson !== false) {
    await dialog.getByTestId(testIds.claudeImportConfigInput).setInputFiles(home.claudeJson)
    await expect(dialog.locator('[data-slot="claude-import-picked"]')).toContainText('.claude.json added')
  }
}

/** Continue on the source step: waits for the preview step and returns the preview. */
export async function continueToPreview(dialog: Locator): Promise<Locator> {
  await dialog.getByTestId(testIds.claudeImportContinue).click()
  await expect(dialog).toHaveAttribute('data-step', 'preview')
  const preview = dialog.getByTestId(testIds.claudeImportPreview)
  await expect(preview).toBeVisible()
  return preview
}

/** Stubbed home + the dialog from Customize + the fake home picked + Continue: the dialog at step 2. */
export async function openClaudeImportPreview(page: Page, home: FakeClaudeHome, baseURL = ''): Promise<{ dialog: Locator, preview: Locator }> {
  const dialog = await openClaudeImport(page, baseURL)
  await chooseClaudeFolder(dialog, home)
  const preview = await continueToPreview(dialog)
  return { dialog, preview }
}

/** A preview group by kind (`unsupported` for the unsupported and invalid items). */
export function claudeImportGroup(scope: Page | Locator, kind: ClaudeImportItemKind | 'unsupported'): Locator {
  return byTestId(scope, testIds.claudeImportGroup, { 'data-kind': kind })
}

/** A preview item by kind and name. */
export function claudeImportItem(scope: Page | Locator, kind: ClaudeImportItemKind, name: string): Locator {
  return byTestId(scope, testIds.claudeImportItem, { 'data-kind': kind, 'data-name': name })
}

/** The status word of an item ("New", "Replaces yours", "Unchanged", …). */
export function claudeImportStatus(item: Locator): Locator {
  return item.locator('[data-slot="claude-import-status"]')
}

/** The Turn on after import switch of an executable item. */
export function claudeImportEnable(item: Locator): Locator {
  return item.locator('[data-action="enable"]')
}
