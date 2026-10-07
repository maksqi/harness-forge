// Screenshots of every screen for the visual review (opt-in: `E2E_SCREENSHOTS=1`, otherwise every test is skipped).
// Dark and light, desktop 1440x900 and a 390x844 phone (touch), a browser clock that starts at a fixed time, reduced
// motion; the files go to `.tmp/screenshots/{dark,light}/<screen>-{desktop,mobile}.png`. The spec runs its own
// password-protected server from the build with a fresh data directory (`startServer`), so the pictures hold only the
// chats it creates, and the login page is one of the screens. Phase 5 screens: a chat whose messages have versions
// (the "‹ 2/2 ›" switchers), the Share dialog with an outdated link, the shared chat page and its unavailable state,
// and Settings -> Data with that link in its list. Phase 6 screens: a chat with generated images (galleries), an image
// turn in flight (the placeholder tiles), the composer while it records, the "Delete this version?" dialog and
// Settings -> Media with every model chosen. Phase 7 screens: the project switcher open, the new-chat project picker,
// the Add project dialog, Settings -> Projects, the edit and the shell approvals of `mock:workspace`, an expanded diff
// (also on the phone), the terminal output of its shell step, and the Encryption key and Storage cleanup sections of
// Settings -> Data (a leftover blob in the server's file store gives the cleanup something to count). Phase 8 screens
// (W8.12): the changes panel (This chat with a diff, the Git view; on the phone the sheet), the revert confirmation,
// the rewind dialog, a shell approval card with the rule option checked, terminal output in a sticky working folder
// with rule badges, the allowed commands of a project and the automatic cleanup in Settings -> Data. Their data: the
// `harness-forge` project folder becomes a git repository after the Phase 7 chats (when git is installed), gets the
// rules `ls`, `mkdir` and `pnpm test` (plus the global `git status`), and three more chats run in it. Phase 9 screens
// (W9.13): a plan waiting for its approval (with the todo strip), a todo strip expanded on an unfinished list (a
// `mock:todo` run stopped after its second list), two finished sub-agents with one expanded, a compacted chat with the
// summary open, a live `mock:steer` run with a steer note and a queued server command, the `@` mention menu, and Settings
// -> General -> Agent; the sub-agent and compaction models are set for the whole run (`mock:subagent`, `mock:compact`).
// Phase 10 screens (W10.13): Settings -> Customize with the `notes` project (personal, project, shadowed and invalid
// rows), the definition editor, the grouped slash menu, a live chat with two background agents, a background agent's
// result note, the Remember dialog and a plugin's Agents and Skills sections. Their data: definition files in the `notes`
// project folder (never in `harness-forge`, whose files show in the mention and Git screens), four personal
// definitions, a `mock:agents` chat in `notes` that ran a custom agent and a `mock:background` chat whose agent
// reported through a server-started turn (both seeded with the sub-agent model cleared); the live background chat and
// the plugin are made by their screens and removed again in `close`.
// Phase 11 screens (W11.13): Settings -> Customize -> Hooks with the `hooks-demo` project (personal, project and plugin
// rows), the hook editor, the hook import with a preview, the project trust dialog (new, changed and approved items), the
// project MCP dialog (a connected stdio server, an HTTP server waiting for approval, the variables), the Output styles
// tab, the composer's style menu, a message a UserPromptSubmit hook refused, the hook notes of a chat (a SessionStart
// note, a shell call a PreToolUse hook blocked, a failed Stop hook), a Stop hook continuation and the hook-pack plugin's
// Hooks and Output styles sections. Their data: the `hooks-demo` project folder (hook scripts written by
// `writeHookScript` and run as `sh .harness/hooks/<file>.sh`, three versions of its `.harness/settings.json`: one per
// seeded chat, then the final one, `.mcp.json` with the dependency-free stdio fixture `mcp-min.mjs`, a command with
// shell lines, a project output style), approved through the API; two personal hooks (made last: no seeded turn runs
// them) and a personal style; the hook-pack plugin is installed by its screens and removed again in `close`.
// Phase 12 screens (W12.14): the Marketplaces page with a local-folder marketplace, the install dialog's GitHub tab and a
// Claude Code plugin's install preview (a zip, never installed), the import from Claude Code at its preview step (a fake
// Claude Code home uploaded as a folder; `GET /api/claude-import/home` stubbed in the browser), the project file editor
// on a `notes` agent, the hook editor with the Prompt type, and the project trust dialog with a partly selected group
// (the mixed Select all). Their data: the marketplace folder and the fake home live in temp folders outside the
// repository, removed with the server; nothing is installed or imported.
// A screen that starts something (a run, a recording, a dialog, settings only it needs, the open changes panel) undoes
// it in `close`, so the other screens look the same in every run.
// `@readme` (also `@screenshots`): the README images as full 1440x900 frames, written to `.tmp/screenshots/readme/`
// with the file names of `docs/assets/screenshots/` (chat-dark, chat-light, plugins-dark, provider-wizard-dark,
// settings-dark, workspace-dark, changes-panel-dark) plus customize-dark (Phase 10: Settings -> Customize), hooks-dark
// (Phase 11: Settings -> Customize -> Hooks), marketplaces-dark and claude-import-dark (Phase 12: the Marketplaces page
// and the import preview), candidates for the README.
import type { Locator, Page } from '@playwright/test'
import type { HooksConfig, HookScriptName, HookScriptOptions, StartedServer, TempFolder, UiStreamChunk } from '../../helpers/index.ts'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { devices } from '@playwright/test'
import { createMessageId } from '../../../packages/shared/src/index.ts'
import { chooseClaudeFolder, continueToPreview, fakeClaudeHomeTree, openClaudeImport } from '../../helpers/claude-home.ts'
import {
  approveProjectItems,
  byTestId,
  changesFile,
  changesFileButton,
  changesFileDiff,
  changesPanel,
  changesToggle,
  changesViewTab,
  COLOR_MODE_STORAGE_KEY,
  composer,
  expect,
  expectMessageStatus,
  gitAvailable,
  HarnessApi,
  hookGroup,
  hookNote,
  initGitRepository,
  lastAssistantMessage,
  makeTempFolder,
  mcpVariable,
  MOCK_CHECKPOINT_DIR,
  MOCK_CHECKPOINT_DONE,
  MOCK_CHECKPOINT_FILE,
  MOCK_HOOKS_MODEL,
  MOCK_WORKSPACE_DONE,
  naturalSize,
  openRewind,
  parseUiMessageStream,
  pressShortcut,
  projectSettings,
  REPO_ROOT,
  sendMessage,
  startServer,
  stubClaudeHome,
  test,
  testIds,
  trustItem,
  userMessages,
  waitForTestId,
  workspaceRoot,
  writeHookScript,
  writeProjectFile,
  writeTree,
  zipTree,
} from '../../helpers/index.ts'
import { openProjectFileEditor, projectRow } from '../../helpers/project-files.ts'
import { claudeKitTree, claudeNotesTree, marketplaceEntry, marketplaceTree } from '../plugins/_support/claude.ts'

const ENABLED = process.env.E2E_SCREENSHOTS === '1'
const OUTPUT_DIR = join(REPO_ROOT, '.tmp/screenshots')
/** Phase 12: the screenshot marketplace and its plugins (local folders: no network). */
const MARKETPLACE_NAME = 'acme-tools'
const MARKETPLACE_PLUGINS = [
  { name: 'review-kit', tree: claudeKitTree('review-kit', '1.2.0'), version: '1.2.0', description: 'Review commands, a reviewer agent, a release-notes skill and a format hook.', category: 'development', tags: ['review', 'testing'] },
  { name: 'release-notes', tree: claudeNotesTree('release-notes', '0.3.0'), version: '0.3.0', description: 'Note and summary commands for release work.', category: 'productivity', tags: ['notes'] },
  { name: 'db-migrations', tree: claudeKitTree('db-migrations', '2.0.1'), version: '2.0.1', description: 'Plan and review database migrations before they ship.', category: 'database', tags: ['sql'] },
]
/** The README images (`@readme`), named like the files in `docs/assets/screenshots/`. */
const README_DIR = join(OUTPUT_DIR, 'readme')
const PASSWORD = 'screenshots-password'
const THEMES = ['dark', 'light'] as const
type Theme = (typeof THEMES)[number]
type Viewport = 'desktop' | 'mobile'

/** The chats every screenshot run shows (created once per server, newest last). */
interface Seed {
  markdown: string
  reasoning: string
  tools: string
  approval: string
  error: string
  /** Its first message and that message's reply have two versions each. */
  versions: string
  /** Has a share link (reasoning and tool details included) made before its last message, so it is outdated. */
  shared: string
  /** `/share/<token>` of that link. */
  sharePath: string
  /** Two image turns: one 16:9 image, then two variations of it (an edit). */
  images: string
  /** The workspace root of the screenshot server. */
  workspaceRoot: string
  /** A `mock:workspace` run in auto mode: write, edit and shell rows, done. */
  workspace: string
  /** A `mock:workspace` reply that waits for the approval of its edit (the write was allowed). */
  editApproval: string
  /** A `mock:workspace` reply in Accept edits mode that waits for the approval of its shell command. */
  shellApproval: string
  /** The `harness-forge` project (its Allowed commands dialog). */
  project: string
  /**
   * Phase 8: a `mock:checkpoint` turn in Accept edits (the rules ran its shell calls) and a `mock:shell` turn that
   * deleted and created a file: This chat lists `checkpoint.txt`, Git three files (when git is installed).
   */
  changes: string
  /** Phase 8: a `mock:checkpoint` run whose shell rows show the sticky folder and the rule badges. */
  terminalCwd: string
  /** Phase 8: a `mock:shell` reply waiting for the approval of a command no rule covers. */
  ruleApproval: string
  /** Phase 9: a `mock:plan` reply in the `harness-forge` project waiting for its plan approval (todos 0/2). */
  plan: string
  /** Phase 9: two finished `mock:subagent` sub-agents in the `harness-forge` project. */
  subagents: string
  /** Phase 9: a `mock:todo` run stopped after its second list (1/3, "Changing the code"). */
  todos: string
  /** Phase 9: three questions, then `/compact keep the parser details` (summarized by `mock:compact`). */
  compacted: string
  /** Phase 10: the `notes` project (its folder holds agent, command and skill files). */
  notes: string
  /** Phase 10: a `mock:agents` chat in `notes` that ran the personal agent `code-reviewer`. */
  customAgent: string
  /** Phase 10: a `mock:background` chat whose background agent reported through a server-started turn. */
  taskResult: string
  /** Phase 11: the `hooks-demo` project (hooks, `.mcp.json`, a command with shell lines, the project style Learning). */
  hooksDemo: string
  /** Phase 11: a `mock:hooks` chat in `hooks-demo`: a SessionStart note, a shell call a hook blocked, a failed Stop hook. */
  hookNotes: string
  /** Phase 11: a `mock:hooks` chat in `hooks-demo` whose Stop hook asked the agent to continue (the carrier note). */
  hookContinuation: string
  /** Phase 12: the `acme-tools` marketplace (a local folder outside the repository). */
  marketplace: string
  /** Phase 12: the `.claude` folder of the fake Claude Code home (outside the repository) and its `.claude.json`. */
  claudeHome: { home: string, claudeDir: string, claudeJson: string, writeClaudeFile: (relative: string, content: string) => Promise<void> }
  /** Phase 12: the temp folders of the seed, removed with the server. */
  tempFolders: TempFolder[]
  /** The screenshot server (API calls of the screens that start something). */
  baseURL: string
  /** The start of the browser clock: a little after the seed, so relative times read "2m ago". */
  now: number
}

const MARKDOWN = [
  'Plan the move of auth to server sessions:',
  '',
  '## Steps',
  '',
  '1. Add a `sessions` table with an expiry column.',
  '2. Issue an **HttpOnly** cookie on login and rotate it on privilege changes.',
  '3. Drop the token from local storage.',
  '',
  '| Option | Pros | Cons |',
  '| --- | --- | --- |',
  '| Cookie session | Simple, revocable | Needs CSRF care |',
  '| JWT | Stateless | Hard to revoke |',
  '',
  '```ts',
  'export function sessionCookie(id: string): string {',
  '  return ["hf_session=" + id, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"].join("; ")',
  '}',
  '```',
  '',
  '> Keep the old tokens valid for one release, then remove them.',
].join('\n')

