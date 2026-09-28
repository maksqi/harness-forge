// Chatting on a phone (docs/UI.md 7.9, 14.5, 14.6), project `mobile` (Pixel 7 at 390x844, touch): the model picker
// opens as a bottom drawer, a `mock:echo` reply streams and finishes, and the composer toolbar and the message actions
// are touch targets of at least 40x40 px (always visible on touch).
import type { Locator } from '@playwright/test'
import {
  boxOf,
  byTestId,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  composer,
  expect,
  expectMessageStatus,
  expectStreamingWith,
  lastAssistantMessage,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
  userMessages,
  wordList,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }

async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  const size = await touchTargetSize(target)
  expect(size.width, `${name} width`).toBeGreaterThanOrEqual(40)
  expect(size.height, `${name} height`).toBeGreaterThanOrEqual(40)
}

test.describe('mobile chat', () => {
  test('the model picker is a bottom drawer and a reply streams to its end', async ({ page, cleanup }) => {
    const token = uniqueId('mobile')
    // 120 words stream for about 3 s.
    const text = `Mobile check ${token} ${wordList(120, 'm').join(' ')} last-${token}`

    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    const trigger = composer(page).getByTestId(testIds.modelPickerTrigger)
    await expect(trigger).toHaveAttribute('data-model-ref', /.+/)

    // The picker slides up from the bottom edge over the whole width.
    await trigger.tap()
    const picker = page.getByTestId(testIds.modelPicker)
    await expect(picker).toBeVisible()
    await expect(picker).toHaveAttribute('role', 'dialog')
    await expect.poll(async () => {
      const box = await boxOf(picker)
      return { x: Math.round(box.x), width: Math.round(box.width), bottom: Math.round(box.y + box.height) }
    }).toEqual({ x: 0, width: VIEWPORT.width, bottom: VIEWPORT.height })
    await byTestId(picker, testIds.modelPickerItem, { 'data-model-ref': 'mock:echo' }).first().tap()
    await expect(picker).toBeHidden()
    await expect(trigger).toHaveAttribute('data-model-ref', 'mock:echo')

    // The composer toolbar is made of touch targets.
    await page.getByTestId(testIds.composerInput).fill(text)
    await expectTouchTarget(page.getByTestId(testIds.composerAdd), 'the + menu')
    await expectTouchTarget(trigger, 'the model picker trigger')
    await expectTouchTarget(page.getByTestId(testIds.composerSend), 'the send button')

    // Send streams the reply to its end.
    await page.getByTestId(testIds.composerSend).tap()
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    const reply = lastAssistantMessage(page)
    const partial = await expectStreamingWith(reply, `Mobile check ${token}`)
    expect(partial.text).not.toContain(`last-${token}`)
    await expectTouchTarget(page.getByTestId(testIds.composerStop), 'the stop button')
    await expectMessageStatus(reply, 'done', 20_000)
    await expect(reply).toContainText(`last-${token}`)

    // After the first reply the context ring joins the toolbar; message actions are always shown on touch.
    await expectTouchTarget(page.getByTestId(testIds.contextRing), 'the context ring')
    const question = userMessages(page).last()
    await expectTouchTarget(question.getByTestId(testIds.messageCopy), 'copy (user message)')
    await expectTouchTarget(question.getByTestId(testIds.messageEdit), 'edit (user message)')
    await expectTouchTarget(reply.getByTestId(testIds.messageCopy), 'copy (reply)')
    await expectTouchTarget(reply.getByTestId(testIds.messageRegenerate), 'regenerate (reply)')
  })
})
