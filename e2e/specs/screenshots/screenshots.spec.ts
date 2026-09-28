// Screenshots of every screen for the visual review (opt-in: `E2E_SCREENSHOTS=1`, otherwise every test is skipped).
// Dark and light, desktop 1440x900 and a 390x844 phone (touch), a browser clock that starts at a fixed time, reduced
// motion; the files go to `.tmp/screenshots/{dark,light}/<screen>-{desktop,mobile}.png`. The spec runs its own
// password-protected server from the build with a fresh data directory (`startServer`), so the pictures hold only the
// chats it creates, and the login page is one of the screens.
import type { Page } from '@playwright/test'
import type { StartedServer } from '../../helpers/index.ts'
import { mkdir } from 'node:fs/promises'
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
  pressShortcut,
  REPO_ROOT,
  startServer,
  test,
  testIds,
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

interface Screen {
  name: string
  only?: Viewport
  /** Navigates and waits until the screen shows what it should. */
  open: (page: Page, seed: Seed) => Promise<void>
}

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
      await expect(page.getByTestId(testIds.dataSettings)).toBeAttached()
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
    await api.updateSettings({ displayName: 'Alex', defaultModelRef: 'mock:echo' })
    const titled = async (title: string) => (await api.createChat({ title })).id
    // Older chats first: the sidebar lists the newest on top.
    for (const title of ['Kimi vs Qwen for code review', 'Plugin idea: Linear sync', 'Weekly notes'])
      await titled(title)
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
    return { markdown, reasoning, tools, approval, error, now: Date.now() + 2 * 60_000 }
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
