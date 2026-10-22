// MCP questions on a phone (Phase 14, ADR-060; docs/UI.md 2.20, 7.35, 14.5), project `mobile` (Pixel 7 at 390x844,
// touch): the elicitation card of the OAuth MCP fixture (`noAuth`, `policy: 'safe'`; `mock:hooks` calls its `ask` tool)
// fits 390 px: its buttons are stacked full width with Submit first, every field and button is a 40 px target, × Dismiss
// too, and nothing scrolls sideways.
import type { Locator, Page } from '@playwright/test'
import {
  addHttpMcpServer,
  boxOf,
  documentWidths,
  elicitationCard,
  elicitationField,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  mcpToolName,
  MOCK_HOOKS_MODEL,
  startOAuthFixture,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
  waitForMcpStatus,
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

test.describe('mobile MCP questions', () => {
  test('the card fits 390 px: full-width buttons with Submit first, 40 px fields and buttons', async ({ page, api, cleanup }) => {
    const fixture = await startOAuthFixture({ noAuth: true }, cleanup)
    const serverId = uniqueId('ask')
    await addHttpMcpServer(api, cleanup, { id: serverId, name: `Issues ${serverId}`, url: fixture.url, policy: 'safe' })
    await waitForMcpStatus(api, serverId, 'connected')
    const chat = await api.createChat({ title: `Mobile questions ${serverId}`, modelRef: MOCK_HOOKS_MODEL })
    cleanup(api => api.removeChat(chat.id))
    await page.goto(`/chat/${chat.id}`)
    await page.getByTestId(testIds.composerInput).fill(`call ${mcpToolName(serverId, 'ask')} {}`)
    await page.getByTestId(testIds.composerSend).tap()

    const card = elicitationCard(page, { 'data-server-id': serverId })
    await expect(card).toHaveAttribute('data-state', 'pending')
    await card.scrollIntoViewIfNeeded()
    await expectNoSidewaysScroll(page, 'the card')
    const cardBox = await boxOf(card)
    expect(cardBox.x).toBeGreaterThanOrEqual(0)
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(VIEWPORT.width)

    // The buttons: stacked, Submit above Decline, each about as wide as the card's content.
    const submit = card.getByTestId(testIds.elicitationSubmit)
    const decline = card.getByTestId(testIds.elicitationDecline)
    await expectTouchTarget(submit, 'Submit')
    await expectTouchTarget(decline, 'Decline')
    const submitBox = await boxOf(submit)
    const declineBox = await boxOf(decline)
    expect(submitBox.y + submitBox.height, 'Submit comes first').toBeLessThanOrEqual(declineBox.y)
    expect(Math.round(submitBox.width)).toBe(Math.round(declineBox.width))
    expect(submitBox.width, 'full width').toBeGreaterThan(cardBox.width - 40)
    await expectTouchTarget(card.getByTestId(testIds.elicitationDismiss), '× Dismiss')

    // Every field is a 40 px control.
    await expectTouchTarget(elicitationField(card, 'name').getByRole('textbox'), 'the name input')
    await expectTouchTarget(elicitationField(card, 'count').getByRole('spinbutton'), 'the count input')
    await expectTouchTarget(elicitationField(card, 'subscribe').getByRole('checkbox'), 'the subscribe checkbox')
    await expectTouchTarget(elicitationField(card, 'color').getByRole('radio').first(), 'a color radio')

    await decline.tap()
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expectNoSidewaysScroll(page, 'the answered call')
  })
})
