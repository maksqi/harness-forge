// Touch tablets (docs/UI.md 14.5, 14.7; S9, W6.11), project `tablet` (Galaxy Tab S9 landscape: 1024x640, touch, so
// `pointer: coarse` matches and the sidebar is not a sheet): the collapsed icon rail is 3.5rem (56 px) wide instead of
// 3rem, and every button of it is a touch target of at least 40x40 px, in the chat, plugins and settings modes (the
// project switcher of the chat mode among them). Phase 7 (W7.14): in a project chat the expanded sidebar's project
// switcher, the header's project chip and the controls of a workspace approval card (Deny, Allow, "Accept all edits in
// this chat") are 40 px targets too. Phase 8 (W8.12): the changes toggle, the pane's Close and Refresh, a changes row and
// its Revert (shown without hover), "Rewind files to here", and on a shell card the "Always allow commands starting
// with" checkbox, the prefix input and both scope options are 40 px targets (at 1024 px the panel is the desktop pane).
import type { Locator, Page } from '@playwright/test'
import type { CleanupTask, HarnessApi } from '../../helpers/index.ts'
import {
  boxOf,
  byTestId,
  changesFile,
  changesFileButton,
  changesPane,
  changesPanel,
  changesToggle,
  expect,
  MOCK_CHECKPOINT_DONE,
  MOCK_CHECKPOINT_FILE,
  seedProject,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
  userMessages,
} from '../../helpers/index.ts'

/** The collapsed rail on touch devices (`pointer-coarse:[--sidebar-width-icon:3.5rem]`). */
const RAIL_WIDTH = 56
const MIN_TARGET = 40

interface RailMode {
  path: string
  /** Visible once the page rendered. */
  ready: (page: Page) => Locator
  /** Rail buttons that must be there (by test id), besides every other visible button or link of the rail. */
  buttons: readonly string[]
}

const MODES: readonly RailMode[] = [
  {
    path: '/',
    ready: page => page.getByTestId(testIds.emptyGreeting),
    buttons: [testIds.sidebarTrigger, testIds.modeTabChat, testIds.modeTabPlugins, testIds.projectSwitcher, testIds.newChat, testIds.searchChats, testIds.settingsLink, testIds.themeToggle],
  },
  {
    path: '/plugins',
    ready: page => page.getByTestId(testIds.pluginCard).first(),
    buttons: [testIds.sidebarTrigger, testIds.modeTabChat, testIds.modeTabPlugins, testIds.pluginsNew, testIds.pluginsInstall, testIds.settingsLink, testIds.themeToggle],
  },
  {
    path: '/settings/providers',
    ready: page => page.getByTestId(testIds.pageHeader),
    buttons: [testIds.sidebarTrigger, testIds.backToApp, testIds.settingsNavProviders, testIds.settingsNavModels, testIds.settingsNavMedia, testIds.settingsNavProjects, testIds.settingsNavGeneral, testIds.settingsNavAppearance, testIds.settingsNavData, testIds.settingsNavAbout, testIds.themeToggle],
  },
]

/** The rail takes exactly `RAIL_WIDTH` px: the page starts right after it, and the sidebar fills it (inside its border). */
async function expectRailWidth(page: Page, where: string): Promise<void> {
  await expect.poll(async () => Math.round((await boxOf(page.getByRole('main'))).x), { message: `${where}: the page starts after the rail` }).toBe(RAIL_WIDTH)
  const rail = await boxOf(page.getByTestId(testIds.sidebar))
  expect(Math.round(rail.x), `${where}: the rail starts at the left edge`).toBe(0)
  const right = Math.round(rail.x + rail.width)
  expect(right, `${where}: the sidebar fills the rail (inside its 1 px border)`).toBeGreaterThanOrEqual(RAIL_WIDTH - 1)
  expect(right, `${where}: the sidebar fits the rail`).toBeLessThanOrEqual(RAIL_WIDTH)
}

