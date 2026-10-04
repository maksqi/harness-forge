// Agent 2.0 on a phone (docs/UI.md 2.16, 14.5, 14.6), project `mobile` (Pixel 7 at 390x844, touch):
// - The composer dock fits the screen while a reply runs: the todo strip (collapsed), the queued messages and the
//   composer, with 40 px targets (the strip toggle, the queue's Edit and Cancel, "Queue message").
// - An expanded sub-agent block and an expanded compaction summary never make the page scroll sideways; their toggles
//   are 40 px targets and the divider hides its meta line.
// - The plan card's buttons stack full width, 40 px tall, "Approve, accept edits" on top.
// - The `@` mention menu spans the composer inside the screen, with 40 px rows.
// Phase 10 (W10.13, docs/UI.md 7.29, 7.30, 14.6): while a `mock:steer` reply runs after a finished `mock:todo` list and
// with a running background agent, the strip, the background agents (collapsed: one 40 px line), the queue and the
// composer lie inside the screen in that order; opened, the agent's row Stop and Stop all are 40 px targets and nothing
// scrolls sideways. The Remember dialog fits the screen with 40 px targets; the grouped slash menu spans the composer
// inside the screen, at most 40 % of its height.
import type { Locator, Page } from '@playwright/test'
import {
  backgroundAgents,
  boxOf,
  byTestId,
  documentWidths,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  MOCK_BACKGROUND_MODEL,
  seedProjectChat,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
  useAgentSettings,
  waitForChatTask,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }

