// Touch tablets (docs/UI.md 14.5, 14.7; S9, W6.11), project `tablet` (Galaxy Tab S9 landscape: 1024x640, touch, so
// `pointer: coarse` matches and the sidebar is not a sheet): the collapsed icon rail is 3.5rem (56 px) wide instead of
// 3rem, and every button of it is a touch target of at least 40x40 px, in the chat, plugins and settings modes (the
// project switcher of the chat mode among them). Phase 7 (W7.14): in a project chat the expanded sidebar's project
// switcher, the header's project chip and the controls of a workspace approval card (Deny, Allow, "Accept all edits in
// this chat") are 40 px targets too. Phase 8 (W8.12): the changes toggle, the pane's Close and Refresh, a changes row and
// its Revert (shown without hover), "Rewind files to here", and on a shell card the "Always allow commands starting
// with" checkbox, the prefix input and both scope options are 40 px targets (at 1024 px the panel is the desktop pane).
// Phase 9 (W9.13): the todo strip toggle, the queue's Edit and Cancel and "Queue message" while a reply runs, and the
// sub-agent trigger, the plan card's buttons and the `@` mention rows are 40 px targets.
// Phase 10 (W10.13): with two running background agents the dock's toggle, a row's Stop and Stop all; the Remember
// dialog's targets, Save and Cancel; the `⋯` menus of Settings -> Customize and the editor's footer (Cancel, Save) are
// 40 px targets.
// Phase 11 (W11.13, docs/UI.md 7.32, 7.33, 9.13): the hook rows' `⋯` menus, the trust dialog's checkboxes and Approve,
// the MCP servers dialog's Reconnect and variable input, and the composer's output style trigger and options are 40 px
// targets.
import type { Locator, Page } from '@playwright/test'
import type { CleanupTask, HarnessApi } from '../../helpers/index.ts'
import {
  approveProjectItems,
  backgroundAgents,
  boxOf,
  byTestId,
  changesFile,
  changesFileButton,
  changesPane,
  changesPanel,
  changesToggle,
  composer,
  createPersonalDefinition,
  customizationRow,
  customizeSection,
  definitionFile,
  expect,
  expectMessageStatus,
  hookGroup,
  hookRow,
  lastAssistantMessage,
  mcpVariable,
  MOCK_BACKGROUND_MODEL,
  MOCK_CHECKPOINT_DONE,
  MOCK_CHECKPOINT_FILE,
  seedHookProjectChat,
  seedProject,
  seedProjectChat,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
  useAgentSettings,
  userMessages,
  waitForChatTask,
  writeHookScript,
  writeProjectFile,
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

test.describe('tablet touch targets of the agent controls', () => {
  test('the todo strip toggle, the queue\'s Edit and Cancel and "Queue message" are at least 40x40 px', async ({ page, api, cleanup }) => {
    const chat = await api.createChat({ title: `Tablet dock ${uniqueId('dock')}`, modelRef: 'mock:todo' })
    cleanup(api => api.removeChat(chat.id))
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:todo', toolMode: 'ask', text: 'Do the three tasks.' })
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:steer', toolMode: 'ask', text: 'Ready.' })

    await page.goto(`/chat/${chat.id}`)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await page.getByTestId(testIds.composerInput).fill('steps 12')
    await page.getByTestId(testIds.composerSend).tap()
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'streaming')
    await expectTouchTarget(page.getByTestId(testIds.todoStripToggle), 'the todo strip toggle')
    await page.getByTestId(testIds.composerInput).fill('/compact')
    await expectTouchTarget(page.getByTestId(testIds.composerQueue), 'Queue message')
    await page.getByTestId(testIds.composerQueue).tap()
    const list = page.getByTestId(testIds.queuedMessages)
    await expect(list).toHaveAttribute('data-count', '1')
    await expectTouchTarget(list.getByTestId(testIds.queuedMessageEdit), 'Edit queued message')
    await expectTouchTarget(list.getByTestId(testIds.queuedMessageCancel), 'Cancel queued message')
    await page.getByTestId(testIds.composerStop).tap()
    await expectMessageStatus(reply, 'aborted')
    await page.getByTestId(testIds.composerInput).fill('')
  })

  test('the sub-agent trigger, the plan buttons and the mention rows are at least 40 px', async ({ page, api, cleanup }) => {
    await useAgentSettings(api, cleanup, { subagentModelRef: 'mock:subagent' })
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: 'mock:plan', prefix: 'tablet', files: { 'README.md': '# Tablet\n' } })
    await api.sendChat({ chatId, modelRef: 'mock:subagent', toolMode: 'ask', text: 'Explore the project.' })
    await api.sendChat({ chatId, modelRef: 'mock:plan', toolMode: 'plan', text: 'Plan the notes file.' })

    await page.goto(`/chat/${chatId}`)
    const card = page.getByTestId(testIds.planApproval)
    await expect(card).toBeVisible()
    for (const [id, name] of [[testIds.planApproveEdits, 'Approve, accept edits'], [testIds.planApproveAsk, 'Approve, ask before edits'], [testIds.planKeepPlanning, 'Keep planning']] as const)
      await expectTouchTarget(card.getByTestId(id), name)
    const triggers = page.getByTestId(testIds.taskBlockTrigger)
    await expect(triggers).toHaveCount(2)
    for (const trigger of await triggers.all())
      await expectTouchTarget(trigger, 'a sub-agent trigger')

    await page.getByTestId(testIds.composerInput).tap()
    await page.keyboard.type('@')
    const menu = page.getByTestId(testIds.mentionMenu)
    await expect(menu).toHaveAttribute('data-state', 'ready')
    const rows = menu.getByTestId(testIds.mentionMenuItem)
    await expect(rows.first()).toBeVisible()
    for (const row of await rows.all())
      expect((await touchTargetSize(row)).height, 'a mention row height').toBeGreaterThanOrEqual(MIN_TARGET)
    await page.keyboard.press('Escape')
    await page.getByTestId(testIds.composerInput).fill('')
  })
})