/** Every visible button and link of the rail is at least 40x40 px; the named ones are among them. */
async function expectRailTargets(page: Page, mode: RailMode): Promise<void> {
  const sidebar = page.getByTestId(testIds.sidebar)
  for (const id of mode.buttons)
    await expect(sidebar.getByTestId(id), `${mode.path}: ${id} is in the rail`).toBeVisible()
  const targets = sidebar.getByRole('button').or(sidebar.getByRole('link'))
  let checked = 0
  for (const target of await targets.all()) {
    if (!(await target.isVisible()))
      continue
    const name = `${mode.path}: ${await target.getAttribute('data-testid') ?? await target.getAttribute('aria-label') ?? 'a rail button'}`
    const size = await touchTargetSize(target)
    expect(size.width, `${name} width`).toBeGreaterThanOrEqual(MIN_TARGET)
    expect(size.height, `${name} height`).toBeGreaterThanOrEqual(MIN_TARGET)
    // Inside the rail, not cut off by it.
    const box = await boxOf(target)
    expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(RAIL_WIDTH)
    checked += 1
  }
  expect(checked, `${mode.path}: rail buttons checked`).toBeGreaterThanOrEqual(mode.buttons.length)
}

test.describe('tablet touch targets', () => {
  test('the collapsed rail is 56 px wide and every button in it is at least 40x40 px', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    expect(await page.evaluate<boolean>('matchMedia("(pointer: coarse)").matches'), 'a coarse pointer').toBe(true)
    const sidebar = page.getByTestId(testIds.sidebar)
    // Wider than the sheet breakpoint: the sidebar is part of the page, not a dialog.
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')
    await expect(page.getByRole('dialog').filter({ has: sidebar })).toHaveCount(0)

    // The expanded sidebar's trigger is a 40 px touch target too (UI.md 14.5).
    const expandedTrigger = await touchTargetSize(sidebar.getByTestId(testIds.sidebarTrigger))
    expect(expandedTrigger.width, 'expanded trigger width').toBeGreaterThanOrEqual(MIN_TARGET)
    expect(expandedTrigger.height, 'expanded trigger height').toBeGreaterThanOrEqual(MIN_TARGET)

    // Collapse it with its own trigger.
    await sidebar.getByTestId(testIds.sidebarTrigger).tap()
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
    await expect(sidebar.getByTestId(testIds.sidebarTrigger)).toHaveAccessibleName('Expand sidebar')

    // The rail keeps its size and its targets in every mode (the collapsed state is kept across pages).
    for (const mode of MODES) {
      if (mode.path !== '/')
        await page.goto(mode.path)
      await expect(mode.ready(page), `${mode.path} rendered`).toBeVisible()
      await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
      await expectRailWidth(page, mode.path)
      await expectRailTargets(page, mode)
    }

    // The rail's trigger expands the sidebar again.
    await sidebar.getByTestId(testIds.sidebarTrigger).tap()
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')
    await expect.poll(async () => Math.round((await boxOf(page.getByRole('main'))).x)).toBeGreaterThan(RAIL_WIDTH)
  })
})

