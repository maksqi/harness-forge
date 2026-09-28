// Message parts (docs/UI.md 7.1-7.3): the reasoning row of `mock:reasoning` ("Thinking…" while it streams, then
// "Thought for Ns", collapsed until opened) and the approval card of `mock:tool-approval` in permission mode `ask`
// (Allow runs `mock_approval_tool`, Deny skips it; the model then answers either way).
import type { Page } from '@playwright/test'
import {
  byTestId,
  CHAT_URL_PATTERN,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  looseQuotes,
  openNewChat,
  selectModel,
  selectPermissionMode,
  sendMessage,
  startChat,
  test,
  testIds,
  uniqueId,
  wordList,
} from '../../helpers/index.ts'

const TOOL_NAME = 'mock_approval_tool'

/** New `mock:tool-approval` chat in permission mode `ask` (the default), so the tool call needs an approval. */
async function startApprovalChat(page: Page, text: string): Promise<void> {
  await openNewChat(page)
  await selectModel(page, 'mock:tool-approval')
  await selectPermissionMode(page, 'ask')
  await sendMessage(page, text)
  await expect(page).toHaveURL(CHAT_URL_PATTERN)
}

test.describe('reasoning', () => {
  test('mock:reasoning shows the thinking row, then the answer @smoke', async ({ page }) => {
    const token = uniqueId('think')
    // Eight words or more make the reasoning stream for about 1.3 s (100 ms per word).
    const text = `Reasoning check ${token} ${wordList(8, 'r').join(' ')}`
    const reasoning = `Thinking about "Reasoning check ${token} r1 r2 r3 r4 r5" with effort provider-default.`

    await startChat(page, { modelRef: 'mock:reasoning', text })
    const reply = lastAssistantMessage(page)
    const row = reply.getByTestId(testIds.reasoningRow)
    // One assertion, so the state and the label are read together while the reasoning streams (a 1.3 s window, longer
    // than the 1 s polling interval of web-first assertions).
    await expect(byTestId(reply, testIds.reasoningRow, { 'data-state': 'streaming' })).toContainText('Thinking…', { timeout: 10_000 })

    await expectMessageStatus(reply, 'done', 15_000)
    await expect(row).toHaveAttribute('data-state', 'done')
    await expect(row).toContainText(/^Thought( for \d+s)?$/)
    await expect(row).toHaveAttribute('data-expanded', 'false')
    await expect(reply).toContainText(`Answer: ${text}`)
    await expect(reply).not.toContainText(looseQuotes(reasoning))

    // Collapsed by default; the row opens the reasoning text.
    await row.getByRole('button').click()
    await expect(row).toHaveAttribute('data-expanded', 'true')
    await expect(reply).toContainText(looseQuotes(reasoning))

    // After a reload the duration comes from the stored metadata.
    await page.reload()
    const reloaded = lastAssistantMessage(page)
    await expect(reloaded.getByTestId(testIds.reasoningRow)).toContainText(/^Thought for \d+s$/)
    await expect(reloaded).toContainText(`Answer: ${text}`)
  })
})

test.describe('tool approval', () => {
  test.beforeEach(async ({ api }) => {
    // An "Always allow" left on this data directory would skip the approval card.
    await api.client.tools.update({ params: { name: TOOL_NAME }, body: { override: null } })
  })

  test('allowing mock_approval_tool runs it and the model answers with its result @smoke', async ({ page }) => {
    const text = `Approve ${uniqueId('allow')}`

    await startApprovalChat(page, text)
    const reply = lastAssistantMessage(page)
    const row = byTestId(reply, testIds.toolRow, { 'data-tool-name': TOOL_NAME })
    const card = byTestId(reply, testIds.toolApproval, { 'data-tool-name': TOOL_NAME })
    await expect(card).toBeVisible()
    await expect(card).toContainText(`Allow ${TOOL_NAME}?`)
    await expect(card).toContainText(text)
    await expect(row).toHaveAttribute('data-state', 'approval-requested')
    await expect(row).toContainText('Needs approval')

    await card.getByTestId(testIds.toolApprovalAllow).click()
    await expect(card).toBeHidden()
    await expect(row).toHaveAttribute('data-state', 'output-available')
    await expect(row).toHaveAttribute('data-status', 'done')
    // Markdown renders the quotes as typographic quotes.
    await expect(reply).toContainText(looseQuotes(`Tool result: {"echoed":"${text}"}`))
    await expectMessageStatus(reply, 'done')

    // The expanded row shows the tool input and output.
    await row.getByRole('button').click()
    const output = reply.getByTestId(testIds.toolRowOutput)
    await expect(output).toBeVisible()
    await expect(output).toContainText(`"echoed": "${text}"`)
  })

  test('denying mock_approval_tool skips it and the model reports the denial @smoke', async ({ page }) => {
    const text = `Deny ${uniqueId('deny')}`

    await startApprovalChat(page, text)
    const reply = lastAssistantMessage(page)
    const row = byTestId(reply, testIds.toolRow, { 'data-tool-name': TOOL_NAME })
    const card = byTestId(reply, testIds.toolApproval, { 'data-tool-name': TOOL_NAME })
    await expect(card).toBeVisible()

    await card.getByTestId(testIds.toolApprovalDeny).click()
    await expect(card).toBeHidden()
    await expect(row).toHaveAttribute('data-state', 'output-denied')
    await expect(row).toHaveAttribute('data-status', 'denied')
    await expect(row).toContainText('Denied')
    await expect(reply).toContainText('The tool call was denied.')
    await expect(reply).not.toContainText('Tool result:')
    await expectMessageStatus(reply, 'done')
  })
})