test.describe('tablet touch targets of the customization controls', () => {
  test('the background agents\' toggle, Stop and Stop all, and the Remember dialog are at least 40 px', async ({ page, api, cleanup }) => {
    await useAgentSettings(api, cleanup, { subagentModelRef: null })
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: MOCK_BACKGROUND_MODEL, prefix: 'tablet' })
    for (const type of ['explore', 'general'])
      await api.sendChat({ chatId, modelRef: MOCK_BACKGROUND_MODEL, toolMode: 'ask', text: `bg ${type} loop` })
    await waitForChatTask(api, chatId, task => task.status === 'running' && task.output.type === 'general')

    await page.goto(`/chat/${chatId}`)
    const dock = backgroundAgents(page)
    await expect(dock).toHaveAttribute('data-count', '2')
    // 1024 px: open by default.
    await expect(dock).toHaveAttribute('data-state', 'open')
    const toggle = dock.getByTestId(testIds.backgroundAgentsToggle)
    await expectTouchTarget(toggle, 'the dock toggle')
    await expectTouchTarget(dock.getByTestId(testIds.backgroundAgentsStopAll), 'Stop all')
    const rows = dock.getByTestId(testIds.backgroundAgent)
    await expect(rows).toHaveCount(2)
    for (const row of await rows.all())
      await expectTouchTarget(row.getByTestId(testIds.backgroundAgentStop), 'a row Stop')
    await dock.getByTestId(testIds.backgroundAgentsStopAll).tap()
    await expect(byTestId(dock, testIds.backgroundAgent, { 'data-state': 'aborted' })).toHaveCount(2)

    // The Remember dialog of the project chat.
    const input = page.getByTestId(testIds.composerInput)
    await input.fill('/remember Run the tests before every push.')
    await page.getByTestId(testIds.composerSend).tap()
    const dialog = page.getByTestId(testIds.rememberDialog)
    await expect(dialog).toBeVisible()
    const targets = dialog.getByTestId(testIds.rememberTarget)
    await expect(targets).toHaveCount(3)
    for (const target of await targets.all())
      await expectTouchTarget(target, 'a Remember target')
    await expectTouchTarget(dialog.getByTestId(testIds.rememberSave), 'Save')
    await expectTouchTarget(dialog.getByRole('button', { name: 'Cancel' }), 'Cancel')
    await dialog.getByRole('button', { name: 'Cancel' }).tap()
    await expect(dialog).toBeHidden()
  })

  test('the Customize row menus and the editor\'s footer are at least 40 px', async ({ page, api, cleanup }) => {
    const name = uniqueId('tablet-agent')
    await createPersonalDefinition(api, cleanup, { kind: 'agent', name, content: definitionFile({ name, description: 'An agent on a tablet.' }, 'PERSONA: tablet\n') })
    await page.goto('/settings/customize?tab=agents')
    const row = customizationRow(customizeSection(page, 'user'), { 'data-name': name })
    await expect(row).toBeVisible()
    for (const menu of await page.getByTestId(testIds.customizationRowMenu).all())
      await expectTouchTarget(menu, 'a row menu')

    await page.getByTestId(testIds.customizeNew).tap()
    const editor = page.getByTestId(testIds.customizationEditor)
    await expect(editor).toHaveAttribute('data-mode', 'new')
    const save = editor.getByTestId(testIds.customizationSave)
    const cancel = editor.getByRole('button', { name: 'Cancel' })
    for (const [target, label] of [[save, 'Save'], [cancel, 'Cancel']] as const) {
      await expect(target).toBeVisible()
      await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${label} height` }).toBeGreaterThanOrEqual(MIN_TARGET)
    }
    await expectTouchTarget(editor.getByTestId(testIds.customizationModel), 'the model select')
    for (const radio of await editor.getByTestId(testIds.customizationToolsMode).getByRole('radio').all())
      await expect.poll(async () => (await boxOf(radio.locator('xpath=..'))).height, { message: 'a tools option height' }).toBeGreaterThanOrEqual(MIN_TARGET)
    await cancel.tap()
    await expect(editor).toBeHidden()
  })
})

test.describe('tablet touch targets of hooks, trust, project MCP and output styles', () => {
  test('the hook row menus, the trust checkboxes and Approve, Reconnect, a variable input and the style menu are at least 40 px', async ({ page, api, cleanup }) => {
    const { project, folder, chatId } = await seedHookProjectChat(api, cleanup, {
      prefix: 'tablet-hooks',
      scripts: [['record', { file: 'approved' }]],
      hooks: commands => ({ PostToolUse: [hookGroup(commands.approved!, { matcher: 'Write' })] }),
      files: { '.mcp.json': `${JSON.stringify({ mcpServers: { echo: { command: 'node', args: ['tools/echo.mjs'], env: { TOKEN: mcpVariable('TOKEN', 'abc') } } } })}\n` },
    })
    await approveProjectItems(api, project.id, item => item.kind === 'mcp')
    // A second settings file adds a hook that waits for its approval.
    const pending = await writeHookScript(folder.path, 'record', { file: 'pending' })
    await writeProjectFile(folder.path, '.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [hookGroup(pending)] } }))

    // The Hooks tab: every row menu; Review… opens the trust dialog.
    await page.goto(`/settings/customize?tab=hooks&project=${project.id}`)
    const section = byTestId(page, testIds.hooksSection, { 'data-source': 'project' })
    await expect(hookRow(section, { 'data-state': 'pending' })).toBeVisible()
    for (const menu of await page.getByTestId(testIds.hookRowMenu).all())
      await expectTouchTarget(menu, 'a hook row menu')
    await section.getByTestId(testIds.customizeTrustReview).tap()
    const trust = page.getByTestId(testIds.projectTrustDialog)
    const item = byTestId(trust, testIds.projectTrustItem, { 'data-kind': 'hook', 'data-state': 'new' })
    await expect(item).toBeVisible()
    await expectTouchTarget(item.getByTestId(testIds.projectTrustSelect), 'an item checkbox')
    await expectTouchTarget(trust.getByTestId(testIds.projectTrustSelectAll).first(), 'Select all')
    await item.getByTestId(testIds.projectTrustSelect).tap()
    await expect(trust.getByTestId(testIds.projectTrustApprove)).toHaveAttribute('data-count', '1')
    await expectTouchTarget(trust.getByTestId(testIds.projectTrustApprove), 'Approve')
    await page.keyboard.press('Escape')
    await expect(trust).toBeHidden()

    // The MCP servers dialog of the chat: Reconnect of the approved (idle) server and its variable's input.
    await page.goto(`/chat/${chatId}`)
    await page.getByTestId(testIds.chatProjectChip).tap()
    await page.getByTestId(testIds.chatProjectMcp).tap()
    const mcp = page.getByTestId(testIds.projectMcpDialog)
    const server = byTestId(mcp, testIds.projectMcpServer, { 'data-server-id': 'echo' })
    await expect(server).toHaveAttribute('data-state', 'idle')
    await expectTouchTarget(server.getByTestId(testIds.projectMcpReconnect), 'Reconnect')
    const variables = mcp.getByTestId(testIds.projectMcpVariables)
    const toggle = variables.getByRole('button', { name: /^Variables/ })
    if (await toggle.getAttribute('aria-expanded') !== 'true')
      await toggle.tap()
    const variable = byTestId(variables, testIds.projectMcpVariable, { 'data-name': 'TOKEN' })
    await expect(variable).toHaveAttribute('data-state', 'default')
    await expect.poll(async () => (await touchTargetSize(variable.getByRole('textbox'))).height, { message: 'the variable input height' }).toBeGreaterThanOrEqual(MIN_TARGET)
    await page.keyboard.press('Escape')
    await expect(mcp).toBeHidden()

    // The composer's output style trigger and its options.
    const trigger = composer(page).getByTestId(testIds.outputStyleTrigger)
    await expectTouchTarget(trigger, 'the output style trigger')
    await trigger.tap()
    const options = page.getByTestId(testIds.outputStyleOption)
    await expect(options.first()).toBeVisible()
    for (const option of await options.all())
      await expect.poll(async () => (await boxOf(option)).height, { message: 'a style option height' }).toBeGreaterThanOrEqual(MIN_TARGET)
    await page.keyboard.press('Escape')
    await expect(options).toHaveCount(0)
  })
})