/** At least 40x40 px; polled, because menus and cards zoom or fade in. */
async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${name} height` }).toBeGreaterThanOrEqual(MIN_TARGET)
  expect((await touchTargetSize(target)).width, `${name} width`).toBeGreaterThanOrEqual(MIN_TARGET)
}

/** A project chat whose `mock:workspace` reply waits for the approval of its first step (write_file in `ask`). */
async function openApprovalChat(page: Page, api: HarnessApi, cleanup: (task: CleanupTask) => void): Promise<Locator> {
  const { project } = await seedProject(api, cleanup, { name: `Tablet ${uniqueId('tablet')}` })
  const chat = await api.createChat({ title: `Tablet approval ${uniqueId('chat')}`, projectId: project.id, modelRef: 'mock:workspace' })
  cleanup(api => api.removeChat(chat.id))
  await api.sendChat({ chatId: chat.id, modelRef: 'mock:workspace', toolMode: 'ask', text: 'Go.' })
  await page.goto(`/chat/${chat.id}`)
  const card = byTestId(page, testIds.toolApproval, { 'data-tool-name': 'write_file' })
  await expect(card).toBeVisible()
  return card
}

test.describe('tablet touch targets in a project chat', () => {
  test('the project switcher, the chip and the approval buttons are at least 40x40 px', async ({ page, api, cleanup }) => {
    const card = await openApprovalChat(page, api, cleanup)
    const sidebar = page.getByTestId(testIds.sidebar)
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')
    await expectTouchTarget(sidebar.getByTestId(testIds.projectSwitcher), 'the expanded project switcher')
    await expectTouchTarget(page.getByTestId(testIds.chatProjectChip), 'the project chip')
    await expectTouchTarget(card.getByTestId(testIds.toolApprovalDeny), 'Deny')
    await expectTouchTarget(card.getByTestId(testIds.toolApprovalAllow), 'Allow')
    await expect(card.getByTestId(testIds.toolApprovalAcceptEdits)).toBeVisible()
  })

  // The checkbox's hit area (its ::after, inset from the 14 px padding box) grows to 40 px on a coarse pointer (fixed at
  // the final gate of Phase 7).
  test('the "Accept all edits in this chat" checkbox is at least 40x40 px', async ({ page, api, cleanup }) => {
    const card = await openApprovalChat(page, api, cleanup)
    await expectTouchTarget(card.getByTestId(testIds.toolApprovalAcceptEdits), 'the "Accept all edits in this chat" checkbox')
  })
})

test.describe('tablet touch targets of the changes panel, rewind and shell rules', () => {
  test('the changes toggle, a row, Revert and "Rewind files to here" are at least 40x40 px', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Tablet changes ${uniqueId('tablet')}`, files: { [MOCK_CHECKPOINT_FILE]: 'Original line.\n' } })
    const chat = await api.createChat({ title: `Tablet changes ${uniqueId('chat')}`, projectId: project.id, modelRef: 'mock:checkpoint' })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: 'mock:checkpoint', toolMode: 'auto', text: 'Write the checkpoint.' })).text).toBe(MOCK_CHECKPOINT_DONE)

    await page.goto(`/chat/${chat.id}`)
    await expect(page.getByTestId(testIds.messageAssistant).last()).toContainText(MOCK_CHECKPOINT_DONE)
    const toggle = changesToggle(page)
    await expectTouchTarget(toggle, 'the changes toggle')
    await expectTouchTarget(userMessages(page).first().getByTestId(testIds.messageRewind), 'Rewind files to here')

    // 1024 px: the desktop pane, with touch-sized controls.
    await toggle.tap()
    await expect(changesPane(page)).toBeVisible()
    const panel = changesPanel(page)
    await expect(panel).toHaveAttribute('data-variant', 'pane')
    await expectTouchTarget(panel.getByTestId(testIds.changesClose), 'Close changes')
    await expectTouchTarget(panel.getByTestId(testIds.changesRefresh), 'Refresh changes')
    const row = changesFile(page, MOCK_CHECKPOINT_FILE)
    await expect.poll(async () => (await touchTargetSize(changesFileButton(row))).height, { message: 'the row height' }).toBeGreaterThanOrEqual(MIN_TARGET)
    const revert = byTestId(row, testIds.changesFileRevert, { 'data-path': MOCK_CHECKPOINT_FILE })
    await expectTouchTarget(revert, 'Revert file')
    expect(await revert.evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).opacity), 'Revert shows without hover').toBe('1')
    const handle = page.getByTestId(testIds.changesResize)
    await expect.poll(async () => (await touchTargetSize(handle)).width, { message: 'the resize handle hit area' }).toBeGreaterThanOrEqual(24)
  })

  test('the shell card\'s rule checkbox, prefix and scope options are at least 40x40 px', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Tablet rules ${uniqueId('tablet')}` })
    const chat = await api.createChat({ title: `Tablet rules ${uniqueId('chat')}`, projectId: project.id, modelRef: 'mock:shell' })
    cleanup(api => api.removeChat(chat.id))
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:shell', toolMode: 'ask', text: 'echo tablet' })

    await page.goto(`/chat/${chat.id}`)
    const card = byTestId(page, testIds.toolApproval, { 'data-tool-name': 'shell' })
    await expect(card).toBeVisible()
    const allowRule = card.getByTestId(testIds.toolApprovalAllowRule)
    await expectTouchTarget(allowRule, 'the "Always allow commands starting with" checkbox')
    await allowRule.tap()
    await expect(allowRule).toHaveAttribute('data-state', 'checked')
    const prefix = card.getByTestId(testIds.toolApprovalRulePrefix)
    await expect(prefix).toHaveValue('echo')
    await expect.poll(async () => (await touchTargetSize(prefix)).height, { message: 'the prefix input height' }).toBeGreaterThanOrEqual(MIN_TARGET)
    const scope = card.getByTestId(testIds.toolApprovalRuleScope)
    for (const value of ['project', 'global'])
      await expectTouchTarget(scope.locator(`[data-value="${value}"]`), `the scope option ${value}`)
    await expectTouchTarget(card.getByTestId(testIds.toolApprovalAllow), 'Run')
  })
})
