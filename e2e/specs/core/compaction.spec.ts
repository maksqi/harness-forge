// Compaction (docs/UI.md 2.16, 7.8, 7.12, 7.24; ADR-040) with `mock:compact` (docs/PROVIDERS.md 8: a 2000-token
// context window; as the summarizer it answers `MOCK-SUMMARY: …`; as the chat model it echoes the text plus 150 filler
// words).
// - `/compact <focus>` from the slash menu: the reply holds only the divider ("Conversation compacted", `data-kind`
//   manual, the count of messages summarized), every row above it is dimmed (`data-compacted`), the summary opens and
//   closes below the rule (the focus, the summary, the footnote), and a reload keeps all of it. The summary is written
//   by `compactModelRef` (`mock:compact`) in a `mock:echo` chat, so the seed turns stream at once.
// - Automatic compaction: two long `mock:compact` turns fill the window; the third reply opens with the divider
//   ("Conversation compacted automatically", `data-kind` auto), the older turns are dimmed except the kept user message,
//   and the context ring drops.
// - With `autoCompact` off the same turn trims the oldest messages instead: the `context-trimmed` notice, no divider.
import type { Page } from '@playwright/test'
import {
  assistantMessages,
  byTestId,
  compactFiller,
  composer,
  expect,
  expectAnnounced,
  expectMessageStatus,
  lastAssistantMessage,
  noticeLine,
  recordAnnouncements,
  sendMessage,
  test,
  testIds,
  uniqueId,
  useAgentSettings,
  userMessages,
} from '../../helpers/index.ts'

const MODEL = 'mock:compact'
/** A `mock:compact` turn streams about 200 words (5 s). */
const TURN_TIMEOUT = 20_000

/** The context ring's percentage (`data-value`). */
async function ringValue(page: Page): Promise<number> {
  const ring = composer(page).getByTestId(testIds.contextRing)
  await expect(ring).toHaveAttribute('data-value', /^\d+$/)
  return Number(await ring.getAttribute('data-value'))
}

