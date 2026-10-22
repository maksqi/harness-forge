// MCP questions (Phase 14, ADR-060; docs/UI.md 2.20, 7.35; docs/API.md 4.37): the OAuth MCP fixture without OAuth
// (`noAuth`) is a personal HTTP server whose tools run without an approval card (`policy: 'safe'`); `mock:hooks` calls
// its `ask` tool (`call mcp__<server>__ask {}`), which asks for the basic form (name required, email, count 1..10,
// subscribe, color) and answers the action and the field names, never the values.
// - The card shows under the running row ("Waiting for your input"), and the sidebar dot reads "Needs your input". A
//   Submit with invalid values shows the issues under their fields and focuses the first invalid one; valid values send
//   the answer: the card turns into "You answered {server}'s request." and the tool result arrives; the stored chat never
//   holds what was typed.
// - Decline and × Dismiss send `decline` and `cancel`.
// - A reload while the card waits shows the same card again (the run's resume buffer).
// - Scrolled away from the card, the pill "{server} needs your input · Show" above the composer brings it back and
//   focuses its first field.
import type { Locator, Page } from '@playwright/test'
import type { CleanupTask, HarnessApi } from '../../helpers/index.ts'
import {
  addHttpMcpServer,
  byTestId,
  chatStatusDot,
  elicitationCard,
  elicitationField,
  elicitationHeading,
  elicitationResultText,
  expect,
  expectMessageStatus,
  fillBasicForm,
  FIXTURE_FORM_FIELDS,
  FIXTURE_FORM_MESSAGE,
  lastAssistantMessage,
  mcpToolName,
  MOCK_HOOKS_MODEL,
  sendMessage,
  startOAuthFixture,
  test,
  testIds,
  uniqueId,
  waitForMcpStatus,
} from '../../helpers/index.ts'

interface AskChat {
  chatId: string
  serverId: string
  serverName: string
  tool: string
}

/** A connected fixture server (no OAuth, `safe` policy) and an empty `mock:hooks` chat, opened in the page. */
async function openAskChat(page: Page, api: HarnessApi, cleanup: (task: CleanupTask) => void): Promise<AskChat> {
  const fixture = await startOAuthFixture({ noAuth: true }, cleanup)
  const serverId = uniqueId('ask')
  const serverName = `Issues ${serverId}`
  await addHttpMcpServer(api, cleanup, { id: serverId, name: serverName, url: fixture.url, policy: 'safe' })
  await waitForMcpStatus(api, serverId, 'connected')
  const chat = await api.createChat({ title: `Questions ${serverId}`, modelRef: MOCK_HOOKS_MODEL })
  cleanup(api => api.removeChat(chat.id))
  await page.goto(`/chat/${chat.id}`)
  await expect(page.getByTestId(testIds.composerInput)).toBeEditable()
  return { chatId: chat.id, serverId, serverName, tool: mcpToolName(serverId, 'ask') }
}

/** Sends the `ask` call and waits for its pending card under the waiting row. */
async function askAndWait(page: Page, chat: AskChat): Promise<Locator> {
  await sendMessage(page, `call ${chat.tool} {}`)
  const row = byTestId(lastAssistantMessage(page), testIds.toolRow, { 'data-tool-name': chat.tool })
  await expect(row.locator('[data-slot="tool-row-waiting"]')).toHaveText('Waiting for your input')
  const card = elicitationCard(page, { 'data-server-id': chat.serverId })
  await expect(card).toHaveAttribute('data-state', 'pending')
  await expect(card.getByRole('heading')).toHaveText(elicitationHeading(chat.serverName))
  return card
}

/**
 * Expands the finished `ask` row of the last reply and returns its tool part: the body starts with the result lines of the
 * call's questions (`elicitation-result`, `data-action`; never the values).
 */
async function expandAskRow(page: Page, chat: AskChat): Promise<Locator> {
  const row = byTestId(lastAssistantMessage(page), testIds.toolRow, { 'data-tool-name': chat.tool })
  await expect(row).toHaveAttribute('data-state', 'output-available')
  await row.getByRole('button').first().click()
  return row.locator('xpath=ancestor::*[@data-slot="tool-part"][1]')
}

/** The stored text of the chat's last reply (once finished). */
async function lastReplyText(api: HarnessApi, chatId: string): Promise<string> {
  const last = (await api.getChat(chatId)).messages.at(-1)
  expect(last?.role).toBe('assistant')
  return (last?.parts ?? []).map(part => (part.type === 'text' ? part.text : '')).join('')
}

