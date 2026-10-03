// Plan mode (docs/UI.md 2.16, 7.11, 7.25, 12; ADR-041) with `mock:plan` (docs/PROVIDERS.md 8): in plan mode it
// writes two todos, lists the folder and calls `exit_plan_mode`; "Keep planning" with feedback brings `Revising: …` and
// a revised plan, an approval writes `notes.txt` and answers `Plan done in mode <mode>.`
// - The permission menu offers Plan only in project chats; Shift+Tab in the composer cycles Ask -> Accept edits ->
//   Plan -> Ask and announces each mode ("Permission mode: Plan"); `/mode plan` sets it; outside a project `/mode plan`
//   is refused and Shift+Tab is the native reverse focus move.
// - The plan card: Keep planning with feedback (the row reads "Kept planning" and keeps the feedback, a new card shows
//   the revised plan), then "Approve, accept edits": the mode becomes Accept edits, `write_file` runs without a card and
//   `notes.txt` is on disk and in the changes panel.
// - "Approve, ask before edits": the mode becomes Ask and the write asks first.
// - With the Shift+Tab switch off (Settings -> General) Shift+Tab moves the focus and keeps the mode.
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  byTestId,
  changesFile,
  changesPanel,
  changesToggle,
  composer,
  composerAnnouncement,
  expect,
  expectAnnounced,
  expectMessageStatus,
  lastAssistantMessage,
  MOCK_PLAN_FILE,
  MOCK_PLAN_FILE_CONTENT,
  MOCK_PLAN_HEADING,
  MOCK_PLAN_REVISED_HEADING,
  mockPlanDone,
  mockPlanRevising,
  openNewChat,
  recordAnnouncements,
  seedProjectChat,
  selectModel,
  selectPermissionMode,
  sendMessage,
  test,
  testIds,
  toastWith,
  useAgentSettings,
} from '../../helpers/index.ts'

const MODEL = 'mock:plan'

function permissionTrigger(page: Page) {
  return composer(page).getByTestId(testIds.permissionMenuTrigger)
}

function composerInput(page: Page) {
  return page.getByTestId(testIds.composerInput)
}

async function fileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return null
  }
}

/** Opens a project chat of `mock:plan`, switches it to Plan and sends a message: resolves when the plan card shows. */
async function planInProject(page: Page, chatId: string, text: string) {
  await page.goto(`/chat/${chatId}`)
  await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', MODEL)
  await selectPermissionMode(page, 'plan')
  const announced = await recordAnnouncements(page)
  await sendMessage(page, text)
  const reply = lastAssistantMessage(page)
  const card = reply.getByTestId(testIds.planApproval)
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-state', 'pending')
  return { reply, card, announced }
}