test.describe('compaction', () => {
  test('/compact with a focus shows the divider, dims the rows above and keeps all of it after a reload @smoke', async ({ page, api, cleanup }) => {
    await useAgentSettings(api, cleanup, { compactModelRef: MODEL })
    const chat = await api.createChat({ title: `Compaction ${uniqueId('compact')}`, modelRef: 'mock:echo' })
    cleanup(api => api.removeChat(chat.id))
    for (const text of ['OLD-1 First question about the parser', 'OLD-2 Second question about the lexer', 'OLD-3 Third question about the tests'])
      await api.sendChat({ chatId: chat.id, modelRef: 'mock:echo', toolMode: 'off', text })

    await page.goto(`/chat/${chat.id}`)
    await expect(assistantMessages(page)).toHaveCount(3)
    await expect(page.locator('[data-compacted]')).toHaveCount(0)

    // The slash menu lists /compact (a server command of core-agent); picking it leaves room for the focus.
    const input = page.getByTestId(testIds.composerInput)
    await input.fill('/comp')
    const item = byTestId(page.getByTestId(testIds.slashMenu), testIds.slashMenuItem, { 'data-value': 'compact' })
    await expect(item).toHaveAttribute('data-kind', 'server')
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('/compact ')
    await page.keyboard.type('keep the parser details')
    await page.keyboard.press('Enter')

    // The reply holds only the divider; the rows above it are dimmed, the reply itself is not.
    const reply = lastAssistantMessage(page)
    const divider = reply.getByTestId(testIds.compactionDivider)
    await expect(divider).toBeVisible()
    await expectMessageStatus(reply, 'done')
    await expect(divider).toHaveAttribute('data-kind', 'manual')
    await expect(divider).toHaveAttribute('data-variant', 'history')
    await expect(divider).toHaveAttribute('data-count', '6')
    await expect(divider).toHaveAccessibleName('Conversation compacted')
    await expect(divider.locator('[data-slot="compaction-meta"]')).toContainText('6 messages summarized')
    await expect(userMessages(page)).toHaveCount(4)
    for (let index = 0; index < 4; index++)
      await expect(userMessages(page).nth(index)).toHaveAttribute('data-compacted', /.*/)
    for (let index = 0; index < 3; index++)
      await expect(assistantMessages(page).nth(index)).toHaveAttribute('data-compacted', /.*/)
    await expect(reply).not.toHaveAttribute('data-compacted', /.*/)

    // The summary opens below the rule (the focus, the summarizer's text, the footnote) and closes again.
    const toggle = divider.getByTestId(testIds.compactionToggle)
    await expect(toggle).toHaveAttribute('data-state', 'closed')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveText('Show summary')
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-state', 'open')
    await expect(toggle).toHaveText('Hide summary')
    const summary = divider.getByTestId(testIds.compactionSummary)
    await expect(summary).toContainText('Focus: keep the parser details')
    await expect(summary).toContainText('MOCK-SUMMARY:')
    await expect(summary).toContainText('focus=keep the parser details')
    await expect(summary).toContainText('The model sees this summary instead of the messages above.')
    await toggle.click()
    await expect(summary).toHaveCount(0)
    await expect(toggle).toBeFocused()

    // A reload keeps the divider and the dimmed rows (the summary starts closed again).
    await page.reload()
    await expect(lastAssistantMessage(page).getByTestId(testIds.compactionDivider)).toHaveAttribute('data-count', '6')
    await expect(page.locator('[data-compacted]')).toHaveCount(7)
    await expect(lastAssistantMessage(page).getByTestId(testIds.compactionToggle)).toHaveAttribute('data-state', 'closed')
  })

  // A `/compact` reply (start, marker, finish) arrives within one tick; ChatView still announces it (found by W9.13,
  // fixed at the final gate: same-tick announcements are joined, "Conversation compacted. Response finished").
  test('/compact is announced as "Conversation compacted" @smoke', async ({ page, api, cleanup }) => {
    await useAgentSettings(api, cleanup, { compactModelRef: MODEL })
    const chat = await api.createChat({ title: `Compaction ${uniqueId('compact')}`, modelRef: 'mock:echo' })
    cleanup(api => api.removeChat(chat.id))
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:echo', toolMode: 'off', text: 'OLD-1 Something to compact' })
    await page.goto(`/chat/${chat.id}`)
    const announced = await recordAnnouncements(page)
    await sendMessage(page, '/compact')
    await expect(lastAssistantMessage(page).getByTestId(testIds.compactionDivider)).toBeVisible()
    await expectAnnounced(announced, 'Conversation compacted')
  })

  test('a full context compacts automatically before the reply and the context ring drops @smoke', async ({ page, api, cleanup }) => {
    test.setTimeout(90_000)
    await useAgentSettings(api, cleanup, { autoCompact: true })
    const chat = await api.createChat({ title: `Auto compaction ${uniqueId('compact')}`, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    for (const label of ['AUTO-1', 'AUTO-2'])
      await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'ask', text: compactFiller(label) })

    await page.goto(`/chat/${chat.id}`)
    await expect(assistantMessages(page)).toHaveCount(2)
    await expect(page.getByTestId(testIds.compactionDivider)).toHaveCount(0)
    const before = await ringValue(page)
    const announced = await recordAnnouncements(page)

    await sendMessage(page, compactFiller('AUTO-3'))
    const reply = lastAssistantMessage(page)
    const divider = reply.getByTestId(testIds.compactionDivider)
    await expect(divider).toBeVisible({ timeout: TURN_TIMEOUT })
    await expectMessageStatus(reply, 'done', TURN_TIMEOUT)
    await expect(divider).toHaveAttribute('data-kind', 'auto')
    await expect(divider).toHaveAttribute('data-variant', 'history')
    await expect(divider).toHaveAttribute('data-count', '4')
    await expect(divider).toHaveAccessibleName('Conversation compacted automatically')
    await expectAnnounced(announced, 'Conversation compacted')
    // The first two turns are dimmed; the kept user message (this turn's) is not.
    await expect(page.locator('[data-compacted]')).toHaveCount(4)
    await expect(userMessages(page).last()).not.toHaveAttribute('data-compacted', /.*/)
    await expect(reply).toContainText('AUTO-3')
    await expect.poll(() => ringValue(page), { message: 'the context ring drops after the compaction' }).toBeLessThan(before)
  })

  test('with automatic compaction off a full context trims the oldest messages instead @smoke', async ({ page, api, cleanup }) => {
    test.setTimeout(90_000)
    await useAgentSettings(api, cleanup, { autoCompact: false })
    const chat = await api.createChat({ title: `Trimmed context ${uniqueId('compact')}`, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    for (const label of ['TRIM-1', 'TRIM-2', 'TRIM-3'])
      await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'ask', text: compactFiller(label) })

    await page.goto(`/chat/${chat.id}`)
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(noticeLine(reply, 'context-trimmed')).toBeVisible()
    await expect(page.getByTestId(testIds.compactionDivider)).toHaveCount(0)
    await expect(page.locator('[data-compacted]')).toHaveCount(0)
    await expect(noticeLine(page, 'compaction-failed')).toHaveCount(0)
  })
})