/** The last question of the shared chat: a short markdown list. */
const SHARED_SUMMARY = [
  'Summarize the plan as a list:',
  '',
  '1. Add a `sessions` table.',
  '2. Issue an **HttpOnly** cookie on login.',
  '3. Drop the token from local storage.',
].join('\n')

/** Files of the `harness-forge` project folder for the Phase 8 screens (committed when git is installed). */
const PROJECT_FILES: Readonly<Record<string, string>> = {
  'README.md': '# harness-forge\n\nA self-hosted chat and agent harness.\n',
  [MOCK_CHECKPOINT_FILE]: 'Release checklist: draft\n',
  'docs/old-notes.md': '# Old notes\n\nMoved to the release notes.\n',
  [`${MOCK_CHECKPOINT_DIR}/app.js`]: 'export const ready = true\n',
  [`${MOCK_CHECKPOINT_DIR}/index.html`]: '<!doctype html>\n',
}

/** Phase 10: the definition files of the `notes` project (Customize, the slash menu, the Remember dialog). */
const NOTES_FILES: Readonly<Record<string, string>> = {
  'README.md': '# Notes\n\nRelease notes and meeting notes.\n',
  '.harness/agents/test-writer.md': '---\nname: test-writer\ndescription: Writes vitest tests for a module and runs them.\ntools: [read_file, write_file, shell]\n---\nWrite focused tests first.\n',
  '.claude/agents/test-writer.md': '---\nname: test-writer\ndescription: Writes tests (the Claude Code version).\n---\nWrite tests.\n',
  '.claude/agents/broken.md': '---\nname: broken\n---\nA file without a description.\n',
  '.harness/commands/review.md': '---\ndescription: Review a file for bugs\nargument-hint: <file> [focus]\n---\nReview $1 with a focus on $2.\n',
  '.harness/commands/frontend/lint.md': '---\ndescription: Lint the frontend and fix what is safe\n---\nLint the frontend.\n',
  '.harness/skills/release-notes/SKILL.md': '---\nname: release-notes\ndescription: How this project writes release notes.\n---\nList the user-facing changes first.\n',
  '.harness/skills/release-notes/template.md': '# Release {version}\n',
}

/** Phase 10: the personal definitions of the run (`test-writer` loses to the project's file in `notes`). */
const PERSONAL_DEFINITIONS: readonly { kind: 'agent' | 'command' | 'skill', content: string }[] = [
  { kind: 'agent', content: '---\nname: code-reviewer\ndescription: Reviews diffs for bugs and risky changes.\ntools: Read, Grep, Glob\nmodel: inherit\n---\nPERSONA: careful reviewer\nList real bugs first, then risky changes.\n' },
  { kind: 'agent', content: '---\nname: test-writer\ndescription: Writes tests the way I like them.\n---\nPERSONA: test writer\n' },
  { kind: 'command', content: '---\nname: standup\ndescription: Draft my standup notes\n---\nDraft my standup notes from $ARGUMENTS.\n' },
  { kind: 'skill', content: '---\nname: pdf-forms\ndescription: Fill PDF forms from a description.\n---\nUse the form fields as listed.\n' },
]

/** Phase 10: the plugin of the plugin-detail-agents screen (made in `open`, removed in `close`). */
const AGENT_PLUGIN_ID = 'db-tools'

/** Phase 11: the project of the hook, trust, project MCP and output style screens (never `harness-forge` or `notes`). */
const HOOKS_PROJECT = 'hooks-demo'
/** Phase 11: the example plugin of the plugin hook screens (installed in `open`, removed in `close`). */
const HOOK_PLUGIN_ID = 'hook-pack'
/** Phase 11: the dependency-free stdio MCP fixture, copied into `hooks-demo/tools/`. */
const MCP_MIN_FIXTURE = join(REPO_ROOT, 'apps/server/src/mcp/__fixtures__/mcp-min.mjs')

/**
 * Phase 11: the hook scripts of `hooks-demo` (`writeHookScript`: POSIX sh files run as `sh .harness/hooks/<file>.sh`
 * from the project folder), by file name.
 */
const HOOK_SCRIPTS: Readonly<Record<string, readonly [HookScriptName, HookScriptOptions]>> = {
  guard: ['deny', { file: 'guard', text: 'Deleting the build folder isn\'t allowed here.' }],
  branch: ['context', { file: 'branch', text: 'Branch main, 3 files changed since v1.6.' }],
  lint: ['error', { file: 'lint', text: 'eslint: 2 problems in src/app.ts' }],
  tests: ['stop-once', { file: 'tests', text: 'Run the parser tests before you stop: 1 test fails.' }],
  secrets: ['prompt-block', { file: 'secrets', text: 'Don\'t paste API keys into the chat.' }],
  format: ['context', { file: 'format', text: 'prettier rewrote the file.' }],
}

