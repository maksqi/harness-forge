// Image generation (docs/UI.md 7.7, 7.16, 14.2; docs/API.md 4.18; ADR-028) with the mock media models
// (docs/PROVIDERS.md 8): `mock:image` is an image model (300 ms, 5 s when the prompt says "slow", 320 px long edge),
// `mock:image-chat` a chat model with image output (text, then one PNG) and `mock:image-tool` calls the builtin
// `generate_image` tool (policy `ask`), which uses the image model of Settings -> Media (`imageModelRef`). Every image
// is a stored file (`/api/files/<id>`), rendered as a gallery (`image-gallery`, `image-tile`) with a lightbox
// (`image-lightbox`) and a same-origin Download link (`image-download`); an image turn in flight shows placeholder
// tiles (`image-generating`) until its images arrive.
import type { Locator, Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import {
  boxOf,
  byTestId,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  composer,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  mediaSettingsOf,
  naturalSize,
  openNewChat,
  selectModel,
  selectPermissionMode,
  sendMessage,
  test,
  testIds,
  uniqueId,
} from '../../helpers/index.ts'

const IMAGE_MODEL = 'mock:image'
const TOOL_NAME = 'generate_image'
/** A slow `mock:image` turn waits 5 s; its reply streams for about that long. */
const IMAGE_TURN_TIMEOUT = 20_000
/** PNG magic bytes. */
const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47]

/** The image of a gallery tile (alt "Generated image {n} of {m}"). */
function tileImage(gallery: Locator, index: number): Locator {
  return byTestId(gallery, testIds.imageTile, { 'data-index': String(index) }).getByRole('img')
}

/** Picks the image model in the composer from the picker's "Image models" group. */
async function pickImageModel(page: Page): Promise<void> {
  const trigger = composer(page).getByTestId(testIds.modelPickerTrigger)
  await expect(trigger).toHaveAttribute('data-model-ref', /.+/)
  await trigger.click()
  const picker = page.getByTestId(testIds.modelPicker)
  const group = byTestId(picker, testIds.modelPickerGroup, { 'data-value': 'images' })
  await expect(group).toBeVisible()
  await byTestId(group, testIds.modelPickerItem, { 'data-model-ref': IMAGE_MODEL }).click()
  await expect(picker).toBeHidden()
  await expect(trigger).toHaveAttribute('data-model-ref', IMAGE_MODEL)
}

/** Chooses one item of the image options menu (the menu closes after each pick). */
async function pickImageOption(page: Page, id: typeof testIds.imageAspectOption | typeof testIds.imageCountOption, value: string): Promise<void> {
  const trigger = composer(page).getByTestId(testIds.imageOptionsTrigger)
  await trigger.click()
  await byTestId(page, id, { 'data-value': value }).click()
  await expect(byTestId(page, id)).toHaveCount(0)
}