test.describe('plan mode', () => {
  test('Plan is offered in project chats only; Shift+Tab cycles the modes and /mode plan sets it @smoke', async ({ page, api, cleanup }) => {
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: MODEL, prefix: 'plan' })
    await page.goto(`/chat/${chatId}`)
    const trigger = permissionTrigger(page)
    await expect(trigger).toHaveAttribute('data-value', 'ask')

    // The menu of a project chat: Ask, Accept edits, Plan, Auto, Off.
    await trigger.click()
    const options = page.getByTestId(testIds.permissionOption)
    await expect(options).toHaveCount(5)
    await expect(byTestId(page, testIds.permissionOption, { 'data-value': 'plan' })).toContainText('Plan')
    await page.keyboard.press('Escape')
    await expect(options).toHaveCount(0)

    // Shift+Tab in the composer: Ask -> Accept edits -> Plan -> Ask, announced, the focus stays in the composer.
    const input = composerInput(page)
    await input.click()
    for (const [mode, label] of [['edits', 'Accept edits'], ['plan', 'Plan'], ['ask', 'Ask']] as const) {
      await page.keyboard.press('Shift+Tab')
      await expect(trigger).toHaveAttribute('data-value', mode)
      await expect(composerAnnouncement(page, `Permission mode: ${label}`)).toHaveCount(1)
      await expect(input).toBeFocused()
    }
    await expect(trigger).toHaveAccessibleName('Permission mode: Ask')

    // `/mode plan` sets it; the chat keeps it after a reload.
    await input.fill('/mode plan')
    await page.keyboard.press('Enter')
    await expect(trigger).toHaveAttribute('data-value', 'plan')
    await expect(input).toHaveValue('')
    await expect.poll(async () => (await api.getChat(chatId)).settings.toolMode, { message: 'the chat saved the mode' }).toBe('plan')
    await page.reload()
    await expect(trigger).toHaveAttribute('data-value', 'plan')

    // A chat without a project: no Plan in the menu, `/mode plan` is refused, Shift+Tab moves the focus.
    await openNewChat(page)
    await selectModel(page, MODEL)
    await expect(trigger).toHaveAttribute('data-value', 'ask')
    await trigger.click()
    await expect(options).toHaveCount(3)
    await expect(byTestId(page, testIds.permissionOption, { 'data-value': 'plan' })).toHaveCount(0)
    await expect(byTestId(page, testIds.permissionOption, { 'data-value': 'edits' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await input.fill('/mode plan')
    await page.keyboard.press('Enter')
    await expect(toastWith(page, 'Plan mode works in project chats.')).toBeVisible()
    await expect(trigger).toHaveAttribute('data-value', 'ask')
    await input.fill('')
    await input.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(input).not.toBeFocused()
    await expect(trigger).toHaveAttribute('data-value', 'ask')
  })

  test('Keep planning sends the feedback and a revised plan comes; Approve, accept edits writes without a card @smoke', async ({ page, api, cleanup }) => {
    const { chatId, folder } = await seedProjectChat(api, cleanup, { modelRef: MODEL, prefix: 'plan' })
    const { reply, card, announced } = await planInProject(page, chatId, 'Plan the notes file.')

    // The row of the call and the card: the plan in its own region, "from core-agent", three buttons, no write yet.
    const planRows = byTestId(reply, testIds.toolRow, { 'data-tool-name': 'exit_plan_mode' })
    await expect(planRows).toHaveCount(1)
    await expect(planRows.first()).toContainText('Plan ready for review')
    await expect(card).toHaveAccessibleName('Plan ready for review')
    await expect(card).toContainText('from core-agent')
    const plan = card.getByTestId(testIds.planApprovalPlan)
    await expect(plan.getByRole('heading', { name: MOCK_PLAN_HEADING, exact: true })).toBeVisible()
    await expect(plan).toContainText('Create notes.txt.')
    await expect(byTestId(reply, testIds.toolRow, { 'data-tool-name': 'list_directory' })).toHaveAttribute('data-status', 'done')
    await expect(byTestId(reply, testIds.toolRow, { 'data-tool-name': 'write_file' })).toHaveCount(0)
    expect(await fileText(join(folder.path, MOCK_PLAN_FILE))).toBeNull()

    // Keep planning with feedback: announced; the row keeps the feedback, a revised plan asks again; still Plan.
    const feedback = 'Use a numbered list'
    await card.getByTestId(testIds.planFeedback).fill(feedback)
    await card.getByTestId(testIds.planKeepPlanning).click()
    await expectAnnounced(announced, 'Feedback sent. The agent keeps planning.')
    await expect(reply).toContainText(mockPlanRevising(feedback))
    await expect(planRows).toHaveCount(2)
    await expect(planRows.first()).toContainText('Kept planning')
    const revised = reply.getByTestId(testIds.planApproval)
    await expect(revised).toHaveCount(1)
    await expect(revised.getByTestId(testIds.planApprovalPlan).getByRole('heading', { name: MOCK_PLAN_REVISED_HEADING })).toBeVisible()
    await expect(revised.getByTestId(testIds.planApprovalPlan)).toContainText(`Address: ${feedback}`)
    await expect(permissionTrigger(page)).toHaveAttribute('data-value', 'plan')
    await planRows.first().getByRole('button').first().click()
    await expect(reply.locator('[data-slot="plan-feedback-text"]').first()).toHaveText(`Your feedback: ${feedback}`)

    // Approve, accept edits: the mode switches, the write runs without a card, notes.txt is on disk.
    await revised.getByTestId(testIds.planApproveEdits).click()
    await expectAnnounced(announced, 'Plan approved. Permission mode: Accept edits.')
    await expect(permissionTrigger(page)).toHaveAttribute('data-value', 'edits')
    await expect(reply).toContainText(mockPlanDone('edits'))
    await expectMessageStatus(reply, 'done')
    await expect(planRows.last()).toContainText('Approved · Accept edits')
    await expect(byTestId(reply, testIds.toolRow, { 'data-tool-name': 'write_file' })).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId(testIds.toolApproval)).toHaveCount(0)
    await expect(page.getByTestId(testIds.planApproval)).toHaveCount(0)
    await expect.poll(() => fileText(join(folder.path, MOCK_PLAN_FILE))).toBe(MOCK_PLAN_FILE_CONTENT)
    await expect.poll(async () => (await api.getChat(chatId)).settings.toolMode, { message: 'the chat saved the mode' }).toBe('edits')

    // The changes panel lists the new file.
    const toggle = changesToggle(page)
    await expect(toggle).toHaveAttribute('data-count', '1')
    await toggle.click()
    await expect(changesPanel(page)).toHaveAttribute('data-state', 'ready')
    await expect(changesFile(page, MOCK_PLAN_FILE)).toBeVisible()
  })

  test('Approve, ask before edits continues in Ask: the write asks first @smoke', async ({ page, api, cleanup }) => {
    const { chatId, folder } = await seedProjectChat(api, cleanup, { modelRef: MODEL, prefix: 'plan' })
    const { reply, card, announced } = await planInProject(page, chatId, 'Plan the notes file.')

    await card.getByTestId(testIds.planApproveAsk).click()
    await expectAnnounced(announced, 'Plan approved. Permission mode: Ask.')
    await expect(permissionTrigger(page)).toHaveAttribute('data-value', 'ask')
    const writeCard = byTestId(reply, testIds.toolApproval, { 'data-tool-name': 'write_file' })
    await expect(writeCard).toBeVisible()
    await expect(byTestId(reply, testIds.toolRow, { 'data-tool-name': 'exit_plan_mode' })).toContainText('Approved · Ask')
    expect(await fileText(join(folder.path, MOCK_PLAN_FILE))).toBeNull()

    await writeCard.getByTestId(testIds.toolApprovalAllow).click()
    await expect(reply).toContainText(mockPlanDone('ask'))
    await expectMessageStatus(reply, 'done')
    await expect.poll(() => fileText(join(folder.path, MOCK_PLAN_FILE))).toBe(MOCK_PLAN_FILE_CONTENT)
  })

  test('with the Shift+Tab switch off, Shift+Tab moves the focus and keeps the mode @smoke', async ({ page, api, cleanup }) => {
    await useAgentSettings(api, cleanup, { shiftTabModes: false })
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: MODEL, prefix: 'plan' })
    await page.goto(`/chat/${chatId}`)
    const trigger = permissionTrigger(page)
    await expect(trigger).toHaveAttribute('data-value', 'ask')
    const input = composerInput(page)
    await input.click()
    await page.keyboard.press('Shift+Tab')
    await expect(input).not.toBeFocused()
    await expect(trigger).toHaveAttribute('data-value', 'ask')
  })
})