/** Phase 11: the other files of `hooks-demo`. */
const HOOKS_FILES: Readonly<Record<string, string>> = {
  'README.md': '# hooks-demo\n\nA small app with project hooks and MCP servers.\n',
  'src/app.ts': 'export const ready = true\n',
  '.harness/output-styles/release-notes.md': '---\nname: Release notes\ndescription: User-facing changes first, as short bullets.\nkeep-coding-instructions: true\n---\nWrite like release notes: user-facing changes first, one short bullet each.\n',
  '.harness/commands/status.md': '---\ndescription: Summarize the working tree before a release\n---\nThe state of the repository:\n\n!`git status --short`\n!`ls docs`\n\nSummarize what changed since the last release.\n',
  // Variable references (`mcpVariable`) stay as written: the server expands them from the project's variables.
  '.mcp.json': `${JSON.stringify({
    mcpServers: {
      docs: { command: 'node', args: ['tools/mcp-min.mjs', '--name', 'docs'], env: { DOCS_TOKEN: mcpVariable('DOCS_TOKEN') } },
      github: { type: 'http', url: `https://${mcpVariable('GITHUB_HOST', 'api.githubcopilot.com')}/mcp/`, headers: { Authorization: `Bearer ${mcpVariable('GITHUB_TOKEN')}` } },
    },
  }, null, 2)}\n`,
}

/** Phase 11: the personal output style (the composer's menu and the Output styles tab). */
const PERSONAL_STYLE = '---\nname: terse\ndescription: Short, direct answers without a preamble.\n---\nAnswer in as few words as possible. No preamble, no summary.\n'

/** Phase 11: the Claude Code settings the hook-import screen pastes (two hooks, one invalid matcher, an ignored prompt hook). */
const HOOK_IMPORT_JSON = JSON.stringify({
  permissions: { allow: ['Bash(pnpm test)'] },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/guard.sh', timeout: 60 }] },
      { matcher: '^Bash.*$', hooks: [{ type: 'command', command: './scripts/audit.sh' }] },
    ],
    // Phase 12: prompt hooks import; the ignored example is an http hook.
    Stop: [{ hooks: [{ type: 'command', command: 'pnpm lint --quiet' }, { type: 'http', url: 'https://hooks.example.com/notify' }] }],
  },
}, null, 2)

interface Screen {
  name: string
  only?: Viewport
  /** Navigates and waits until the screen shows what it should. */
  open: (page: Page, seed: Seed) => Promise<void>
  /** After the picture: undoes what `open` started (a run, a recording, a dialog, settings only this screen needs). */
  close?: (page: Page, seed: Seed) => Promise<void>
}

/** The screenshot server's API as the logged-in browser (the page's cookies). */
function pageApi(page: Page, seed: Seed): HarnessApi {
  return new HarnessApi(page.request, seed.baseURL)
}

/** Read aloud as the Media screen shows it; the other screens keep it off (no Read aloud buttons on their replies). */
const SPEECH_SETTINGS = { speechModelRef: 'mock:speech', speechVoice: 'mock-voice-a', speechSpeed: 1.25 }
const NO_SPEECH_SETTINGS = { speechModelRef: null, speechVoice: null, speechSpeed: 1 }

/** The chat an image-turn screen creates for itself (deleted again in `close`). */
let generatingChatId: string | null = null
/** The chat of the live steer screen (deleted again in `close`). */
let steerChatId: string | null = null
/** Phase 10: the chat of the live background agents screen (deleted again in `close`). */
let backgroundChatId: string | null = null
/** How far the page clock ran ahead of the real one before the image-turn screen set it to the real time. */
let clockOffsetMs = 0

/** The transcript's scrolling element is at its end (opening a chat jumps to the bottom, docs/UI.md 5.9). */
async function expectTranscriptAtBottom(page: Page): Promise<void> {
  await expect.poll(async () => page.getByTestId(testIds.transcript).evaluate((root) => {
    const view = root.ownerDocument.defaultView!
    const scroller = [root, ...root.querySelectorAll('*')].find(node => ['auto', 'scroll'].includes(view.getComputedStyle(node).overflowY))
    return scroller ? Math.ceil(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight - 1 : true
  }), { message: 'the transcript is scrolled to the bottom' }).toBe(true)
}

async function openChat(page: Page, chatId: string): Promise<void> {
  await page.goto(`/chat/${chatId}`)
  await expect(page.getByTestId(testIds.chatTitle)).not.toHaveText('')
  await expect(page.getByTestId(testIds.messageAssistant).first()).toBeVisible()
  await expectTranscriptAtBottom(page)
}

async function openNewChatScreen(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
  await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', 'mock:echo')
}

async function openSettings(page: Page, path: string, ready: (page: Page) => Promise<void>): Promise<void> {
  await page.goto(path)
  await expect(page.getByTestId(testIds.pageHeader)).toBeVisible()
  await ready(page)
}

/** Below the 768 px sheet breakpoint (the phone run). */
function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1440) < 768
}

/** The tool row of a workspace tool in the last reply. */
function workspaceRow(page: Page, toolName: string): Locator {
  return byTestId(lastAssistantMessage(page), testIds.toolRow, { 'data-tool-name': toolName })
}

/**
 * Opens the changes panel of the open chat on `view` (the pane on the desktop, the sheet on the phone) and waits until
 * the view loaded.
 */
async function openChangesPanel(page: Page, view: 'chat' | 'git'): Promise<Locator> {
  const toggle = changesToggle(page)
  await expect(toggle).toHaveAttribute('data-state', 'closed')
  await toggle.click()
  const panel = changesPanel(page)
  await expect(panel).toBeVisible()
  if (await panel.getAttribute('data-view') !== view)
    await changesViewTab(page, view).click()
  await expect(panel).toHaveAttribute('data-view', view)
  await expect(panel).toHaveAttribute('data-state', /^(?:ready|unavailable)$/)
  return panel
}

/** Expands a row of the changes panel and waits for its diff. */
async function expandChangesRow(page: Page, path: string): Promise<void> {
  const row = changesFile(page, path)
  await changesFileButton(row).click()
  await expect(changesFileDiff(row)).toHaveAttribute('data-state', 'ready')
}

/**
 * Closes the changes panel on This chat: its state is per browser, so the other screens would show it open (and on
 * the Git view) otherwise.
 */
async function closeChangesPanel(page: Page): Promise<void> {
  const panel = changesPanel(page)
  if (await panel.count() === 0)
    return
  if (await panel.getAttribute('data-view') !== 'chat')
    await changesViewTab(page, 'chat').click()
  await panel.getByTestId(testIds.changesClose).click()
  await expect(panel).toHaveCount(0)
}

/** Expands a finished workspace tool row and returns its expanded body. */
async function expandWorkspaceRow(page: Page, toolName: string): Promise<Locator> {
  const row = workspaceRow(page, toolName)
  await expect(row).toHaveAttribute('data-state', 'output-available')
  await row.getByRole('button').click()
  return row.locator('xpath=ancestor::*[@data-slot="tool-part"][1]').getByTestId(testIds.toolRowOutput)
}

/**
 * Phase 11: installs the hook-pack example (a copy, trusted: its command hook runs only while it is trusted). Pinning the
 * trust needs a fresh login, so the browser's session logs in again first.
 */
async function installHookPack(page: Page, seed: Seed): Promise<void> {
  const api = pageApi(page, seed)
  await api.client.auth.login({ body: { password: PASSWORD } })
  const plugin = await api.client.pluginInstall.install({ body: { source: 'path', path: join(REPO_ROOT, 'examples/plugins', HOOK_PLUGIN_ID), mode: 'copy', trust: true } })
  expect(plugin.state, 'hook-pack is active').toBe('active')
}

async function removeHookPack(page: Page, seed: Seed): Promise<void> {
  await pageApi(page, seed).client.plugins.remove({ params: { id: HOOK_PLUGIN_ID }, query: {} })
}

/**
 * Phase 11: the active tab of Settings -> Customize scrolled into view. With five tabs and the Project select the tab
 * list scrolls (also at 1440 px) and does not reveal the active tab by itself, which cuts the last tabs off.
 */
async function revealCustomizeTab(page: Page, tab: 'hooks' | 'output-styles'): Promise<void> {
  await byTestId(page, testIds.customizeTab, { 'data-value': tab }).evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'end' }))
}

/** Phase 11: Settings -> Customize on the Hooks tab with `hooks-demo` selected, once its sections loaded. */
async function openHooksTab(page: Page, seed: Seed): Promise<void> {
  await openSettings(page, `/settings/customize?tab=hooks&project=${seed.hooksDemo}`, async (page) => {
    await expect(byTestId(page, testIds.hooksSection, { 'data-source': 'personal' })).toHaveAttribute('data-count', '2')
    await expect(byTestId(page, testIds.hooksSection, { 'data-source': 'project' })).toHaveAttribute('data-count', '5')
    await revealCustomizeTab(page, 'hooks')
  })
}

const SCREENS: Screen[] = [
  {
    name: 'new-chat',
    open: openNewChatScreen,
  },
  {
    name: 'chat',
    open: async (page, seed) => {
      await openChat(page, seed.markdown)
      await expectMessageStatus(lastAssistantMessage(page), 'done')
    },
  },
  {
    name: 'chat-reasoning',
    open: async (page, seed) => {
      await openChat(page, seed.reasoning)
      const row = lastAssistantMessage(page).getByTestId(testIds.reasoningRow)
      await row.getByRole('button').click()
      await expect(row).toHaveAttribute('data-expanded', 'true')
    },
  },
  {
    name: 'chat-tools',
    open: async (page, seed) => {
      await openChat(page, seed.tools)
      const row = lastAssistantMessage(page).getByTestId(testIds.toolRow)
      await expect(row).toHaveAttribute('data-state', 'output-available')
      await row.click()
      await expect(lastAssistantMessage(page).getByTestId(testIds.toolRowOutput)).toBeVisible()
    },
  },
  {
    name: 'chat-approval',
    open: async (page, seed) => {
      await openChat(page, seed.approval)
      await expect(page.getByTestId(testIds.toolApproval)).toBeVisible()
    },
  },
  {
    name: 'chat-error',
    open: async (page, seed) => {
      await openChat(page, seed.error)
      await expect(page.getByTestId(testIds.chatError)).toBeVisible()
    },
  },
  {
    name: 'chat-versions',
    open: async (page, seed) => {
      await openChat(page, seed.versions)
      const userVersions = page.getByTestId(testIds.messageUser).getByTestId(testIds.messageBranch)
      await expect(userVersions).toHaveAttribute('data-count', '2')
      await expect(userVersions).toHaveAttribute('data-index', '1')
      const replyVersions = lastAssistantMessage(page).getByTestId(testIds.messageBranch)
      await expect(replyVersions).toHaveAttribute('data-count', '2')
      await expect(replyVersions).toHaveAttribute('data-index', '1')
    },
  },
  {
    name: 'chat-delete-version',
    open: async (page, seed) => {
      await openChat(page, seed.versions)
      await lastAssistantMessage(page).getByTestId(testIds.messageDeleteVersion).click()
      await expect(page.getByTestId(testIds.messageDeleteVersionConfirm)).toBeVisible()
      await expect(page.getByRole('alertdialog')).toContainText('Delete this version?')
    },
    close: async (page) => {
      // Cancel: the versions stay.
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.messageDeleteVersionConfirm)).toBeHidden()
    },
  },
  {
    name: 'chat-images',
    open: async (page, seed) => {
      await openChat(page, seed.images)
      await expectMessageStatus(lastAssistantMessage(page), 'done')
      const gallery = lastAssistantMessage(page).getByTestId(testIds.imageGallery)
      await expect(gallery).toHaveAttribute('data-count', '2')
      for (const image of await gallery.getByRole('img').all())
        await naturalSize(image)
      await expectTranscriptAtBottom(page)
    },
  },
  {
    name: 'chat-images-generating',
    open: async (page, seed) => {
      // The caption counts from the server's start time: the page clock (2 minutes ahead for the relative times of the
      // other screens) runs at the real time here, and `close` puts the offset back.
      clockOffsetMs = await page.evaluate<number>('Date.now()') - Date.now()
      await page.clock.setSystemTime(Date.now())
      // A chat of its own with the image model: a "slow" prompt keeps the placeholders up for 5 s.
      generatingChatId = (await pageApi(page, seed).createChat({ title: 'Logo sketches', modelRef: 'mock:image' })).id
      await page.goto(`/chat/${generatingChatId}`)
      await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', 'mock:image')
      const options = composer(page).getByTestId(testIds.imageOptionsTrigger)
      await options.click()
      await byTestId(page, testIds.imageAspectOption, { 'data-value': '16:9' }).click()
      await expect(options).toHaveAccessibleName('Image options: 16:9, 1 image')
      await options.click()
      await byTestId(page, testIds.imageCountOption, { 'data-value': '2' }).click()
      await expect(options).toHaveAccessibleName('Image options: 16:9, 2 images')
      await sendMessage(page, 'A slow sketch of a forge logo, flat vector, ember orange')
      await expect(lastAssistantMessage(page).getByTestId(testIds.imageGenerating)).toHaveAttribute('data-count', '2')
    },
    close: async (page, seed) => {
      if (generatingChatId)
        await pageApi(page, seed).removeChat(generatingChatId)
      generatingChatId = null
      await page.clock.setSystemTime(Date.now() + clockOffsetMs)
    },
  },
  {
    name: 'composer-recording',
    open: async (page, seed) => {
      await openChat(page, seed.markdown)
      const mic = composer(page).getByTestId(testIds.composerMic)
      await mic.click()
      await expect(mic).toHaveAttribute('data-state', 'recording')
      await expect(composer(page).getByTestId(testIds.composerRecordingTime)).toHaveText('0:02', { timeout: 10_000 })
    },
    close: async (page) => {
      await composer(page).getByTestId(testIds.composerMicCancel).click()
      await expect(composer(page).getByTestId(testIds.composerMic)).toHaveAttribute('data-state', 'idle')
    },
  },
  {
    name: 'project-switcher',
    open: async (page) => {
      await openNewChatScreen(page)
      if (isPhone(page))
        await page.getByTestId(testIds.sidebarTrigger).click()
      await page.getByTestId(testIds.projectSwitcher).click()
      await expect(page.getByTestId(testIds.projectSwitcherOption)).toHaveCount(5)
      await expect(page.getByTestId(testIds.projectManage)).toBeVisible()
    },
  },
  {
    name: 'new-chat-project',
    open: async (page) => {
      await openNewChatScreen(page)
      await page.getByTestId(testIds.newChatProject).click()
      await expect(page.getByTestId(testIds.projectOption)).toHaveCount(4)
    },
  },
  {
    name: 'add-project',
    open: async (page, seed) => {
      await page.goto('/settings/projects?add=1')
      const dialog = page.getByTestId(testIds.addProjectDialog)
      await expect(dialog).toBeVisible()
      const browser = dialog.getByTestId(testIds.folderBrowser)
      await byTestId(browser, testIds.folderBrowserEntry, { 'data-path': seed.workspaceRoot }).click()
      await expect(browser).toHaveAttribute('data-path', seed.workspaceRoot)
      await byTestId(browser, testIds.folderBrowserEntry, { 'data-path': join(seed.workspaceRoot, 'playground') }).click()
      await expect(browser).toHaveAttribute('data-state', 'ready')
      await expect(dialog.getByTestId(testIds.addProjectName)).toHaveValue('playground')
    },
  },
  {
    name: 'settings-projects',
    open: page => openSettings(page, '/settings/projects', async (page) => {
      await expect(page.getByTestId(testIds.projectRow)).toHaveCount(3)
    }),
  },
  {
    name: 'settings-projects-allowlist',
    open: async (page, seed) => {
      await openSettings(page, '/settings/projects', async (page) => {
        const row = byTestId(page, testIds.projectRow, { 'data-project-id': seed.project })
        await expect(row).toContainText('3 allowed commands')
        await row.getByTestId(testIds.projectRowMenu).click()
        await page.getByTestId(testIds.projectAllowlist).click()
        await expect(page.getByTestId(testIds.allowlistDialog).getByTestId(testIds.allowlistRule)).toHaveCount(3)
      })
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.allowlistDialog)).toBeHidden()
    },
  },
  {
    name: 'project-trust-dialog',
    open: async (page, seed) => {
      // From the chat header's chip: 4 items wait (two hooks, an MCP server, a command), one of them changed.
      await openChat(page, seed.hookNotes)
      const chip = page.getByTestId(testIds.projectTrustChip)
      await expect(chip).toHaveAttribute('data-count', '4')
      await chip.click()
      const dialog = page.getByTestId(testIds.projectTrustDialog)
      await expect(dialog.getByTestId(testIds.projectTrustGroup)).toHaveCount(3)
      await expect(trustItem(dialog, { 'data-state': 'changed' })).toHaveCount(1)
      await expect(dialog.getByTestId(testIds.projectTrustFilter)).toHaveAttribute('data-value', 'pending')
      // One item selected ("1 selected", "Approve 1 item"); `close` never approves it.
      await trustItem(dialog, { 'data-kind': 'hook', 'data-state': 'new' }).getByTestId(testIds.projectTrustSelect).click()
      await expect(dialog.getByTestId(testIds.projectTrustApprove)).toHaveAttribute('data-count', '1')
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.projectTrustDialog)).toHaveCount(0)
    },
  },
  {
    name: 'project-mcp-dialog',
    open: async (page, seed) => {
      // The approved stdio server stops after 10 idle minutes: start it again for the picture.
      const docs = await pageApi(page, seed).client.projectMcp.reconnect({ params: { id: seed.hooksDemo, serverId: 'docs' } })
      expect(docs.state, 'the docs server connected').toBe('connected')
      await openSettings(page, '/settings/projects', async (page) => {
        const row = byTestId(page, testIds.projectRow, { 'data-project-id': seed.hooksDemo })
        await row.getByTestId(testIds.projectRowMenu).click()
        await page.getByRole('menu').getByTestId(testIds.projectMcp).click()
      })
      const dialog = page.getByTestId(testIds.projectMcpDialog)
      await expect(byTestId(dialog, testIds.projectMcpServer, { 'data-server-id': 'docs' })).toHaveAttribute('data-state', 'connected')
      await expect(byTestId(dialog, testIds.projectMcpServer, { 'data-server-id': 'github' })).toHaveAttribute('data-state', 'pending')
      await expect(dialog.getByTestId(testIds.projectMcpVariables)).toHaveAttribute('data-count', '3')
      // On the desktop the connected server shows its tools too.
      if (!isPhone(page)) {
        await byTestId(dialog, testIds.projectMcpServer, { 'data-server-id': 'docs' }).locator('[data-action="toggle"]').click()
        await expect(dialog.locator('[data-slot="project-mcp-tools"]')).toBeVisible()
      }
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.projectMcpDialog)).toHaveCount(0)
    },
  },
  {
    name: 'chat-edit-approval',
    open: async (page, seed) => {
      await openChat(page, seed.editApproval)
      const card = byTestId(page, testIds.toolApproval, { 'data-tool-name': 'edit_file' })
      await expect(card.getByTestId(testIds.diffView)).toBeVisible()
      await expectTranscriptAtBottom(page)
    },
  },
  {
    name: 'chat-shell-approval',
    open: async (page, seed) => {
      await openChat(page, seed.shellApproval)
      await expect(byTestId(page, testIds.toolApproval, { 'data-tool-name': 'shell' })).toContainText('Run this command?')
      await expectTranscriptAtBottom(page)
    },
  },
  {
    name: 'chat-diff',
    open: async (page, seed) => {
      await openChat(page, seed.workspace)
      const diff = (await expandWorkspaceRow(page, 'edit_file')).getByTestId(testIds.diffView)
      await expect(diff).toBeVisible()
      await diff.scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'chat-terminal',
    open: async (page, seed) => {
      await openChat(page, seed.workspace)
      const terminal = (await expandWorkspaceRow(page, 'shell')).getByTestId(testIds.terminalOutput)
      await expect(terminal).toHaveAttribute('data-status', 'ok')
      await terminal.scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'chat-changes-panel',
    only: 'desktop',
    open: async (page, seed) => {
      await openChat(page, seed.changes)
      const panel = await openChangesPanel(page, 'chat')
      await expandChangesRow(page, MOCK_CHECKPOINT_FILE)
      await expect(panel.locator('[data-slot="changes-untracked"]')).toBeVisible()
    },
    close: closeChangesPanel,
  },
  {
    name: 'chat-changes-git',
    only: 'desktop',
    open: async (page, seed) => {
      await openChat(page, seed.changes)
      const panel = await openChangesPanel(page, 'git')
      // Without git on the host the view explains that the folder is not a repository.
      if (await gitAvailable()) {
        await expect(panel.getByTestId(testIds.changesFile)).toHaveCount(3)
        await expandChangesRow(page, MOCK_CHECKPOINT_FILE)
      }
    },
    close: closeChangesPanel,
  },
  {
    name: 'chat-changes-sheet',
    only: 'mobile',
    open: async (page, seed) => {
      await openChat(page, seed.changes)
      await openChangesPanel(page, 'chat')
      await expandChangesRow(page, MOCK_CHECKPOINT_FILE)
    },
    close: closeChangesPanel,
  },
  {
    name: 'chat-revert-confirm',
    open: async (page, seed) => {
      await openChat(page, seed.changes)
      await openChangesPanel(page, 'chat')
      const row = changesFile(page, MOCK_CHECKPOINT_FILE)
      await row.hover()
      await byTestId(row, testIds.changesFileRevert, { 'data-path': MOCK_CHECKPOINT_FILE }).click()
      await expect(page.getByRole('alertdialog')).toContainText(`Revert ${MOCK_CHECKPOINT_FILE}?`)
    },
    close: async (page) => {
      // Cancel: the file stays.
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.changesRevertConfirm)).toBeHidden()
      await closeChangesPanel(page)
    },
  },
  {
    name: 'chat-rewind-dialog',
    open: async (page, seed) => {
      await openChat(page, seed.changes)
      const dialog = await openRewind(page, userMessages(page).first())
      await expect(dialog).toHaveAttribute('data-state', 'ready')
      await expect(dialog.getByTestId(testIds.rewindShellCommand)).toHaveCount(3)
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.rewindDialog)).toBeHidden()
    },
  },
  {
    name: 'chat-shell-approval-rule',
    open: async (page, seed) => {
      await openChat(page, seed.ruleApproval)
      const card = byTestId(page, testIds.toolApproval, { 'data-tool-name': 'shell' })
      await card.getByTestId(testIds.toolApprovalAllowRule).click()
      await expect(card.getByTestId(testIds.toolApprovalRulePrefix)).toHaveValue('pnpm build')
      await expectTranscriptAtBottom(page)
    },
  },
  {
    name: 'chat-terminal-cwd',
    open: async (page, seed) => {
      await openChat(page, seed.terminalCwd)
      await expect(lastAssistantMessage(page)).toContainText(MOCK_CHECKPOINT_DONE)
      const rows = byTestId(lastAssistantMessage(page), testIds.toolRow, { 'data-tool-name': 'shell' })
      await expect(rows).toHaveCount(2)
      for (const index of [0, 1]) {
        await expect(rows.nth(index).getByTestId(testIds.toolRowRule)).toBeVisible()
        await rows.nth(index).getByRole('button').first().click()
      }
      const terminal = rows.nth(1).locator('xpath=ancestor::*[@data-slot="tool-part"][1]').getByTestId(testIds.terminalOutput)
      await expect(terminal.getByTestId(testIds.terminalCwd)).toHaveAttribute('data-value', MOCK_CHECKPOINT_DIR)
      await terminal.scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'chat-plan-approval',
    open: async (page, seed) => {
      await openChat(page, seed.plan)
      const card = page.getByTestId(testIds.planApproval)
      await expect(card).toHaveAttribute('data-state', 'pending')
      await expect(page.getByTestId(testIds.todoStrip)).toHaveAttribute('data-value', '0')
      await card.scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'chat-todo-strip',
    open: async (page, seed) => {
      await page.evaluate(`localStorage.setItem('hf-todo-expanded', '1')`)
      await openChat(page, seed.todos)
      const strip = page.getByTestId(testIds.todoStrip)
      await expect(strip).toHaveAttribute('data-state', 'open')
      await expect(strip).toHaveAttribute('data-value', '1')
      await expect(strip.getByTestId(testIds.todoItem)).toHaveCount(3)
    },
    close: async (page) => {
      await page.evaluate(`localStorage.setItem('hf-todo-expanded', '0')`)
    },
  },
  {
    name: 'chat-subagents',
    only: 'desktop',
    open: async (page, seed) => {
      await openChat(page, seed.subagents)
      const block = byTestId(page, testIds.taskBlock, { 'data-kind': 'explore' })
      await expect(block).toHaveAttribute('data-state', 'completed')
      await block.getByTestId(testIds.taskBlockTrigger).click()
      await expect(block.getByTestId(testIds.taskReport)).toBeVisible()
      await lastAssistantMessage(page).scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'chat-compacted',
    only: 'desktop',
    open: async (page, seed) => {
      await openChat(page, seed.compacted)
      const divider = lastAssistantMessage(page).getByTestId(testIds.compactionDivider)
      await divider.getByTestId(testIds.compactionToggle).click()
      await expect(divider.getByTestId(testIds.compactionSummary)).toBeVisible()
      await expectTranscriptAtBottom(page)
    },
  },
  {
    name: 'chat-steer',
    open: async (page, seed) => {
      // A live run of its own: `steps 20` (8 s), a steer once the first step ran, then a server command that waits.
      steerChatId = (await pageApi(page, seed).createChat({ title: 'Run the parser tests', modelRef: 'mock:steer' })).id
      await page.goto(`/chat/${steerChatId}`)
      await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', 'mock:steer')
      await sendMessage(page, 'steps 20')
      await waitForTestId(page, testIds.toolRow, { 'data-tool-name': 'current_time' })
      const input = page.getByTestId(testIds.composerInput)
      await input.fill('Use the vitest filter instead')
      await page.getByTestId(testIds.composerQueue).click()
      await expect(lastAssistantMessage(page).getByTestId(testIds.steerNote)).toBeVisible()
      // The streamed line catches up a little later under the page clock.
      await expect(lastAssistantMessage(page)).toContainText('Steered: Use the vitest filter instead.')
      await input.fill('/compact keep the test names')
      await page.getByTestId(testIds.composerQueue).click()
      await expect(page.getByTestId(testIds.queuedMessages)).toHaveAttribute('data-count', '1')
      await input.fill('Also update the README')
    },
    close: async (page, seed) => {
      if (steerChatId)
        await pageApi(page, seed).removeChat(steerChatId)
      steerChatId = null
    },
  },
  {
    name: 'composer-mention',
    open: async (page, seed) => {
      await openChat(page, seed.subagents)
      await page.getByTestId(testIds.composerInput).click()
      await page.keyboard.type('Update @re')
      const menu = page.getByTestId(testIds.mentionMenu)
      await expect(menu).toHaveAttribute('data-state', 'ready')
      await expect(menu.getByTestId(testIds.mentionMenuItem).first()).toBeVisible()
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await page.getByTestId(testIds.composerInput).fill('')
    },
  },
  {
    name: 'composer-slash-groups',
    only: 'desktop',
    open: async (page, seed) => {
      await openChat(page, seed.customAgent)
      await page.getByTestId(testIds.composerInput).click()
      await page.keyboard.type('/')
      const menu = page.getByTestId(testIds.slashMenu)
      await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': 'review', 'data-group': 'project' })).toBeVisible()
      await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': 'standup', 'data-group': 'personal' })).toBeAttached()
      // The App group fills the first rows: scroll the Project heading to the top, so Project, Personal and Plugins show.
      await menu.locator('[data-group="project"]:not([data-testid])').evaluate(element => element.scrollIntoView({ block: 'start' }))
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await page.getByTestId(testIds.composerInput).fill('')
    },
  },
  {
    name: 'composer-output-style',
    open: async (page, seed) => {
      // `hooks-demo` uses Learning; the chat follows it (Automatic).
      await openChat(page, seed.hookContinuation)
      const trigger = composer(page).getByTestId(testIds.outputStyleTrigger)
      await expect(trigger).toHaveAttribute('data-value', 'learning')
      await trigger.click()
      await expect(byTestId(page, testIds.outputStyleOption, { 'data-value': '' })).toHaveAttribute('data-state', 'checked')
      await expect(byTestId(page, testIds.outputStyleOption, { 'data-value': 'terse' })).toBeVisible()
      await expect(byTestId(page, testIds.outputStyleOption, { 'data-value': 'release-notes' })).toBeVisible()
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.outputStyleOption)).toHaveCount(0)
    },
  },
  {
    name: 'composer-refusal',
    open: async (page, seed) => {
      // The project's UserPromptSubmit hook refuses every message: the text stays in the composer, nothing is stored.
      await openChat(page, seed.hookNotes)
      await sendMessage(page, 'Here is the staging key sk-demo-0000, deploy with it.')
      const refusal = page.getByTestId(testIds.composerRefusal)
      await expect(refusal).toHaveAttribute('data-code', 'hook-blocked')
      await expect(refusal).toContainText('Don\'t paste API keys into the chat.')
      await expect(page.getByTestId(testIds.composerInput)).toHaveValue(/sk-demo-0000/)
    },
    close: async (page) => {
      await page.getByTestId(testIds.composerRefusalDismiss).click()
      await expect(page.getByTestId(testIds.composerRefusal)).toHaveCount(0)
      await page.getByTestId(testIds.composerInput).fill('')
    },
  },
  {
    name: 'chat-background-agents',
    open: async (page, seed) => {
      // Two agents that run until they are stopped, on the chat's model (`mock:background`); the durations count from the
      // server's start times, so the page clock runs at the real time here (`close` puts the offset back).
      const api = pageApi(page, seed)
      await api.updateSettings({ subagentModelRef: null })
      clockOffsetMs = await page.evaluate<number>('Date.now()') - Date.now()
      await page.clock.setSystemTime(Date.now())
      backgroundChatId = (await api.createChat({ title: 'Check the flaky tests', modelRef: 'mock:background' })).id
      await api.sendChat({ chatId: backgroundChatId, modelRef: 'mock:background', toolMode: 'ask', text: 'bg explore loop' })
      await api.sendChat({ chatId: backgroundChatId, modelRef: 'mock:background', toolMode: 'ask', text: 'bg general loop' })
      await openChat(page, backgroundChatId)
      const dock = page.getByTestId(testIds.backgroundAgents)
      await expect(dock).toHaveAttribute('data-count', '2')
      await expect(byTestId(page, testIds.taskBlock, { 'data-background': 'true', 'data-state': 'running' })).toHaveCount(2)
      if (!isPhone(page))
        await expect(dock.locator('[data-slot="background-agent-live"]').first()).toContainText('current_time')
    },
    close: async (page, seed) => {
      if (backgroundChatId)
        await pageApi(page, seed).removeChat(backgroundChatId)
      backgroundChatId = null
      await pageApi(page, seed).updateSettings({ subagentModelRef: 'mock:subagent' })
      await page.clock.setSystemTime(Date.now() + clockOffsetMs)
    },
  },
  {
    name: 'chat-task-result',
    only: 'desktop',
    open: async (page, seed) => {
      await openChat(page, seed.taskResult)
      const note = byTestId(page, testIds.taskResult, { 'data-variant': 'turn' })
      await expect(note).toHaveAttribute('data-status', 'completed')
      await note.getByTestId(testIds.taskResultToggle).click()
      await expect(note.getByTestId(testIds.taskResultReport)).toBeVisible()
      await expectTranscriptAtBottom(page)
    },
  },
  {
    name: 'chat-hook-notes',
    only: 'desktop',
    open: async (page, seed) => {
      await openChat(page, seed.hookNotes)
      const reply = lastAssistantMessage(page)
      await expectMessageStatus(reply)
      await expect(hookNote(page, { 'data-event': 'SessionStart', 'data-outcome': 'context' })).toBeVisible()
      await expect(hookNote(reply, { 'data-event': 'Stop', 'data-outcome': 'error' })).toBeVisible()
      const row = byTestId(reply, testIds.toolRow, { 'data-tool-name': 'shell' })
      await expect(row.getByTestId(testIds.toolRowHook)).toHaveAttribute('data-value', 'denied')
      await row.getByRole('button').first().click()
      const blocked = hookNote(reply, { 'data-variant': 'tool', 'data-outcome': 'denied' })
      await expect(blocked).toBeVisible()
      await blocked.getByTestId(testIds.hookNoteToggle).click()
      await expect(blocked.getByTestId(testIds.hookNoteDetails)).toBeVisible()
      await expectTranscriptAtBottom(page)
    },
  },
  {
    name: 'chat-hook-continuation',
    only: 'desktop',
    open: async (page, seed) => {
      await openChat(page, seed.hookContinuation)
      await expect(hookNote(page, { 'data-variant': 'turn', 'data-outcome': 'continued' })).toBeVisible()
      await expect(lastAssistantMessage(page)).toContainText('Hook continuation: Run the parser tests')
      await expectTranscriptAtBottom(page)
    },
  },
  {
    name: 'remember-dialog',
    open: async (page, seed) => {
      await openChat(page, seed.customAgent)
      const input = page.getByTestId(testIds.composerInput)
      await input.fill('/remember Run pnpm check before every commit.')
      await input.press('Enter')
      const dialog = page.getByTestId(testIds.rememberDialog)
      await expect(dialog).toBeVisible()
      await expect(byTestId(dialog, testIds.rememberTarget, { 'data-value': 'project-file' })).toHaveAttribute('data-state', 'checked')
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.rememberDialog)).toHaveCount(0)
    },
  },
  {
    name: 'share-dialog',
    open: async (page, seed) => {
      await openChat(page, seed.shared)
      await page.getByTestId(testIds.chatMenuTrigger).click()
      await page.getByTestId(testIds.chatMenuShare).click()
      const dialog = page.getByTestId(testIds.shareDialog)
      await expect(dialog).toBeVisible()
      await expect(dialog.getByTestId(testIds.shareLink)).toHaveAttribute('data-outdated', 'true')
      await expect(dialog.getByTestId(testIds.shareCopy)).toBeFocused()
    },
  },
  {
    name: 'share-page',
    open: async (page, seed) => {
      await page.goto(seed.sharePath)
      await expect(page.getByTestId(testIds.sharePage)).toHaveAttribute('data-state', 'ready')
      await expect(page.getByTestId(testIds.shareToolRow)).toHaveAttribute('data-status', 'done')
    },
  },
  {
    name: 'share-unavailable',
    open: async (page) => {
      await page.goto('/share/revoked-or-expired-link')
      await expect(page.getByTestId(testIds.sharePage)).toHaveAttribute('data-state', 'unavailable')
      await expect(page.getByTestId(testIds.shareUnavailable)).toBeVisible()
    },
  },
  {
    name: 'model-picker',
    open: async (page) => {
      await openNewChatScreen(page)
      await composer(page).getByTestId(testIds.modelPickerTrigger).click()
      await expect(byTestId(page, testIds.modelPickerItem, { 'data-model-ref': 'mock:reasoning' }).first()).toBeVisible()
    },
  },
  {
    name: 'command-palette',
    open: async (page) => {
      await openNewChatScreen(page)
      await pressShortcut(page, 'Mod+K')
      await expect(page.getByTestId(testIds.commandPaletteItem).first()).toBeVisible()
    },
  },
  {
    name: 'shortcuts',
    only: 'desktop',
    open: async (page) => {
      await openNewChatScreen(page)
      await pressShortcut(page, 'Mod+/')
      await expect(page.getByTestId(testIds.shortcutsDialog)).toBeVisible()
    },
  },
  {
    name: 'sidebar',
    only: 'mobile',
    open: async (page, seed) => {
      await openChat(page, seed.markdown)
      await page.getByTestId(testIds.sidebarTrigger).click()
      await expect(page.getByTestId(testIds.chatList)).toBeVisible()
    },
  },
  {
    name: 'plugins',
    open: async (page) => {
      await page.goto('/plugins')
      await expect(byTestId(page, testIds.pluginCard, { 'data-plugin-id': 'core-tools' })).toBeVisible()
    },
  },
  {
    name: 'plugin-detail',
    open: async (page) => {
      await page.goto('/plugins/core-tools')
      await expect(page.getByTestId(testIds.pluginToolRow).first()).toBeVisible()
    },
  },
  {
    name: 'plugin-mcp',
    open: async (page) => {
      await page.goto('/plugins/core-mcp')
      await expect(page.getByTestId(testIds.mcpPanel)).toBeVisible()
    },
  },
  {
    name: 'plugin-detail-agents',
    only: 'desktop',
    open: async (page, seed) => {
      // A plugin of its own (removed in `close`): two agents, one of them shadowed by the personal `code-reviewer`.
      await pageApi(page, seed).client.pluginDrafts.create({
        body: {
          manifest: {
            manifestVersion: 1,
            id: AGENT_PLUGIN_ID,
            name: 'Database tools',
            version: '1.2.0',
            description: 'Sub-agents and skills for SQL work: a migration planner, a reviewer and a checklist.',
            engines: { harness: '^1.4.0' },
            contributes: {
              agents: [
                { name: 'sql-expert', description: 'Plans SQL migrations and checks them for locking problems.', instructions: 'Plan the migration step by step.', tools: ['read_file', 'search_files', 'find_files'], model: 'mock:agents' },
                { name: 'code-reviewer', description: 'Reviews SQL in a diff.', instructions: 'Review the SQL.' },
              ],
              skills: [{ name: 'migration-checklist', description: 'What to check before a schema migration ships.', content: '# Migration checklist\n\n- Backfill first.\n' }],
            },
          } as never,
        },
      })
      await page.goto(`/plugins/${AGENT_PLUGIN_ID}`)
      const agents = byTestId(page, testIds.pluginCustomizations, { 'data-kind': 'agent' })
      await expect(byTestId(agents, testIds.pluginCustomization, { 'data-name': 'code-reviewer' })).toHaveAttribute('data-state', 'shadowed')
      await expect(byTestId(page, testIds.pluginCustomizations, { 'data-kind': 'skill' })).toHaveAttribute('data-count', '1')
      await agents.scrollIntoViewIfNeeded()
    },
    close: async (page, seed) => {
      await pageApi(page, seed).client.plugins.remove({ params: { id: AGENT_PLUGIN_ID }, query: {} })
    },
  },
  {
    name: 'plugin-detail-hooks',
    only: 'desktop',
    open: async (page, seed) => {
      await installHookPack(page, seed)
      await page.goto(`/plugins/${HOOK_PLUGIN_ID}`)
      const hooks = page.getByTestId(testIds.pluginHooks)
      await expect(hooks).toHaveAttribute('data-count', '1')
      await expect(byTestId(page, testIds.pluginCustomizations, { 'data-kind': 'style' })).toBeVisible()
      await hooks.scrollIntoViewIfNeeded()
    },
    close: removeHookPack,
  },
  {
    name: 'plugin-new-provider',
    open: async (page) => {
      await page.goto('/plugins/new?type=provider')
      await expect(page.getByTestId(testIds.wizard)).toBeVisible()
    },
  },
  {
    name: 'plugin-new-code',
    open: async (page) => {
      await page.goto('/plugins/new?type=code')
      await expect(page.getByTestId(testIds.codePluginForm)).toBeVisible()
    },
  },
  {
    name: 'settings-providers',
    open: page => openSettings(page, '/settings/providers', async (page) => {
      await expect(byTestId(page, testIds.providerRow, { 'data-provider-id': 'mock' })).toBeVisible()
    }),
  },
  {
    name: 'settings-provider-key',
    open: page => openSettings(page, '/settings/providers?configure=openai', async (page) => {
      await expect(byTestId(page, testIds.keyDialog, { 'data-provider-id': 'openai' })).toBeVisible()
    }),
  },
  {
    name: 'settings-models',
    open: page => openSettings(page, '/settings/models', async (page) => {
      await expect(byTestId(page, testIds.modelRow, { 'data-model-ref': 'mock:echo' })).toBeVisible()
    }),
  },
  {
    name: 'settings-media',
    open: async (page, seed) => {
      await pageApi(page, seed).updateSettings(SPEECH_SETTINGS)
      await openSettings(page, '/settings/media', async (page) => {
        await expect(page.getByTestId(testIds.settingsImageModel)).toHaveAttribute('data-value', 'mock:image')
        await expect(page.getByTestId(testIds.settingsTranscriptionModel)).toHaveAttribute('data-value', 'mock:transcribe')
        await expect(page.getByTestId(testIds.settingsSpeechModel)).toHaveAttribute('data-value', 'mock:speech')
        await expect(page.getByTestId(testIds.settingsSpeechVoice)).toHaveValue('mock-voice-a')
        await expect(page.getByTestId(testIds.settingsSpeechSpeed)).toHaveAttribute('data-value', '1.25')
      })
    },
    close: async (page, seed) => {
      await pageApi(page, seed).updateSettings(NO_SPEECH_SETTINGS)
    },
  },
  {
    name: 'settings-general',
    open: page => openSettings(page, '/settings/general', async (page) => {
      await expect(page.getByTestId(testIds.settingsDisplayName)).toHaveValue('Alex')
    }),
  },
  {
    name: 'settings-general-agent',
    only: 'desktop',
    open: page => openSettings(page, '/settings/general', async (page) => {
      await expect(page.getByTestId(testIds.settingsSubagentModel)).toHaveAttribute('data-value', 'mock:subagent')
      await expect(page.getByTestId(testIds.settingsCompactionModel)).toHaveAttribute('data-value', 'mock:compact')
      await page.getByText('Long chats, sub-agents, plans and hooks.').evaluate(element => element.scrollIntoView({ block: 'center' }))
    }),
  },
  {
    name: 'settings-customize',
    open: (page, seed) => openSettings(page, `/settings/customize?tab=agents&project=${seed.notes}`, async (page) => {
      await expect(byTestId(page, testIds.customizeSection, { 'data-source': 'project' })).toHaveAttribute('data-count', '3')
      await expect(byTestId(page, testIds.customizationRow, { 'data-source': 'user', 'data-name': 'test-writer' })).toHaveAttribute('data-state', 'shadowed')
      await expect(byTestId(page, testIds.customizationRow, { 'data-source': 'project', 'data-name': 'broken' })).toHaveAttribute('data-state', 'invalid')
    }),
  },
  {
    name: 'customization-editor',
    open: async (page, seed) => {
      await openSettings(page, `/settings/customize?tab=agents&project=${seed.notes}`, async (page) => {
        await expect(byTestId(page, testIds.customizationRow, { 'data-source': 'user', 'data-name': 'code-reviewer' })).toBeVisible()
      })
      await byTestId(page, testIds.customizationRow, { 'data-source': 'user', 'data-name': 'code-reviewer' }).getByTestId(testIds.customizationRowMenu).click()
      await page.getByTestId(testIds.customizationEdit).click()
      const editor = page.getByTestId(testIds.customizationEditor)
      await expect(editor).toHaveAttribute('data-mode', 'edit')
      await expect(editor.getByTestId(testIds.customizationBody)).toHaveAttribute('data-ready', 'true')
      await expect(byTestId(editor, testIds.customizationToolChip, { 'data-tool-name': 'read_file' })).toBeVisible()
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.customizationEditor)).toHaveCount(0)
    },
  },
  {
    name: 'settings-customize-hooks',
    open: async (page, seed) => {
      // With the hook-pack plugin for the "From plugins" section (removed in `close`).
      await installHookPack(page, seed)
      await openHooksTab(page, seed)
      await expect(byTestId(page, testIds.hooksSection, { 'data-source': 'plugin' })).toHaveAttribute('data-count', '1')
      await expect(page.getByTestId(testIds.customizeTrustReview)).toHaveAttribute('data-count', '2')
    },
    close: removeHookPack,
  },
  {
    name: 'hook-editor',
    open: async (page, seed) => {
      await openHooksTab(page, seed)
      const row = byTestId(page, testIds.hookRow, { 'data-source': 'personal', 'data-event': 'PreToolUse' })
      await row.getByTestId(testIds.hookRowMenu).click()
      await page.getByRole('menu').getByTestId(testIds.hookEdit).click()
      const editor = page.getByTestId(testIds.hookEditor)
      await expect(editor).toHaveAttribute('data-mode', 'edit')
      await expect(editor.getByTestId(testIds.hookMatcherPreview)).toContainText('Matches')
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.hookEditor)).toHaveCount(0)
    },
  },
  {
    name: 'hook-import',
    only: 'desktop',
    open: async (page, seed) => {
      await openHooksTab(page, seed)
      await page.getByTestId(testIds.customizeImport).click()
      const dialog = page.getByTestId(testIds.hookImportDialog)
      await expect(dialog).toBeVisible()
      const input = dialog.getByTestId(testIds.hookImportInput)
      await input.fill(HOOK_IMPORT_JSON)
      await expect(dialog.getByTestId(testIds.hookImportPreview)).toHaveAttribute('data-count', '3')
      await expect(byTestId(dialog, testIds.hookImportItem, { 'data-state': 'invalid' })).toHaveCount(1)
      await expect(dialog.getByTestId(testIds.hookImportSubmit)).toHaveAttribute('data-count', '2')
      // The pasted text from its start, without the focus ring.
      await input.evaluate((element) => {
        element.scrollTop = 0
      })
      await input.blur()
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.hookImportDialog)).toHaveCount(0)
    },
  },
  // ---------- Phase 12 ----------
  {
    name: 'plugins-marketplaces',
    open: async (page, seed) => {
      await page.goto(`/plugins/marketplaces?m=${seed.marketplace}`)
      const view = page.getByTestId(testIds.marketplacesPage)
      await expect(marketplaceEntry(view, 'review-kit')).toBeVisible()
      await expect(view.getByTestId(testIds.marketplaceEntry)).toHaveCount(MARKETPLACE_PLUGINS.length + 2)
      await expect(view.locator('[data-slot="marketplace-skeleton"]')).toHaveCount(0)
    },
  },
  {
    name: 'install-github',
    only: 'desktop',
    open: async (page) => {
      await page.goto('/plugins')
      await page.getByTestId(testIds.pageHeader).getByTestId(testIds.pluginsInstall).click()
      const dialog = page.getByTestId(testIds.installDialog)
      await expect(dialog).toHaveAttribute('data-step', 'source')
      await dialog.getByTestId(testIds.installTabGithub).click()
      await dialog.getByTestId(testIds.installGithubRepo).fill('acme/review-kit')
      await dialog.getByTestId(testIds.installGithubRef).fill('v1.2.0')
      await dialog.getByTestId(testIds.installGithubRef).blur()
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.installDialog)).toHaveCount(0)
    },
  },
  {
    name: 'install-claude-preview',
    open: async (page) => {
      await page.goto('/plugins')
      await page.getByTestId(testIds.pageHeader).getByTestId(testIds.pluginsInstall).click()
      const dialog = page.getByTestId(testIds.installDialog)
      await expect(dialog).toHaveAttribute('data-step', 'source')
      const zip = zipTree(claudeKitTree('review-kit', '1.2.0'), { folder: 'review-kit' })
      await dialog.getByTestId(testIds.installZipInput).setInputFiles({ name: 'review-kit-1.2.0.zip', mimeType: 'application/zip', buffer: zip })
      await dialog.getByTestId(testIds.installInspect).click()
      await expect(byTestId(dialog, testIds.installPreview, { 'data-format': 'claude' })).toBeVisible()
      await expect(dialog.getByTestId(testIds.trustWarning)).toBeVisible()
    },
    close: async (page) => {
      // Nothing is installed: the dialog is closed on its review.
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.installDialog)).toHaveCount(0)
    },
  },
  {
    name: 'claude-import-preview',
    open: async (page, seed) => {
      const dialog = await openClaudeImport(page)
      await chooseClaudeFolder(dialog, seed.claudeHome)
      const preview = await continueToPreview(dialog)
      await expect(byTestId(preview, testIds.claudeImportGroup, { 'data-kind': 'agent' })).toBeVisible()
      await dialog.locator('[data-slot="claude-import-step"]').focus()
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click()
      await expect(page.getByTestId(testIds.claudeImportDialog)).toHaveCount(0)
    },
  },
  {
    name: 'project-file-editor',
    open: async (page, seed) => {
      await openSettings(page, `/settings/customize?tab=agents&project=${seed.notes}`, async (page) => {
        await expect(projectRow(page, 'agent', 'test-writer').first()).toBeVisible()
      })
      const row = byTestId(page, testIds.customizationRow, { 'data-source': 'project', 'data-name': 'test-writer', 'data-path': '.harness/agents/test-writer.md' })
      await openProjectFileEditor(page, row, '.harness/agents/test-writer.md', 'Write focused tests first.')
      await page.getByTestId(testIds.projectFileContent).locator('.cm-content').blur()
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.projectFileEditor)).toHaveCount(0)
    },
  },
  {
    name: 'hook-editor-prompt',
    only: 'desktop',
    open: async (page, seed) => {
      await openHooksTab(page, seed)
      await page.getByTestId(testIds.customizeNew).click()
      const editor = page.getByTestId(testIds.hookEditor)
      await expect(editor).toHaveAttribute('data-mode', 'new')
      await editor.getByTestId(testIds.hookType).locator('[data-value="prompt"]').click()
      await editor.getByTestId(testIds.hookMatcher).fill('WebFetch')
      await editor.getByTestId(testIds.hookPrompt).fill('Refuse fetches of internal hosts (*.corp, 10.x, localhost). The call: $ARGUMENTS')
      await editor.locator('[data-field="hook-continue-on-block"]').click()
      await expect(editor.getByTestId(testIds.hookMatcherPreview)).toContainText('Matches')
      await editor.getByTestId(testIds.hookPrompt).blur()
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await page.getByTestId(testIds.hookDiscardConfirm).click()
      await expect(page.getByTestId(testIds.hookEditor)).toHaveCount(0)
    },
  },
  {
    name: 'trust-select-partial',
    open: async (page, seed) => {
      // The trust dialog of `hooks-demo`: one of the two new / changed hooks selected, so their Select all is mixed.
      await openChat(page, seed.hookNotes)
      await page.getByTestId(testIds.projectTrustChip).click()
      const dialog = page.getByTestId(testIds.projectTrustDialog)
      const hooks = byTestId(dialog, testIds.projectTrustGroup, { 'data-kind': 'hook' })
      await expect(hooks).toHaveAttribute('data-count', '2')
      await trustItem(hooks, { 'data-state': 'new' }).getByTestId(testIds.projectTrustSelect).click()
      await expect(hooks.getByTestId(testIds.projectTrustSelectAll)).toHaveAttribute('aria-checked', 'mixed')
      await hooks.getByTestId(testIds.projectTrustSelectAll).scrollIntoViewIfNeeded()
    },
    close: async (page) => {
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testIds.projectTrustDialog)).toHaveCount(0)
    },
  },
  {
    name: 'customize-output-styles',
    only: 'desktop',
    open: (page, seed) => openSettings(page, `/settings/customize?tab=output-styles&project=${seed.hooksDemo}`, async (page) => {
      await expect(page.getByTestId(testIds.customizeStyleDefault)).toHaveAttribute('data-value', 'learning')
      await expect(byTestId(page, testIds.customizationRow, { 'data-source': 'project', 'data-name': 'release-notes' })).toBeVisible()
      await expect(byTestId(page, testIds.customizationRow, { 'data-source': 'user', 'data-name': 'terse' })).toBeVisible()
      await revealCustomizeTab(page, 'output-styles')
    }),
  },
  {
    name: 'settings-appearance',
    open: page => openSettings(page, '/settings/appearance', async (page) => {
      await expect(page.getByTestId(testIds.appearanceThemeCard).first()).toBeVisible()
    }),
  },
  {
    name: 'settings-data',
    open: page => openSettings(page, '/settings/data', async (page) => {
      await expect(page.getByTestId(testIds.dataSummary)).toBeVisible()
      await expect(page.getByTestId(testIds.sharesRow)).toHaveCount(1)
    }),
  },
  {
    name: 'settings-data-key',
    open: page => openSettings(page, '/settings/data', async (page) => {
      const section = page.getByTestId(testIds.dataKeySection)
      await expect(section.locator('[data-slot="key-version"]')).toHaveText('1')
      await section.scrollIntoViewIfNeeded()
    }),
  },
  {
    name: 'settings-data-cleanup',
    open: page => openSettings(page, '/settings/data', async (page) => {
      const section = page.getByTestId(testIds.dataCleanupSection)
      await section.getByTestId(testIds.dataCleanupCheck).click()
      await expect(section.getByTestId(testIds.dataCleanupSummary)).toHaveAttribute('data-state', 'removable')
      await expect(section.getByTestId(testIds.dataCleanupRun)).toBeEnabled()
      await section.scrollIntoViewIfNeeded()
    }),
  },
  {
    name: 'settings-data-auto-cleanup',
    open: async (page, seed) => {
      await pageApi(page, seed).updateSettings({ fileSweep: 'daily' })
      await openSettings(page, '/settings/data', async (page) => {
        const section = page.getByTestId(testIds.dataCleanupSection)
        await expect(section.getByTestId(testIds.dataCleanupAuto)).toHaveAttribute('data-state', 'checked')
        const status = section.getByTestId(testIds.dataCleanupAutoStatus)
        await expect(status).toHaveAttribute('data-state', 'never')
        await expect(status).toContainText('Next automatic cleanup')
        await status.scrollIntoViewIfNeeded()
      })
    },
    close: async (page, seed) => {
      await pageApi(page, seed).updateSettings({ fileSweep: 'off' })
    },
  },
  {
    name: 'settings-about',
    open: page => openSettings(page, '/settings/about', async (page) => {
      await expect(page.getByTestId(testIds.aboutCopyDiagnostics)).toBeVisible()
      await expect(page.locator('[data-version="Version"]')).toBeVisible()
    }),
  },
  {
    name: 'chat-not-found',
    open: async (page) => {
      await page.goto('/chat/01900000-0000-7000-8000-000000000000')
      await expect(page.getByTestId(testIds.chatNotFound)).toBeVisible()
    },
  },
  {
    name: 'page-not-found',
    open: async (page) => {
      await page.goto('/no-such-page')
      await expect(page.getByTestId(testIds.errorPage)).toBeVisible()
    },
  },
]

/** A session cookie of the screenshot server for `streamTurn` (fetch sends no cookies of the Playwright contexts). */
async function sessionCookie(baseURL: string): Promise<string> {
  const response = await fetch(`${baseURL}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0]
  if (!response.ok || !cookie)
    throw new Error(`The screenshot login failed (${response.status}).`)
  return cookie
}

