// Phase 6 on a phone (docs/UI.md 7.16 - 7.18, 14.5, 14.6), project `mobile` (Pixel 7 at 390x844, touch): the mic is a
// touch target of at least 40x40 px and recording or transcribing keeps the 390 px layout (no sideways scroll, the
// composer inside the viewport, no autofocus afterwards); a gallery keeps its two columns inside the column and its
// lightbox fits the screen; the image options trigger, Read aloud and Delete this version are 40 px targets too.
import type { Locator, Page } from '@playwright/test'
import {
  boxOf,
  composer,
  documentWidths,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  mediaSettingsOf,
  NO_MEDIA_SETTINGS,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }
const TRANSCRIPT = 'This is a mock transcription.'

/** At least 40x40 px; polled, because a dialog zooms in from 95% (a 40 px button measures 38 px meanwhile). */
async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  await expect.poll(async () => (await touchTargetSize(target)).width, { message: `${name} width` }).toBeGreaterThanOrEqual(40)
  await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${name} height` }).toBeGreaterThanOrEqual(40)
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${where} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

async function expectInsideViewport(target: Locator, name: string): Promise<void> {
  const box = await boxOf(target)
  expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0)
  expect(box.y, `${name} top edge`).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(VIEWPORT.width)
  expect(box.y + box.height, `${name} bottom edge`).toBeLessThanOrEqual(VIEWPORT.height)
}

test.describe('mobile media', () => {
  test.beforeEach(async ({ api, cleanup }) => {
    const before = mediaSettingsOf(await api.getSettings())
    cleanup(api => api.updateSettings(before))
  })

  test('the mic is a 40 px target and recording keeps the 390 px layout', async ({ page, api }) => {
    await api.updateSettings({ ...NO_MEDIA_SETTINGS, transcriptionModelRef: 'mock:transcribe' })

    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    const mic = composer(page).getByTestId(testIds.composerMic)
    await expect(mic).toHaveAttribute('data-state', 'idle')
    await expectTouchTarget(mic, 'the mic')

    // Recording: the indicator (dot, timer, Cancel) replaces the left tools and everything still fits.
    await mic.tap()
    await expect(mic).toHaveAttribute('data-state', 'recording')
    const indicator = composer(page).getByTestId(testIds.composerRecording)
    await expect(indicator.getByTestId(testIds.composerRecordingTime)).toHaveText('0:01', { timeout: 5_000 })
    await expectTouchTarget(mic, 'the mic while recording')
    await expectTouchTarget(indicator.getByTestId(testIds.composerMicCancel), 'Cancel')
    await expectInsideViewport(indicator, 'the recording indicator')
    await expectInsideViewport(composer(page), 'the composer while recording')
    await expectNoSidewaysScroll(page, 'the recording composer')

    // Stop: the transcript goes in; on touch the textarea does not take the focus (no keyboard pops up).
    const answered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/audio/transcriptions')
    await mic.tap()
    expect((await answered).status()).toBe(200)
    const input = page.getByTestId(testIds.composerInput)
    await expect(input).toHaveValue(TRANSCRIPT)
    await expect(mic).toHaveAttribute('data-state', 'idle')
    await expect(input).not.toBeFocused()
    await expectNoSidewaysScroll(page, 'the composer after dictation')
  })

  test('a gallery keeps two columns at 390 px and its lightbox fits the screen', async ({ page, api, cleanup }) => {
    const { chatId } = await api.sendChat({
      modelRef: 'mock:image',
      text: `A mountain lake at dawn ${uniqueId('mobilegallery')}`,
      imageOptions: { n: 4, aspectRatio: '16:9' },
    })
    cleanup(api => api.removeChat(chatId))

    await page.goto(`/chat/${chatId}`)
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply)
    const gallery = reply.getByTestId(testIds.imageGallery)
    await expect(gallery).toHaveAttribute('data-count', '4')
    const tiles = gallery.getByTestId(testIds.imageTile)
    await expect(tiles).toHaveCount(4)

    // Two columns: tiles 1 and 2 side by side, 3 and 4 below them; nothing leaves the column or the screen.
    const boxes = await Promise.all([0, 1, 2, 3].map(index => boxOf(tiles.nth(index))))
    const [first, second, third, fourth] = boxes as [typeof boxes[0], typeof boxes[0], typeof boxes[0], typeof boxes[0]]
    expect(Math.round(second.y), 'tiles 1 and 2 share a row').toBe(Math.round(first.y))
    expect(second.x, 'tile 2 is right of tile 1').toBeGreaterThanOrEqual(first.x + first.width)
    expect(third.y, 'tile 3 starts a second row').toBeGreaterThanOrEqual(first.y + first.height)
    expect(Math.round(fourth.y), 'tiles 3 and 4 share a row').toBe(Math.round(third.y))
    const column = await boxOf(gallery)
    for (const [index, box] of boxes.entries()) {
      expect(box.x, `tile ${index + 1} left edge`).toBeGreaterThanOrEqual(column.x - 0.5)
      expect(box.x + box.width, `tile ${index + 1} right edge`).toBeLessThanOrEqual(Math.min(column.x + column.width, VIEWPORT.width) + 0.5)
    }
    await expectNoSidewaysScroll(page, 'the chat with a gallery')

    // The image options of the composer (the chat's image model) are a touch target.
    await expectTouchTarget(composer(page).getByTestId(testIds.imageOptionsTrigger), 'the image options trigger')

    // The lightbox fits the screen.
    await tiles.first().tap()
    const lightbox = page.getByTestId(testIds.imageLightbox)
    await expect(lightbox).toHaveAttribute('data-index', '0')
    await expectInsideViewport(lightbox, 'the lightbox')
    await expectTouchTarget(lightbox.getByRole('button', { name: 'Next image' }), 'Next image')
    await lightbox.getByRole('button', { name: 'Next image' }).tap()
    await expect(lightbox).toHaveAttribute('data-index', '1')
    await expectNoSidewaysScroll(page, 'the open lightbox')
  })

  test('Read aloud and Delete this version are 40 px targets', async ({ page, api, cleanup }) => {
    await api.updateSettings({ ...NO_MEDIA_SETTINGS, speechModelRef: 'mock:speech' })
    const { chatId } = await api.sendChat({ text: `Two versions ${uniqueId('mobileactions')}.` })
    cleanup(api => api.removeChat(chatId))
    await api.regenerateChat({ chatId })

    await page.goto(`/chat/${chatId}`)
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply)
    await expect(reply.getByTestId(testIds.messageBranch)).toHaveAttribute('data-count', '2')
    await expectTouchTarget(reply.getByTestId(testIds.messageReadAloud), 'Read aloud')
    await expectTouchTarget(reply.getByTestId(testIds.messageDeleteVersion), 'Delete this version')
    await expectTouchTarget(reply.getByTestId(testIds.messageBranchPrevious), 'Previous version')
    await expectNoSidewaysScroll(page, 'the chat with versions')
  })
})