test.describe('MCP questions (elicitation)', () => {
  test('the card waits under its row; an invalid Submit shows the issues, a valid one sends the answer @smoke', async ({ page, api, cleanup }) => {
    const chat = await openAskChat(page, api, cleanup)
    const card = await askAndWait(page, chat)
    await expect(card.getByTestId(testIds.elicitationMessage)).toHaveText(FIXTURE_FORM_MESSAGE)
    await expect(card.getByTestId(testIds.elicitationField)).toHaveCount(FIXTURE_FORM_FIELDS.length)
    for (const name of FIXTURE_FORM_FIELDS)
      await expect(elicitationField(card, name)).toBeVisible()
    await expect(elicitationField(card, 'count')).toHaveAttribute('data-type', 'integer')
    await expect(elicitationField(card, 'color')).toHaveAttribute('data-type', 'enum')
    await expect(elicitationField(card, 'subscribe')).toHaveAttribute('data-type', 'boolean')
    await expect(card.getByTestId(testIds.elicitationCountdown)).toHaveText(/^\s*\d+:\d\d left$/)
    await expect(card).toContainText(`Share only what you would give ${chat.serverName}. Never enter passwords here.`)
    await expect(chatStatusDot(page, chat.chatId, { 'data-status': 'input' })).toContainText('Needs your input')
    expect((await api.getChat(chat.chatId)).awaitingInput).toBe(true)

    // Invalid: the required name is empty and the email is not one. The issues show under their fields, the first
    // invalid field takes the focus, nothing is sent.
    const name = elicitationField(card, 'name').getByRole('textbox')
    await elicitationField(card, 'email').getByRole('textbox').fill('not-an-email')
    await card.getByTestId(testIds.elicitationSubmit).click()
    await expect(elicitationField(card, 'name').getByTestId(testIds.elicitationFieldError)).toBeVisible()
    await expect(elicitationField(card, 'email').getByTestId(testIds.elicitationFieldError)).toBeVisible()
    await expect(name).toHaveAttribute('aria-invalid', 'true')
    await expect(name).toBeFocused()
    await expect(card).toHaveAttribute('data-state', 'pending')

    // Valid: the answer goes to the server; the card becomes its result line, then the tool result arrives.
    const canary = uniqueId('Ada')
    await fillBasicForm(card, { name: canary, email: `${canary}@example.com`, count: 3, color: 'green' })
    await card.getByTestId(testIds.elicitationSubmit).click()
    await expect(card).toHaveCount(0)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    const part = await expandAskRow(page, chat)
    await expect(byTestId(part, testIds.elicitationResult, { 'data-action': 'accept' })).toHaveText(elicitationResultText(chat.serverName, 'accept'))
    const reply = await lastReplyText(api, chat.chatId)
    expect(reply).toContain(`Called ${chat.tool}: ok |`)
    expect(reply).toContain('"action":"accept"')
    expect(reply).toContain('"fields":[')
    await expect(chatStatusDot(page, chat.chatId, { 'data-status': 'input' })).toHaveCount(0)
    const stored = JSON.stringify(await api.getChat(chat.chatId))
    expect(stored, 'the stored chat never holds an entered value').not.toContain(canary)
    expect((await api.getChat(chat.chatId)).awaitingInput ?? false).toBe(false)
  })

  test('Decline and × Dismiss send decline and cancel', async ({ page, api, cleanup }) => {
    const chat = await openAskChat(page, api, cleanup)

    let card = await askAndWait(page, chat)
    await card.getByTestId(testIds.elicitationDecline).click()
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(byTestId(await expandAskRow(page, chat), testIds.elicitationResult, { 'data-action': 'decline' })).toHaveText(elicitationResultText(chat.serverName, 'decline'))
    expect(await lastReplyText(api, chat.chatId)).toContain('"action":"decline"')

    card = await askAndWait(page, chat)
    await expect(card.getByTestId(testIds.elicitationDismiss)).toHaveAccessibleName('Dismiss request')
    await card.getByTestId(testIds.elicitationDismiss).click()
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(byTestId(await expandAskRow(page, chat), testIds.elicitationResult, { 'data-action': 'cancel' })).toHaveText(elicitationResultText(chat.serverName, 'cancel'))
    expect(await lastReplyText(api, chat.chatId)).toContain('"action":"cancel"')
  })

  test('a reload while the card waits shows it again', async ({ page, api, cleanup }) => {
    const chat = await openAskChat(page, api, cleanup)
    const card = await askAndWait(page, chat)
    const id = await card.getAttribute('data-elicitation-id')
    expect(id).toMatch(/^eli_/)

    await page.reload()
    const again = elicitationCard(page, { 'data-elicitation-id': id! })
    await expect(again).toHaveAttribute('data-state', 'pending')
    await expect(again.getByTestId(testIds.elicitationMessage)).toHaveText(FIXTURE_FORM_MESSAGE)
    await again.getByTestId(testIds.elicitationDecline).click()
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    expect(await lastReplyText(api, chat.chatId)).toContain('"action":"decline"')
  })

  test('scrolled away from the card, the pill above the composer shows it and focuses its first field', async ({ page, api, cleanup }) => {
    await page.setViewportSize({ width: 1280, height: 560 })
    const chat = await openAskChat(page, api, cleanup)
    // Earlier turns above the question, so the card can leave the view.
    const tall = Array.from({ length: 24 }, (_, index) => `Line ${index + 1}.`).join('\n\n')
    await api.sendChat({ chatId: chat.chatId, modelRef: MOCK_HOOKS_MODEL, text: tall })
    await page.reload()
    await expect(page.getByTestId(testIds.messageAssistant)).toHaveCount(1)
    const card = await askAndWait(page, chat)
    const jump = page.getByTestId(testIds.elicitationJump)
    await expect(jump).toHaveCount(0)

    await page.getByTestId(testIds.transcript).hover()
    await page.mouse.wheel(0, -20_000)
    await expect(card).not.toBeInViewport()
    await expect(jump).toBeVisible()
    await expect(jump).toContainText(`${chat.serverName} needs your input · Show`)
    await jump.click()
    await expect(card).toBeInViewport()
    await expect(elicitationField(card, 'name').getByRole('textbox')).toBeFocused()
    await expect(jump).toHaveCount(0)

    await card.getByTestId(testIds.elicitationDecline).click()
    await expectMessageStatus(lastAssistantMessage(page), 'done')
  })
})