async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${name} height` }).toBeGreaterThanOrEqual(40)
  expect((await touchTargetSize(target)).width, `${name} width`).toBeGreaterThanOrEqual(40)
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${where} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

/** The element lies inside the screen (polled: the dock and menus animate in). */
async function expectInsideViewport(target: Locator, name: string): Promise<void> {
  await expect.poll(async () => {
    const box = await boxOf(target)
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= VIEWPORT.width + 0.5 && box.y + box.height <= VIEWPORT.height + 0.5
  }, { message: `${name} fits the screen` }).toBe(true)
}

test.describe('mobile agent', () => {
  test('the dock fits while a reply runs: the todo strip, the queue and the composer with 40 px targets', async ({ page, api, cleanup }) => {
    const chat = await api.createChat({ title: `Phone dock ${uniqueId('dock')}`, modelRef: 'mock:todo' })
    cleanup(api => api.removeChat(chat.id))
    // A finished todo list on the path (the strip shows it while a later reply runs), then the steer model.
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:todo', toolMode: 'ask', text: 'Do the three tasks.' })
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:steer', toolMode: 'ask', text: 'Ready.' })

    await page.goto(`/chat/${chat.id}`)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await page.getByTestId(testIds.composerInput).fill('steps 12')
    await page.getByTestId(testIds.composerSend).tap()
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'streaming')

    const strip = page.getByTestId(testIds.todoStrip)
    await expect(strip).toHaveAttribute('data-state', 'closed')
    await expect(strip.getByTestId(testIds.todoStripToggle)).toHaveText('All tasks done')
    await expectTouchTarget(strip.getByTestId(testIds.todoStripToggle), 'the todo strip toggle')

    // A server command waits in the queue: Edit and Cancel are 40 px targets.
    await page.getByTestId(testIds.composerInput).fill('/compact')
    await expectTouchTarget(page.getByTestId(testIds.composerQueue), 'Queue message')
    await page.getByTestId(testIds.composerQueue).tap()
    const list = page.getByTestId(testIds.queuedMessages)
    await expect(list).toHaveAttribute('data-count', '1')
    await expectTouchTarget(list.getByTestId(testIds.queuedMessageEdit), 'Edit queued message')
    await expectTouchTarget(list.getByTestId(testIds.queuedMessageCancel), 'Cancel queued message')

    // Strip, queue and composer are inside the screen, stacked in that order, and nothing scrolls sideways.
    const composer = page.getByTestId(testIds.composer)
    for (const [target, name] of [[strip, 'the strip'], [list, 'the queue'], [composer, 'the composer']] as const)
      await expectInsideViewport(target, name)
    const [stripBox, listBox, composerBox] = [await boxOf(strip), await boxOf(list), await boxOf(composer)]
    expect(stripBox.y + stripBox.height, 'the strip is above the queue').toBeLessThanOrEqual(listBox.y + 1)
    expect(listBox.y + listBox.height, 'the queue is above the composer').toBeLessThanOrEqual(composerBox.y + 1)
    await expectNoSidewaysScroll(page, 'the dock')

    await page.getByTestId(testIds.composerStop).tap()
    await expectMessageStatus(reply, 'aborted')
    await expect(list).toHaveCount(0)
    await expect(page.getByTestId(testIds.composerInput)).toHaveValue('/compact')
    await page.getByTestId(testIds.composerInput).fill('')
  })

  test('an expanded sub-agent block or compaction summary never scrolls the page sideways', async ({ page, api, cleanup }) => {
    await useAgentSettings(api, cleanup, { subagentModelRef: 'mock:subagent', compactModelRef: 'mock:compact' })
    const longName = `${'a-very-long-file-name-that-does-not-wrap'.repeat(3)}.ts`
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: 'mock:subagent', prefix: 'phone', files: { [`src/${longName}`]: 'export {}\n' } })
    await api.sendChat({ chatId, modelRef: 'mock:subagent', toolMode: 'ask', text: 'Explore the project.' })
    await api.sendChat({ chatId, modelRef: 'mock:echo', toolMode: 'off', text: 'OLD-1 Something to compact later.' })
    await api.sendChat({ chatId, modelRef: 'mock:compact', toolMode: 'ask', text: '/compact keep the file names' })

    await page.goto(`/chat/${chatId}`)
    await expectMessageStatus(lastAssistantMessage(page), 'done')

    // The compaction summary: a 40 px toggle, no meta line on the phone, no sideways scroll when open.
    const divider = lastAssistantMessage(page).getByTestId(testIds.compactionDivider)
    await expect(divider.locator('[data-slot="compaction-meta"]')).toBeHidden()
    const toggle = divider.getByTestId(testIds.compactionToggle)
    await expectTouchTarget(toggle, 'Show summary')
    await toggle.tap()
    const summary = divider.getByTestId(testIds.compactionSummary)
    await expect(summary).toBeVisible()
    const summaryBox = await boxOf(summary)
    expect(summaryBox.x + summaryBox.width, 'the summary fits the screen').toBeLessThanOrEqual(VIEWPORT.width)
    await expectNoSidewaysScroll(page, 'the open summary')

    // A sub-agent block: a 40 px trigger; expanded, its steps and report stay inside the column.
    const block = byTestId(page, testIds.taskBlock, { 'data-kind': 'explore' })
    await block.scrollIntoViewIfNeeded()
    const trigger = block.getByTestId(testIds.taskBlockTrigger)
    await expect.poll(async () => (await touchTargetSize(trigger)).height, { message: 'the task trigger height' }).toBeGreaterThanOrEqual(40)
    await trigger.tap()
    await expect(block.getByTestId(testIds.taskReport)).toBeVisible()
    await expect(block.getByTestId(testIds.taskStep)).toHaveCount(1)
    const blockBox = await boxOf(block)
    expect(blockBox.x + blockBox.width, 'the block fits the screen').toBeLessThanOrEqual(VIEWPORT.width)
    await expectNoSidewaysScroll(page, 'the expanded sub-agent block')
  })

  test('the plan card\'s buttons stack full width, 40 px tall, "Approve, accept edits" on top', async ({ page, api, cleanup }) => {
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: 'mock:plan', prefix: 'phone' })
    await api.sendChat({ chatId, modelRef: 'mock:plan', toolMode: 'plan', text: 'Plan the notes file.' })

    await page.goto(`/chat/${chatId}`)
    const card = page.getByTestId(testIds.planApproval)
    await expect(card).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    const [edits, ask, keep] = [card.getByTestId(testIds.planApproveEdits), card.getByTestId(testIds.planApproveAsk), card.getByTestId(testIds.planKeepPlanning)]
    for (const [button, name] of [[edits, 'Approve, accept edits'], [ask, 'Approve, ask before edits'], [keep, 'Keep planning']] as const)
      await expectTouchTarget(button, name)
    const [editsBox, askBox, keepBox] = [await boxOf(edits), await boxOf(ask), await boxOf(keep)]
    expect(editsBox.y, 'Approve, accept edits is on top').toBeLessThan(askBox.y)
    expect(askBox.y, 'Keep planning is last').toBeLessThan(keepBox.y)
    for (const box of [askBox, keepBox]) {
      expect(Math.round(box.x)).toBe(Math.round(editsBox.x))
      expect(Math.round(box.width), 'the buttons share the full width').toBe(Math.round(editsBox.width))
    }
    const cardBox = await boxOf(card)
    expect(editsBox.width, 'full width of the card').toBeGreaterThan(cardBox.width * 0.8)
    await expectInsideViewport(card.getByTestId(testIds.planApprovalPlan), 'the plan')
    await expectNoSidewaysScroll(page, 'the plan card')
  })

  test('the mention menu spans the composer inside the screen with 40 px rows', async ({ page, api, cleanup }) => {
    const files = { 'README.md': '# Phone\n', 'src/parser.ts': 'export {}\n', 'src/lexer.ts': 'export {}\n' }
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: 'mock:echo', prefix: 'phone', files })
    await page.goto(`/chat/${chatId}`)
    const input = page.getByTestId(testIds.composerInput)
    await input.tap()
    await page.keyboard.type('@')
    const menu = page.getByTestId(testIds.mentionMenu)
    await expect(menu).toHaveAttribute('data-state', 'ready')
    const rows = menu.getByTestId(testIds.mentionMenuItem)
    // README.md, src/ and its two files.
    await expect(rows).toHaveCount(4)
    await expectInsideViewport(menu, 'the mention menu')
    const menuBox = await boxOf(menu)
    const composerBox = await boxOf(page.getByTestId(testIds.composer))
    expect(Math.round(menuBox.width), 'the menu spans the composer').toBe(Math.round(composerBox.width))
    for (const row of await rows.all())
      expect((await touchTargetSize(row)).height, 'a mention row height').toBeGreaterThanOrEqual(40)
    await expectNoSidewaysScroll(page, 'the mention menu')
    await byTestId(menu, testIds.mentionMenuItem, { 'data-path': 'src/parser.ts' }).tap()
    await expect(input).toHaveValue('@src/parser.ts ')
    await expect(menu).toHaveCount(0)
    await input.fill('')
  })

  test('the dock fits with a running background agent: strip, background agents, queue and composer; 40 px stops', async ({ page, api, cleanup }) => {
    await useAgentSettings(api, cleanup, { subagentModelRef: null })
    const chat = await api.createChat({ title: `Phone background ${uniqueId('dock')}`, modelRef: 'mock:todo' })
    cleanup(api => api.removeChat(chat.id))
    // A finished todo list, a background agent that runs until it is stopped, then the steer model.
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:todo', toolMode: 'ask', text: 'Do the three tasks.' })
    await api.sendChat({ chatId: chat.id, modelRef: MOCK_BACKGROUND_MODEL, toolMode: 'ask', text: 'bg explore loop' })
    const task = await waitForChatTask(api, chat.id, item => item.status === 'running')
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:steer', toolMode: 'ask', text: 'Ready.' })

    await page.goto(`/chat/${chat.id}`)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await page.getByTestId(testIds.composerInput).fill('steps 12')
    await page.getByTestId(testIds.composerSend).tap()
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'streaming')
    await page.getByTestId(testIds.composerInput).fill('/compact')
    await page.getByTestId(testIds.composerQueue).tap()
    const list = page.getByTestId(testIds.queuedMessages)
    await expect(list).toHaveAttribute('data-count', '1')

    // Collapsed below md: one 40 px line between the strip and the queue.
    const strip = page.getByTestId(testIds.todoStrip)
    const dock = backgroundAgents(page)
    await expect(dock).toHaveAttribute('data-state', 'closed')
    await expect(dock).toHaveAttribute('data-count', '1')
    const toggle = dock.getByTestId(testIds.backgroundAgentsToggle)
    await expect(toggle).toContainText('1 background agent · Background explore')
    await expect.poll(async () => (await touchTargetSize(toggle)).height, { message: 'the dock toggle height' }).toBeGreaterThanOrEqual(40)
    const composer = page.getByTestId(testIds.composer)
    for (const [target, name] of [[strip, 'the strip'], [dock, 'the background agents'], [list, 'the queue'], [composer, 'the composer']] as const)
      await expectInsideViewport(target, name)
    const boxes = [await boxOf(strip), await boxOf(dock), await boxOf(list), await boxOf(composer)]
    for (let index = 1; index < boxes.length; index++)
      expect(boxes[index - 1]!.y + boxes[index - 1]!.height, `dock part ${index - 1} is above part ${index}`).toBeLessThanOrEqual(boxes[index]!.y + 1)
    await expectNoSidewaysScroll(page, 'the dock with background agents')

    // Opened: the row's Stop and Stop all are 40 px targets.
    await toggle.tap()
    await expect(dock).toHaveAttribute('data-state', 'open')
    const row = byTestId(dock, testIds.backgroundAgent, { 'data-task-id': task.id })
    await expectTouchTarget(row.getByTestId(testIds.backgroundAgentStop), 'the row Stop')
    await expect.poll(async () => (await touchTargetSize(dock.getByTestId(testIds.backgroundAgentsStopAll))).height, { message: 'Stop all height' }).toBeGreaterThanOrEqual(40)
    await expectInsideViewport(dock, 'the open background agents')
    await expectNoSidewaysScroll(page, 'the open background agents')
    await row.getByTestId(testIds.backgroundAgentStop).tap()
    await expect(row).toHaveAttribute('data-state', 'aborted')

    await page.getByTestId(testIds.composerStop).tap()
    await expectMessageStatus(reply, 'aborted')
    await page.getByTestId(testIds.composerInput).fill('')
  })

  test('the Remember dialog and the grouped slash menu fit the screen', async ({ page, api, cleanup }) => {
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: 'mock:echo', prefix: 'phone' })
    await api.sendChat({ chatId, modelRef: 'mock:echo', text: 'Hello.' })
    await page.goto(`/chat/${chatId}`)
    const input = page.getByTestId(testIds.composerInput)

    // The grouped slash menu: inside the screen, spanning the composer, at most 40 % of the screen tall.
    await input.tap()
    await input.fill('/')
    const menu = page.getByTestId(testIds.slashMenu)
    await expect(menu).toBeVisible()
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': 'remember', 'data-group': 'app' })).toBeAttached()
    await expectInsideViewport(menu, 'the slash menu')
    expect(Math.round((await boxOf(menu)).width), 'the menu spans the composer').toBe(Math.round((await boxOf(page.getByTestId(testIds.composer))).width))
    expect((await boxOf(menu)).height, 'the menu is at most 40dvh').toBeLessThanOrEqual(VIEWPORT.height * 0.4 + 2)
    await expectNoSidewaysScroll(page, 'the slash menu')

    // The Remember dialog: inside the screen, 40 px targets.
    await input.fill('/remember Use pnpm, never npm, in this project.')
    await page.getByTestId(testIds.composerSend).tap()
    const dialog = page.getByTestId(testIds.rememberDialog)
    await expect(dialog).toBeVisible()
    await expectInsideViewport(dialog, 'the Remember dialog')
    for (const target of await dialog.getByTestId(testIds.rememberTarget).all())
      await expect.poll(async () => (await touchTargetSize(target)).height, { message: 'a target height' }).toBeGreaterThanOrEqual(40)
    await expect.poll(async () => (await touchTargetSize(dialog.getByTestId(testIds.rememberSave))).height, { message: 'Save height' }).toBeGreaterThanOrEqual(40)
    await expect.poll(async () => (await touchTargetSize(dialog.getByRole('button', { name: 'Cancel' }))).height, { message: 'Cancel height' }).toBeGreaterThanOrEqual(40)
    await expectNoSidewaysScroll(page, 'the Remember dialog')
    await dialog.getByRole('button', { name: 'Cancel' }).tap()
    await expect(dialog).toBeHidden()
  })
})
