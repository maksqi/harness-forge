// Projects and workspace tools on a phone (docs/UI.md 7.19, 7.20, 14.5, 14.6), project `mobile` (Pixel 7 at 390x844,
// touch): the project switcher is the first row of the sidebar sheet and picking a filter keeps the sheet open; the
// new-chat project pill and the header chip are 40 px touch targets, the chip shows only its icon; an expanded diff with
// a long line scrolls inside its own block, so the page never scrolls sideways.
import type { Locator, Page } from '@playwright/test'
import {
  boxOf,
  byTestId,
  chatRow,
  documentWidths,
  expect,
  lastAssistantMessage,
  MOCK_WORKSPACE_DONE,
  MOCK_WORKSPACE_FILE,
  seedProject,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
  wordList,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }

async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  // Sizes are polled: menus and dialogs zoom in from 95%.
  await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${name} height` }).toBeGreaterThanOrEqual(40)
  expect((await touchTargetSize(target)).width, `${name} width`).toBeGreaterThanOrEqual(40)
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${where} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

test.describe('mobile projects', () => {
  test('the switcher filters inside the sheet; the new-chat pill picks a project', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Phone ${uniqueId('phone')}` })
    const token = uniqueId('chats')
    const inProject = await api.createChat({ title: `Phone project ${token}`, projectId: project.id })
    cleanup(api => api.removeChat(inProject.id))
    const outside = await api.createChat({ title: `Phone outside ${token}` })
    cleanup(api => api.removeChat(outside.id))

    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    // The new-chat pill: a 40 px target whose menu lists No project and the project.
    const pill = page.getByTestId(testIds.newChatProject)
    await expect(pill).toHaveAttribute('data-value', 'none')
    await expectTouchTarget(pill, 'the new-chat project pill')
    await pill.tap()
    const option = byTestId(page, testIds.projectOption, { 'data-value': project.id })
    await expectTouchTarget(option, 'a project option')
    await option.tap()
    await expect(pill).toHaveAttribute('data-value', project.id)
    await expect(pill).toContainText(project.name)
    await expectNoSidewaysScroll(page, 'the new chat with a project')

    // The switcher is the first row of the sheet.
    await page.getByTestId(testIds.sidebarTrigger).tap()
    const sidebar = page.getByTestId(testIds.sidebar)
    await expect(sidebar).toBeVisible()
    const switcher = sidebar.getByTestId(testIds.projectSwitcher)
    await expectTouchTarget(switcher, 'the project switcher')
    await expect(chatRow(page, inProject.id)).toBeVisible()
    await expect(chatRow(page, outside.id)).toBeVisible()
    await switcher.tap()
    const filter = byTestId(page, testIds.projectSwitcherOption, { 'data-value': project.id })
    await expectTouchTarget(filter, 'a switcher option')
    // The menu fits the screen.
    const menu = await boxOf(page.getByRole('menu'))
    expect(menu.x, 'the switcher menu left edge').toBeGreaterThanOrEqual(0)
    expect(menu.x + menu.width, 'the switcher menu right edge').toBeLessThanOrEqual(VIEWPORT.width)
    await filter.tap()

    // Picking a filter keeps the sheet open and filters the list.
    await expect(switcher).toHaveAttribute('data-value', project.id)
    await expect(sidebar).toBeVisible()
    await expect(chatRow(page, inProject.id)).toBeVisible()
    await expect(chatRow(page, outside.id)).toHaveCount(0)
  })

  test('the chip shows only its icon and a long diff line scrolls inside its block', async ({ page, api, cleanup }) => {
    // The file exists with a long line, so the write of `mock:workspace` replaces it: its diff removes that line.
    const longLine = `const wide = ${JSON.stringify(wordList(60, 'segment').join('_'))}`
    const { project } = await seedProject(api, cleanup, {
      name: `Phone diff ${uniqueId('diff')}`,
      files: { [MOCK_WORKSPACE_FILE]: `${longLine}\n` },
    })
    const chat = await api.createChat({ title: `Phone diff ${uniqueId('chat')}`, projectId: project.id, modelRef: 'mock:workspace' })
    cleanup(api => api.removeChat(chat.id))
    const { text } = await api.sendChat({ chatId: chat.id, modelRef: 'mock:workspace', toolMode: 'auto', text: 'Go.' })
    expect(text).toBe(MOCK_WORKSPACE_DONE)

    await page.goto(`/chat/${chat.id}`)
    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText(MOCK_WORKSPACE_DONE)

    // The chip: icon-only below `sm`, named "Project: {name}", a 40 px target.
    const chip = page.getByTestId(testIds.chatProjectChip)
    await expect(chip).toHaveAttribute('data-value', project.id)
    await expect(chip).toHaveAccessibleName(`Project: ${project.name}`)
    await expectTouchTarget(chip, 'the project chip')
    expect((await boxOf(chip)).width, 'the chip is icon-only').toBeLessThanOrEqual(44)

    // The write row expands to a diff whose long line scrolls inside the diff block.
    const writeRow = byTestId(reply, testIds.toolRow, { 'data-tool-name': 'write_file' })
    await expect(writeRow).toHaveAttribute('data-state', 'output-available')
    await writeRow.getByRole('button').tap()
    const diff = reply.getByTestId(testIds.diffView).first()
    await expect(diff).toBeVisible()
    await expect(byTestId(diff, testIds.diffLine, { 'data-kind': 'del' })).toContainText('segment1_segment2_segment3')
    const box = await boxOf(diff)
    expect(box.x + box.width, 'the diff block fits the screen').toBeLessThanOrEqual(VIEWPORT.width)
    const scroller = await diff.evaluate((root) => {
      const block = [...root.querySelectorAll('*')].find(node => root.ownerDocument.defaultView!.getComputedStyle(node).overflowX === 'auto')
      return block ? { scrollWidth: block.scrollWidth, clientWidth: block.clientWidth } : null
    })
    expect(scroller, 'the diff has its own horizontal scroller').not.toBeNull()
    expect(scroller!.scrollWidth, 'the long line overflows the block, not the page').toBeGreaterThan(scroller!.clientWidth)
    await expectNoSidewaysScroll(page, 'the chat with an open diff')
  })
})
