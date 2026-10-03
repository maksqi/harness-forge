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
// Settings -> Data (a leftover blob in the server's file store gives the cleanup something to count). A screen that
// starts something (a run, a recording, a dialog, settings only it needs) undoes it in `close`, so the other screens
// look the same in every run.
import type { Locator, Page } from '@playwright/test'
import type { StartedServer } from '../../helpers/index.ts'
import { createHash } from 'node:crypto'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { devices } from '@playwright/test'
import {
  byTestId,
  COLOR_MODE_STORAGE_KEY,
  composer,
  expect,
  expectMessageStatus,
  HarnessApi,
  lastAssistantMessage,
  MOCK_WORKSPACE_DONE,
  naturalSize,
  pressShortcut,
  REPO_ROOT,
  sendMessage,
  startServer,
  test,
  testIds,
  workspaceRoot,
} from '../../helpers/index.ts'

const ENABLED = process.env.E2E_SCREENSHOTS === '1'
const OUTPUT_DIR = join(REPO_ROOT, '.tmp/screenshots')
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

/** Expands a finished workspace tool row and returns its expanded body. */
async function expandWorkspaceRow(page: Page, toolName: string): Promise<Locator> {
  const row = workspaceRow(page, toolName)
  await expect(row).toHaveAttribute('data-state', 'output-available')
  await row.getByRole('button').click()
  return row.locator('xpath=ancestor::*[@data-slot="tool-part"][1]').getByTestId(testIds.toolRowOutput)
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
      await expect(page.getByTestId(testIds.projectSwitcherOption)).toHaveCount(4)
      await expect(page.getByTestId(testIds.projectManage)).toBeVisible()
    },
  },
  {
    name: 'new-chat-project',
    open: async (page) => {
      await openNewChatScreen(page)
      await page.getByTestId(testIds.newChatProject).click()
      await expect(page.getByTestId(testIds.projectOption)).toHaveCount(3)
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
      await expect(page.getByTestId(testIds.projectRow)).toHaveCount(2)
    }),
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

/** Creates the chats of the screenshots through the API of the screenshot server. */
async function seed(server: StartedServer): Promise<Seed> {
  const api = await HarnessApi.create(server.baseURL)
  try {
    await api.client.auth.login({ body: { password: PASSWORD } })
    // The image and speech-to-text models change nothing on the other screens (the mic looks the same either way).
    await api.updateSettings({ displayName: 'Alex', defaultModelRef: 'mock:echo', imageModelRef: 'mock:image', transcriptionModelRef: 'mock:transcribe', ...NO_SPEECH_SETTINGS })
    const titled = async (title: string) => (await api.createChat({ title })).id
    // Projects (Phase 7): two project folders and a plain folder (with subfolders) for the Add project dialog, below the
    // server's workspace root.
    const root = await workspaceRoot(api)
    for (const folder of ['harness-forge/apps', 'harness-forge/packages', 'notes', 'playground/api', 'playground/scripts', 'playground/web'])
      await mkdir(join(root, folder), { recursive: true })
    const project = (await api.client.projects.create({ body: { name: 'harness-forge', path: join(root, 'harness-forge') } })).id
    await api.client.projects.create({ body: { name: 'notes', path: join(root, 'notes') } })
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

interface ScreenshotFixtures {
  /** The screenshot server with its chats, started once per worker (only when a screenshot test runs). */
  screenshotServer: { server: StartedServer, seed: Seed }
}

const shots = test.extend<object, ScreenshotFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their first argument.
  screenshotServer: [async ({}, use) => {
    const server = await startServer({ env: { HF_PASSWORD: PASSWORD }, label: 'hf-e2e-screenshots' })
    try {
      await use({ server, seed: await seed(server) })
    }
    finally {
      await server.stop()
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