test.describe('images', () => {
  test('an image turn shows placeholders, then a gallery; regenerate adds a version; the lightbox pages and downloads @smoke', async ({ page, api, cleanup }) => {
    test.setTimeout(90_000)
    const prompt = `A slow watercolor of a lighthouse ${uniqueId('image')}`

    await openNewChat(page)
    await pickImageModel(page)
    // An image model: the prompt placeholder and the image options instead of effort, permission and the context ring.
    const input = page.getByTestId(testIds.composerInput)
    await expect(input).toHaveAttribute('placeholder', 'Describe an image…')
    const options = composer(page).getByTestId(testIds.imageOptionsTrigger)
    await expect(options).toHaveAccessibleName('Image options: Auto, 1 image')
    await expect(composer(page).getByTestId(testIds.effortMenuTrigger)).toHaveCount(0)
    await expect(composer(page).getByTestId(testIds.permissionMenuTrigger)).toHaveCount(0)
    await expect(composer(page).getByTestId(testIds.contextRing)).toHaveCount(0)

    // 16:9, two images. "Edit the previous image" needs a reply with images, so a new chat does not offer it.
    await options.click()
    await expect(page.getByTestId(testIds.imageAspectOption)).toHaveCount(8)
    await expect(page.getByTestId(testIds.imageCountOption)).toHaveCount(4)
    await expect(page.getByTestId(testIds.imageEditPrevious)).toHaveCount(0)
    await byTestId(page, testIds.imageAspectOption, { 'data-value': '16:9' }).click()
    await expect(page.getByTestId(testIds.imageAspectOption)).toHaveCount(0)
    await expect(options).toHaveAccessibleName('Image options: 16:9, 1 image')
    await pickImageOption(page, testIds.imageCountOption, '2')
    await expect(options).toHaveAccessibleName('Image options: 16:9, 2 images')
    await expect(options).toContainText('16:9 · 2')

    await sendMessage(page, prompt)
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))

    // While the model works (5 s): two placeholder tiles and the counter, then the gallery replaces them.
    const reply = lastAssistantMessage(page)
    const generating = reply.getByTestId(testIds.imageGenerating)
    await expect(generating).toHaveAttribute('data-count', '2')
    await expect(generating).toHaveAttribute('aria-busy', 'true')
    await expect(generating).toContainText(/Generating 2 images… \d+s/)
    await expect(reply).toHaveAttribute('data-status', 'streaming')
    const gallery = reply.getByTestId(testIds.imageGallery)
    await expect(gallery).toHaveAttribute('data-count', '2', { timeout: IMAGE_TURN_TIMEOUT })
    await expect(generating).toHaveCount(0)
    await expectMessageStatus(reply, 'done')
    await expect(gallery.getByTestId(testIds.imageTile)).toHaveCount(2)
    for (const index of [0, 1]) {
      const image = tileImage(gallery, index)
      await expect(image).toHaveAttribute('alt', `Generated image ${index + 1} of 2`)
      await expect(image).toHaveAttribute('src', /^\/api\/files\/[\w-]+$/)
      // The 16:9 of the options reached the model: 320 x 180 px.
      expect(await naturalSize(image)).toEqual({ width: 320, height: 180 })
    }
    await expect(byTestId(gallery, testIds.imageTile, { 'data-index': '0' })).toHaveAccessibleName('Open image 1 of 2')
    // No text: no Copy and no Read aloud; Regenerate is there.
    await expect(reply.getByTestId(testIds.messageCopy)).toHaveCount(0)
    await expect(reply.getByTestId(testIds.messageReadAloud)).toHaveCount(0)

    // The server stored two file parts (never a data: URL) and the image metadata.
    const stored = (await api.getChat(chatId)).messages.at(-1)!
    const files = stored.parts.flatMap(part => (part.type === 'file' ? [part] : []))
    expect(files).toHaveLength(2)
    for (const file of files) {
      expect(file.url).toMatch(/^\/api\/files\/[\w-]+$/)
      expect(file.mediaType).toBe('image/png')
      expect(file.filename).toMatch(/\.png$/)
    }
    expect(stored.metadata?.image).toMatchObject({ n: 2, aspectRatio: '16:9' })
    expect(JSON.stringify(stored)).not.toContain('data:image')

    // The lightbox: the first image, Previous disabled, Next (focused) and ArrowLeft page through, Download is a
    // same-origin link named by the stored file name; Esc closes it and focus returns to the tile.
    const firstTile = byTestId(gallery, testIds.imageTile, { 'data-index': '0' })
    await firstTile.click()
    const lightbox = page.getByTestId(testIds.imageLightbox)
    await expect(lightbox).toBeVisible()
    await expect(lightbox).toHaveAttribute('data-index', '0')
    const previous = lightbox.getByRole('button', { name: 'Previous image' })
    const next = lightbox.getByRole('button', { name: 'Next image' })
    await expect(previous).toHaveAttribute('aria-disabled', 'true')
    await expect(next).toBeFocused()
    await expect(lightbox).toContainText('1 / 2')
    const download = lightbox.getByTestId(testIds.imageDownload)
    await expect(download).toHaveAttribute('href', files[0]!.url)
    await expect(download).toHaveAttribute('download', files[0]!.filename!)
    await next.click()
    await expect(lightbox).toHaveAttribute('data-index', '1')
    await expect(lightbox).toContainText('2 / 2')
    await expect(next).toHaveAttribute('aria-disabled', 'true')
    await expect(download).toHaveAttribute('href', files[1]!.url)
    await page.keyboard.press('ArrowLeft')
    await expect(lightbox).toHaveAttribute('data-index', '0')
    const downloading = page.waitForEvent('download')
    await download.click()
    const saved = await downloading
    expect(saved.suggestedFilename()).toBe(files[0]!.filename)
    expect(new URL(saved.url()).origin).toBe(new URL(page.url()).origin)
    const bytes = await readFile(await saved.path())
    expect([...bytes.subarray(0, 4)]).toEqual(PNG_MAGIC)
    await page.keyboard.press('Escape')
    await expect(lightbox).toBeHidden()
    await expect(firstTile).toBeFocused()

    // Regenerate: a new version of the reply (a new image turn, placeholders again), then "‹ 2/2 ›" on it.
    await reply.getByTestId(testIds.messageRegenerate).click()
    await expect(reply.getByTestId(testIds.imageGenerating)).toHaveAttribute('data-count', '2')
    await expect(reply.getByTestId(testIds.imageGallery)).toHaveAttribute('data-count', '2', { timeout: IMAGE_TURN_TIMEOUT })
    await expectMessageStatus(reply, 'done')
    const switcher = reply.getByTestId(testIds.messageBranch)
    await expect(switcher).toHaveAttribute('data-count', '2')
    await expect(switcher).toHaveAttribute('data-index', '1')
    await expect(switcher.getByTestId(testIds.messageBranchCounter)).toHaveText('2/2')
    // The previous version still has its gallery.
    await switcher.getByTestId(testIds.messageBranchPrevious).click()
    await expect(switcher).toHaveAttribute('data-index', '0')
    await expect(reply).toHaveAttribute('data-message-id', stored.id)
    await expect(reply.getByTestId(testIds.imageGallery)).toHaveAttribute('data-count', '2')
  })

  test('a chat model with image output answers with text and an image @smoke', async ({ page, cleanup }) => {
    const text = `Draw a small cabin ${uniqueId('imagechat')}`

    await openNewChat(page)
    await selectModel(page, 'mock:image-chat')
    // A chat model with image output offers the aspect ratio only.
    const options = composer(page).getByTestId(testIds.imageOptionsTrigger)
    await options.click()
    await expect(page.getByTestId(testIds.imageAspectOption)).toHaveCount(8)
    await expect(page.getByTestId(testIds.imageCountOption)).toHaveCount(0)
    await byTestId(page, testIds.imageAspectOption, { 'data-value': '3:2' }).click()
    await expect(options).toHaveAccessibleName('Image options: 3:2')
    await expect(page.getByTestId(testIds.composerInput)).toHaveAttribute('placeholder', 'Ask anything…')

    await sendMessage(page, text)
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText(`Image for: ${text}`)
    const gallery = reply.getByTestId(testIds.imageGallery)
    await expect(gallery).toHaveAttribute('data-count', '1')
    await expect(gallery.getByTestId(testIds.imageTile)).toHaveCount(1)
    const image = tileImage(gallery, 0)
    await expect(image).toHaveAttribute('src', /^\/api\/files\/[\w-]+$/)
    await expect(image).toHaveAttribute('alt', 'Generated image 1 of 1')
    // 3:2 went to the model through the provider options: 318 x 212 px.
    expect(await naturalSize(image)).toEqual({ width: 318, height: 212 })
    // The reply has text: Copy is there.
    await expect(reply.getByTestId(testIds.messageCopy)).toBeVisible()
  })

  test.describe('generate_image', () => {
    test.beforeEach(async ({ api }) => {
      // An "Always allow" left on this data directory would skip the approval card.
      await api.client.tools.update({ params: { name: TOOL_NAME }, body: { override: null } })
    })

    test('the tool asks for approval, then shows the image below the tool row @smoke', async ({ page, api, cleanup }) => {
      const before = mediaSettingsOf(await api.getSettings())
      cleanup(api => api.updateSettings({ imageModelRef: before.imageModelRef }))
      await api.updateSettings({ imageModelRef: IMAGE_MODEL })
      const text = `Paint a red fox ${uniqueId('imagetool')}`

      await openNewChat(page)
      await selectModel(page, 'mock:image-tool')
      await selectPermissionMode(page, 'ask')
      await sendMessage(page, text)
      await expect(page).toHaveURL(CHAT_URL_PATTERN)
      const chatId = chatIdFromUrl(page)
      cleanup(api => api.removeChat(chatId))

      const reply = lastAssistantMessage(page)
      const row = byTestId(reply, testIds.toolRow, { 'data-tool-name': TOOL_NAME })
      const card = byTestId(reply, testIds.toolApproval, { 'data-tool-name': TOOL_NAME })
      await expect(card).toBeVisible()
      await expect(card).toContainText(`Allow ${TOOL_NAME}?`)
      await expect(card).toContainText(text)
      await expect(row).toHaveAttribute('data-state', 'approval-requested')

      await card.getByTestId(testIds.toolApprovalAllow).click()
      await expect(card).toBeHidden()
      await expect(row).toHaveAttribute('data-state', 'output-available')
      const gallery = reply.getByTestId(testIds.imageGallery)
      await expect(gallery).toHaveAttribute('data-count', '1')
      await expect(tileImage(gallery, 0)).toHaveAttribute('src', /^\/api\/files\/[\w-]+$/)
      await expect(reply).toContainText('Image tool result: 1 image(s)')
      await expectMessageStatus(reply, 'done')
      // The image sits below the tool row.
      const rowBox = await boxOf(row)
      const galleryBox = await boxOf(gallery)
      expect(galleryBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height)

      // Stored: the tool call, then the image as a file part of the reply.
      const stored = (await api.getChat(chatId)).messages.at(-1)!
      const kinds = stored.parts.map(part => part.type).filter(type => type !== 'step-start')
      expect(kinds.indexOf(`tool-${TOOL_NAME}`)).toBeGreaterThanOrEqual(0)
      expect(kinds.indexOf('file')).toBeGreaterThan(kinds.indexOf(`tool-${TOOL_NAME}`))
    })
  })
})