/**
 * Sends one user message with fetch and reads its UI message stream while it arrives (HarnessApi buffers whole
 * answers): `onChunk` sees every chunk, e.g. to stop the run or to queue a steer at the right step. Resolves at the end
 * of the stream.
 */
async function streamTurn(
  baseURL: string,
  cookie: string,
  input: { chatId: string, text: string, modelRef: string },
  onChunk: (chunk: UiStreamChunk) => Promise<void> | void,
): Promise<void> {
  const response = await fetch(`${baseURL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      chatId: input.chatId,
      message: { id: createMessageId(), role: 'user', parts: [{ type: 'text', text: input.text }] },
      trigger: 'submit-message',
      modelRef: input.modelRef,
      reasoningEffort: 'auto',
      toolMode: 'ask',
    }),
  })
  if (!response.ok || !response.body)
    throw new Error(`The streamed turn failed (${response.status}).`)
  const decoder = new TextDecoder()
  let pending = ''
  for await (const bytes of response.body) {
    pending += decoder.decode(bytes, { stream: true })
    const end = pending.lastIndexOf('\n')
    if (end === -1)
      continue
    for (const chunk of parseUiMessageStream(pending.slice(0, end)))
      await onChunk(chunk)
    pending = pending.slice(end + 1)
  }
}

/**
 * Phase 11: the `hooks-demo` project. Its `.harness/settings.json` changes three times: hooks for the notes chat, then a
 * Stop hook for the continuation chat, then the final hooks the Customize and trust screens show (two approved earlier,
 * the prompt hook approved now, a new PostToolUse hook and a Stop hook whose script changed since its approval wait).
 * `.mcp.json` holds an approved stdio server with its variable set and an HTTP server waiting for approval; a command
 * with shell lines waits too. The project uses the output style Learning.
 */
async function seedHooksProject(api: HarnessApi, root: string): Promise<{ project: string, notes: string, continuation: string }> {
  const folder = join(root, HOOKS_PROJECT)
  await mkdir(folder, { recursive: true })
  const commands: Record<string, string> = {}
  for (const [file, [name, options]] of Object.entries(HOOK_SCRIPTS))
    commands[file] = await writeHookScript(folder, name, options)
  for (const [file, content] of Object.entries(HOOKS_FILES))
    await writeProjectFile(folder, file, content)
  await mkdir(join(folder, 'tools'), { recursive: true })
  await copyFile(MCP_MIN_FIXTURE, join(folder, 'tools/mcp-min.mjs'))
  const project = (await api.client.projects.create({ body: { name: HOOKS_PROJECT, path: folder } })).id
  const useHooks = async (hooks: HooksConfig, approve: Parameters<typeof approveProjectItems>[2]) => {
    await writeProjectFile(folder, '.harness/settings.json', projectSettings(hooks))
    await approveProjectItems(api, project, approve)
  }
  const hookChat = async (title: string) => (await api.createChat({ title, projectId: project, modelRef: MOCK_HOOKS_MODEL })).id

  // A SessionStart note, a shell call a PreToolUse hook denies, and a Stop hook that fails.
  await useHooks({
    PreToolUse: [hookGroup(commands.guard!, { matcher: 'Bash' })],
    SessionStart: [hookGroup(commands.branch!)],
    Stop: [hookGroup(commands.lint!)],
  }, item => item.kind === 'hook')
  const notes = await hookChat('Clean the build folder')
  const blocked = await api.sendChat({ chatId: notes, modelRef: MOCK_HOOKS_MODEL, toolMode: 'auto', text: 'run rm -rf build' })
  if (!blocked.text.startsWith('Called shell: denied'))
    throw new Error(`mock:hooks answered ${JSON.stringify(blocked.text)}.`)

  // A Stop hook that asks for one more turn once: the server starts it from a carrier message.
  await useHooks({ Stop: [hookGroup(commands.tests!)] }, item => item.kind === 'hook')
  const continuation = await hookChat('Fix the parser test')
  await api.sendChat({ chatId: continuation, modelRef: MOCK_HOOKS_MODEL, toolMode: 'auto', text: 'Fix the failing parser test.' })
  await expect.poll(async () => {
    const last = (await api.getChat(continuation)).messages.at(-1)
    return last?.role === 'assistant' && last.metadata?.finishedAt !== undefined && last.parts.some(part => part.type === 'text' && part.text.startsWith('Hook continuation:'))
  }, { timeout: 15_000, message: 'the Stop hook continuation finished' }).toBe(true)

  // The final hooks. The lint script changes after its approval ("Changed"); the PostToolUse hook is new; the prompt
  // hook and the stdio MCP server are approved now (the command and the HTTP server keep waiting).
  await writeHookScript(folder, 'error', { file: 'lint', text: 'eslint: 3 problems in src/app.ts' })
  await useHooks({
    PreToolUse: [hookGroup(commands.guard!, { matcher: 'Bash' })],
    PostToolUse: [hookGroup(commands.format!, { matcher: 'Write|Edit', timeout: 30 })],
    UserPromptSubmit: [hookGroup(commands.secrets!)],
    SessionStart: [hookGroup(commands.branch!)],
    Stop: [hookGroup(commands.lint!)],
  }, item => (item.kind === 'hook' && item.detail.event === 'UserPromptSubmit') || (item.kind === 'mcp' && item.detail.name === 'docs'))
  await api.client.projectMcp.setVariables({ params: { id: project }, body: { values: { DOCS_TOKEN: 'docs-demo-token' } } })
  await api.client.projects.update({ params: { id: project }, body: { outputStyle: 'learning' } })
  return { project, notes, continuation }
}

/** Creates the chats of the screenshots through the API of the screenshot server. */
async function seed(server: StartedServer): Promise<Seed> {
  const api = await HarnessApi.create(server.baseURL)
  try {
    await api.client.auth.login({ body: { password: PASSWORD } })
    // The image and speech-to-text models change nothing on the other screens (the mic looks the same either way).
    // Phase 9: the sub-agent and compaction models only show on Settings -> General -> Agent.
    await api.updateSettings({ displayName: 'Alex', defaultModelRef: 'mock:echo', imageModelRef: 'mock:image', transcriptionModelRef: 'mock:transcribe', subagentModelRef: 'mock:subagent', compactModelRef: 'mock:compact', ...NO_SPEECH_SETTINGS })
    const titled = async (title: string) => (await api.createChat({ title })).id
    // Projects (Phase 7): two project folders and a plain folder (with subfolders) for the Add project dialog, below the
    // server's workspace root.
    const root = await workspaceRoot(api)
    for (const folder of ['harness-forge/apps', 'harness-forge/packages', 'notes', 'playground/api', 'playground/scripts', 'playground/web'])
      await mkdir(join(root, folder), { recursive: true })
    const project = (await api.client.projects.create({ body: { name: 'harness-forge', path: join(root, 'harness-forge') } })).id
    for (const [file, content] of Object.entries(NOTES_FILES)) {
      await mkdir(join(root, 'notes', dirname(file)), { recursive: true })
      await writeFile(join(root, 'notes', file), content)
    }
    const notes = (await api.client.projects.create({ body: { name: 'notes', path: join(root, 'notes') } })).id
    // Phase 11 first of all (the oldest chats: the sidebar lists them last).
    const hooks = await seedHooksProject(api, root)
    // Phase 10 first (the oldest chats: the sidebar lists them last), with the sub-agents on the chats' own models.
    for (const definition of PERSONAL_DEFINITIONS)
      await api.client.customizations.create({ body: definition })
    await api.updateSettings({ subagentModelRef: null })
    const taskResult = (await api.createChat({ title: 'Find the flaky tests', modelRef: 'mock:background' })).id
    await api.sendChat({ chatId: taskResult, modelRef: 'mock:background', toolMode: 'ask', text: 'bg explore Find the flaky tests.' })
    // The agent reports through a turn the server starts by itself: wait for its reply.
    await expect.poll(async () => {
      const last = (await api.getChat(taskResult)).messages.at(-1)
      return last?.role === 'assistant' && last.metadata?.finishedAt !== undefined && last.parts.some(part => part.type === 'text' && part.text.startsWith('Background result:'))
    }, { timeout: 15_000, message: 'the background agent reported' }).toBe(true)
    const customAgent = (await api.createChat({ title: 'Review the release notes', projectId: notes, modelRef: 'mock:agents' })).id
    await api.sendChat({ chatId: customAgent, modelRef: 'mock:agents', toolMode: 'ask', text: 'agent code-reviewer' })
    await api.updateSettings({ subagentModelRef: 'mock:subagent' })
    // Phase 9 first (the oldest chats: the sidebar lists them last). Nothing here writes into the project folder.
    const plan = (await api.createChat({ title: 'Plan the cookie settings', projectId: project, modelRef: 'mock:plan' })).id
    await api.sendChat({ chatId: plan, modelRef: 'mock:plan', toolMode: 'plan', text: 'Plan moving the session cookie settings into one module.' })
    const subagents = (await api.createChat({ title: 'Map the auth code', projectId: project, modelRef: 'mock:subagent' })).id
    await api.sendChat({ chatId: subagents, modelRef: 'mock:subagent', toolMode: 'ask', text: 'Find the session code and the cookie settings.' })
    const compacted = (await api.createChat({ title: 'Parser crash on empty input', modelRef: 'mock:echo' })).id
    for (const text of ['Why does the parser crash on empty input?', 'Which test covers the lexer\'s end of file?', 'Should the parser return an empty program instead?'])
      await api.sendChat({ chatId: compacted, modelRef: 'mock:echo', toolMode: 'off', text })
    await api.sendChat({ chatId: compacted, modelRef: 'mock:echo', toolMode: 'off', text: '/compact keep the parser details' })
    // A `mock:todo` run stopped right after its second list: the list stays unfinished (1/3).
    const todos = (await api.createChat({ title: 'Fix the parser crash', modelRef: 'mock:todo' })).id
    const cookie = await sessionCookie(server.baseURL)
    let lists = 0
    await streamTurn(server.baseURL, cookie, { chatId: todos, modelRef: 'mock:todo', text: 'Fix the crash, then run the tests.' }, async (chunk) => {
      if (chunk.type === 'tool-output-available' && ++lists === 2)
        await fetch(`${server.baseURL}/api/chat/${todos}/stop`, { method: 'POST', headers: { cookie } })
    })
    const projectChat = async (title: string) => (await api.createChat({ title, projectId: project, modelRef: 'mock:workspace' })).id
    const workspaceText = 'Change the greeting in mock-workspace.txt and print the file.'
    // Older chats first: the sidebar lists the newest on top.
    const workspace = await projectChat('Update the greeting')
    const done = await api.sendChat({ chatId: workspace, modelRef: 'mock:workspace', toolMode: 'auto', text: workspaceText })
    if (done.text !== MOCK_WORKSPACE_DONE)
      throw new Error(`mock:workspace answered ${JSON.stringify(done.text)}.`)
    const editApproval = await projectChat('Edit the greeting (approval)')
    await api.sendChat({ chatId: editApproval, modelRef: 'mock:workspace', toolMode: 'ask', text: workspaceText })
    // Allow the write: the edit asks next.
    await api.answerApprovals({ chatId: editApproval, approved: true, modelRef: 'mock:workspace', toolMode: 'ask' })
    const shellApproval = await projectChat('Print the greeting (approval)')
    await api.sendChat({ chatId: shellApproval, modelRef: 'mock:workspace', toolMode: 'edits', text: workspaceText })
    // Phase 8: a few more files, then (git installed) the project folder becomes a repository with all of it committed.
    const projectPath = join(root, 'harness-forge')
    for (const [file, content] of Object.entries(PROJECT_FILES)) {
      await mkdir(join(projectPath, dirname(file)), { recursive: true })
      await writeFile(join(projectPath, file), content)
    }
    if (await gitAvailable())
      await (await initGitRepository(projectPath, { ceiling: root })).dispose()
    // Rules: the `mock:checkpoint` shell calls run without a card in Accept edits (`mock-dir` exists, so its `cd` needs
    // none); `git status` for every project.
    for (const prefix of ['ls', 'mkdir', 'pnpm test'])
      await api.client.shellRules.create({ body: { projectId: project, prefix } })
    await api.client.shellRules.create({ body: { projectId: null, prefix: 'git status' } })
    const phase8Chat = async (title: string, modelRef: string) => (await api.createChat({ title, projectId: project, modelRef })).id
    // The changes chat first: the later chat writes the same text, so this chat's change stays its own.
    const changes = await phase8Chat('Prepare the release checklist', 'mock:checkpoint')
    const checklist = await api.sendChat({ chatId: changes, modelRef: 'mock:checkpoint', toolMode: 'edits', text: 'Update the release checklist and check the build folder.' })
    if (checklist.text !== MOCK_CHECKPOINT_DONE)
      throw new Error(`mock:checkpoint answered ${JSON.stringify(checklist.text)}.`)
    // It runs in mock-dir (the sticky folder of the turn before).
    await api.sendChat({ chatId: changes, modelRef: 'mock:shell', toolMode: 'auto', text: 'cd .. && rm docs/old-notes.md && touch docs/release-notes.md' })
    const terminalCwd = await phase8Chat('Check the build folder', 'mock:checkpoint')
    await api.sendChat({ chatId: terminalCwd, modelRef: 'mock:checkpoint', toolMode: 'edits', text: 'List the build folder.' })
    const ruleApproval = await phase8Chat('Build the web app', 'mock:shell')
    await api.sendChat({ chatId: ruleApproval, modelRef: 'mock:shell', toolMode: 'ask', text: 'pnpm build --filter web' })
    // A rowless blob from two days ago: the storage cleanup counts it as a leftover file (its check is a dry run).
    const blob = 'a leftover blob for the storage cleanup screen\n'
    const sha256 = createHash('sha256').update(blob).digest('hex')
    const shard = join(server.dataDir, 'files', sha256.slice(0, 2))
    await mkdir(shard, { recursive: true })
    await writeFile(join(shard, sha256), blob)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await utimes(join(shard, sha256), twoDaysAgo, twoDaysAgo)
    const shared = await titled('Session migration plan')
    await api.sendChat({ chatId: shared, modelRef: 'mock:reasoning', reasoningEffort: 'high', text: 'Why is a server session safer than a token in local storage?' })
    await api.sendChat({ chatId: shared, modelRef: 'mock:tool-approval', toolMode: 'auto', text: 'Echo "rotate the session cookie" with the tool.' })
    await api.sendChat({ chatId: shared, modelRef: 'mock:echo', toolMode: 'off', text: SHARED_SUMMARY })
    const share = await api.client.shares.create({ body: { chatId: shared, options: { reasoning: true, toolDetails: true } } })
    // After the snapshot: the link is outdated.
    await api.sendChat({ chatId: shared, modelRef: 'mock:echo', toolMode: 'off', text: 'Also list the rollout steps.' })
    const versions = await titled('Where should sessions live?')
    await api.sendChat({ chatId: versions, modelRef: 'mock:echo', toolMode: 'off', text: 'Should the sessions live in SQLite or in Redis?' })
    // An edit (a second version of the first message: same parent, none), then a second version of its reply.
    await api.sendChat({ chatId: versions, parentId: null, modelRef: 'mock:echo', toolMode: 'off', text: 'Should the sessions live in SQLite for a single-user app?' })
    await api.regenerateChat({ chatId: versions, modelRef: 'mock:echo', toolMode: 'off' })
    for (const title of ['Kimi vs Qwen for code review', 'Plugin idea: Linear sync', 'Weekly notes'])
      await titled(title)
    const images = await titled('Launch poster concepts')
    await api.sendChat({ chatId: images, modelRef: 'mock:image', text: 'A minimalist launch poster for harness-forge v1.2, warm ember colors', imageOptions: { n: 1, aspectRatio: '16:9' } })
    // The next turn edits the image of the previous reply (the default for image models): two variations.
    await api.sendChat({ chatId: images, modelRef: 'mock:image', text: 'Two variations with more contrast', imageOptions: { n: 2, aspectRatio: '16:9' } })
    const error = await titled('Check the Anthropic key')
    await api.sendChat({ chatId: error, modelRef: 'mock:error', text: 'Is my key still valid?' })
    const approval = await titled('Echo tool (approval)')
    await api.sendChat({ chatId: approval, modelRef: 'mock:tool-approval', toolMode: 'ask', text: 'Echo "deploy to staging" with the tool.' })
    const tools = await titled('Echo tool (auto)')
    await api.sendChat({ chatId: tools, modelRef: 'mock:tool-approval', toolMode: 'auto', text: 'Echo "hello from the tool" with the tool.' })
    const reasoning = await titled('Why do cookies beat tokens here?')
    await api.sendChat({ chatId: reasoning, modelRef: 'mock:reasoning', reasoningEffort: 'high', text: 'Why is a server session safer than a token in local storage for this app?' })
    const markdown = await titled('Refactor auth flow')
    await api.sendChat({ chatId: markdown, modelRef: 'mock:echo', toolMode: 'off', text: MARKDOWN })
    // Phase 11: the personal hooks last (no seeded turn runs them; no screen calls shell or edit_file afterwards) and a
    // personal style. Creating a hook needs a fresh login.
    await api.client.auth.login({ body: { password: PASSWORD } })
    await api.client.hooks.create({ body: { event: 'PreToolUse', matcher: 'Bash|Edit', command: './scripts/guard.sh', timeout: 30 } })
    await api.client.hooks.create({ body: { event: 'Stop', command: 'pnpm lint --quiet', enabled: false } })
    await api.client.customizations.create({ body: { kind: 'style', content: PERSONAL_STYLE } })
    // Phase 12: a local-folder marketplace and a fake Claude Code home, both in temp folders outside the repository.
    const tempFolders: TempFolder[] = []
    const marketplaceFolder = await makeTempFolder('screenshots-marketplace')
    tempFolders.push(marketplaceFolder)
    await writeTree(marketplaceFolder.path, marketplaceTree(MARKETPLACE_NAME, MARKETPLACE_PLUGINS))
    const marketplace = (await api.client.marketplaces.add({ body: { source: { type: 'path', path: marketplaceFolder.path } } })).id
    const homeFolder = await makeTempFolder('screenshots-claude-home')
    tempFolders.push(homeFolder)
    await writeTree(homeFolder.path, fakeClaudeHomeTree())
    const claudeDir = join(homeFolder.path, '.claude')
    const claudeHome = {
      home: homeFolder.path,
      claudeDir,
      claudeJson: join(homeFolder.path, '.claude.json'),
      writeClaudeFile: (relative: string, content: string) => writeFile(join(claudeDir, ...relative.split('/')), content),
    }
    return {
      markdown,
      reasoning,
      tools,
      approval,
      error,
      versions,
      shared,
      sharePath: share.path,
      images,
      workspaceRoot: root,
      workspace,
      editApproval,
      shellApproval,
      project,
      changes,
      terminalCwd,
      ruleApproval,
      plan,
      subagents,
      todos,
      compacted,
      notes,
      customAgent,
      taskResult,
      hooksDemo: hooks.project,
      hookNotes: hooks.notes,
      hookContinuation: hooks.continuation,
      marketplace,
      claudeHome,
      tempFolders,
      baseURL: server.baseURL,
      now: Date.now() + 2 * 60_000,
    }
  }
  finally {
    await api.dispose()
  }
}

/** Captures every screen of one theme at the current viewport, starting at the login page. */
async function captureAll(page: Page, seedData: Seed, theme: Theme, viewport: Viewport): Promise<void> {
  const dir = join(OUTPUT_DIR, theme)
  await mkdir(dir, { recursive: true })
  const shoot = async (name: string) => {
    await page.evaluate('document.fonts.ready.then(() => true)')
    await page.screenshot({ path: join(dir, `${name}-${viewport}.png`), animations: 'disabled', caret: 'hide' })
  }

  // The browser clock starts at a fixed time a little after the seed, then runs: relative times read "2m ago" in every
  // run, and the transcript's stick-to-bottom scrolling (it measures elapsed time) still works.
  await page.clock.install({ time: seedData.now })
  await page.clock.resume()
  // Phase 12: the import dialog never asks the server for its Claude Code folder.
  await stubClaudeHome(page)
  await page.goto('/')
  await expect(page.getByTestId(testIds.loginForm)).toBeVisible()
  await expect(page.locator('html')).toContainClass(theme)
  await shoot('login')
  await page.getByTestId(testIds.loginPassword).fill(PASSWORD)
  await page.getByTestId(testIds.loginSubmit).click()
  await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()

  for (const screen of SCREENS) {
    if (screen.only && screen.only !== viewport)
      continue
    await test.step(screen.name, async () => {
      await screen.open(page, seedData)
      await expect(page.locator('html')).toContainClass(theme)
      await shoot(screen.name)
      await screen.close?.(page, seedData)
    })
  }
}

/** The provider wizard on its API step with the LM Studio template (README only). */
const WIZARD_API_SCREEN: Screen = {
  name: 'provider-wizard-api',
  open: async (page) => {
    await page.goto('/plugins/new?type=provider')
    const wizard = page.getByTestId(testIds.wizard)
    await expect(wizard).toHaveAttribute('data-step', 'basics')
    await page.getByTestId(testIds.wizardName).fill('LM Studio')
    await page.getByTestId(testIds.wizardNext).click()
    await expect(wizard).toHaveAttribute('data-step', 'api')
    await byTestId(page, testIds.wizardTemplate, { 'data-value': 'lmstudio' }).click()
    await expect(page.getByTestId(testIds.wizardBaseUrl)).toHaveValue('http://localhost:1234/v1')
    // No focus ring in the picture.
    await page.getByTestId(testIds.wizardBaseUrl).blur()
  },
  close: async (page) => {
    // The draft lives in this browser's storage: discard it.
    await page.getByTestId(testIds.wizardDiscard).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByTestId(testIds.wizard)).toHaveAttribute('data-step', 'basics')
  },
}

/** The README images (`docs/assets/screenshots/<file>.png`): the screen each one shows, in its theme. */
const README_SHOTS: readonly { file: string, screen: string, theme: Theme }[] = [
  { file: 'chat-dark', screen: 'chat', theme: 'dark' },
  { file: 'workspace-dark', screen: 'chat-shell-approval', theme: 'dark' },
  { file: 'changes-panel-dark', screen: 'chat-changes-panel', theme: 'dark' },
  { file: 'plugins-dark', screen: 'plugins', theme: 'dark' },
  { file: 'provider-wizard-dark', screen: WIZARD_API_SCREEN.name, theme: 'dark' },
  { file: 'settings-dark', screen: 'settings-providers', theme: 'dark' },
  { file: 'chat-light', screen: 'chat-approval', theme: 'light' },
  // Phase 10: a candidate for the README (W10.14 decides).
  { file: 'customize-dark', screen: 'settings-customize', theme: 'dark' },
  // Phase 11: a candidate for the README (W11.14 decides).
  { file: 'hooks-dark', screen: 'settings-customize-hooks', theme: 'dark' },
  // Phase 12: candidates for the README (W12.15 decides).
  { file: 'marketplaces-dark', screen: 'plugins-marketplaces', theme: 'dark' },
  { file: 'claude-import-dark', screen: 'claude-import-preview', theme: 'dark' },
]

/** Captures the README images of one theme as full 1440x900 frames (no crops) into `.tmp/screenshots/readme/`. */
async function captureReadme(page: Page, seedData: Seed, theme: Theme): Promise<void> {
  await mkdir(README_DIR, { recursive: true })
  await page.clock.install({ time: seedData.now })
  await page.clock.resume()
  // Phase 12: the import dialog never asks the server for its Claude Code folder.
  await stubClaudeHome(page)
  await page.goto('/')
  await expect(page.getByTestId(testIds.loginForm)).toBeVisible()
  await page.getByTestId(testIds.loginPassword).fill(PASSWORD)
  await page.getByTestId(testIds.loginSubmit).click()
  await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()

  for (const shot of README_SHOTS.filter(item => item.theme === theme)) {
    const screen = [...SCREENS, WIZARD_API_SCREEN].find(item => item.name === shot.screen)
    if (!screen)
      throw new Error(`No screen ${shot.screen} for ${shot.file}.`)
    await test.step(shot.file, async () => {
      await screen.open(page, seedData)
      await expect(page.locator('html')).toContainClass(theme)
      await page.evaluate('document.fonts.ready.then(() => true)')
      await page.screenshot({ path: join(README_DIR, `${shot.file}.png`), animations: 'disabled', caret: 'hide' })
      await screen.close?.(page, seedData)
    })
  }
}

interface ScreenshotFixtures {
  /** The screenshot server with its chats, started once per worker (only when a screenshot test runs). */
  screenshotServer: { server: StartedServer, seed: Seed }
}

const shots = test.extend<object, ScreenshotFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their first argument.
  screenshotServer: [async ({}, use) => {
    const server = await startServer({ env: { HF_PASSWORD: PASSWORD }, label: 'hf-e2e-screenshots' })
    let seeded: Seed | undefined
    try {
      seeded = await seed(server)
      await use({ server, seed: seeded })
    }
    finally {
      await server.stop()
      for (const folder of seeded?.tempFolders ?? [])
        await folder.remove()
    }
  }, { scope: 'worker', timeout: 60_000 }],
  // Pages and `page.goto('/...')` go to the screenshot server.
  baseURL: async ({ screenshotServer }, use) => {
    await use(screenshotServer.server.baseURL)
  },
})

shots.describe('screenshots', () => {
  shots.skip(!ENABLED, 'Set E2E_SCREENSHOTS=1 to capture the screenshots.')
  shots.use({ reducedMotion: 'reduce' })
  shots.describe.configure({ timeout: 180_000 })

  for (const theme of THEMES) {
    shots.describe(theme, () => {
      shots.use({ colorScheme: theme })

      // The stored color mode, before any script of the app runs.
      shots.beforeEach(async ({ page }) => {
        await page.addInitScript({ content: `localStorage.setItem(${JSON.stringify(COLOR_MODE_STORAGE_KEY)}, ${JSON.stringify(theme)})` })
      })

      shots.describe('desktop', () => {
        shots.use({ viewport: { width: 1440, height: 900 } })

        shots(`every screen in ${theme} at 1440x900 @screenshots`, async ({ page, screenshotServer }) => {
          await captureAll(page, screenshotServer.seed, theme, 'desktop')
        })

        shots(`the README images in ${theme} at 1440x900 @screenshots @readme`, async ({ page, screenshotServer }) => {
          await captureReadme(page, screenshotServer.seed, theme)
        })
      })

      shots.describe('mobile', () => {
        const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7']
        shots.use({ ...pixel7, viewport: { width: 390, height: 844 } })

        shots(`every screen in ${theme} at 390x844 @screenshots`, async ({ page, screenshotServer }) => {
          await captureAll(page, screenshotServer.seed, theme, 'mobile')
        })
      })
    })
  }
})
