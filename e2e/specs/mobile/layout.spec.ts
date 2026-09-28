// Mobile layout (docs/UI.md 14.5, 14.6), project `mobile` (Pixel 7 at 390x844): no page scrolls sideways at 390 px,
// and the composer stays fully inside the viewport, on the empty state and under a long transcript.
import type { Locator, Page } from '@playwright/test'
import {
  boxOf,
  byTestId,
  composer,
  documentWidths,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  test,
  testIds,
  uniqueId,
  wordList,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }

/** A reply that stresses the layout: a long unbroken link, a wide code line, a list and plenty of text. */
function wideMarkdown(token: string): string {
  return [
    `Layout check ${token}`,
    '',
    `See https://example.com/${'very-long-path-segment-'.repeat(6)}${token} for details.`,
    '',
    '```ts',
    `const wide = ${JSON.stringify(wordList(40, 'w').join('_'))} // ${token}`,
    '```',
    '',
    '- first point of the list',
    '- second point of the list',
    '',
    wordList(80, 'text').join(' '),
  ].join('\n')
}

interface PageCheck {
  path: string
  /** Visible once the page rendered its content. */
  ready: (page: Page) => Locator
}

async function expectNoSidewaysScroll(page: Page, path: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${path} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

async function expectInsideViewport(target: Locator, name: string): Promise<void> {
  const box = await boxOf(target)
  expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0)
  expect(box.y, `${name} top edge`).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(VIEWPORT.width)
  expect(box.y + box.height, `${name} bottom edge`).toBeLessThanOrEqual(VIEWPORT.height)
}

test.describe('mobile layout', () => {
  test('no page scrolls sideways at 390 px', async ({ page, api, cleanup }) => {
    const { chatId } = await api.sendChat({ modelRef: 'mock:echo', text: wideMarkdown(uniqueId('wide')) })
    cleanup(api => api.removeChat(chatId))

    const pages: PageCheck[] = [
      { path: '/', ready: page => page.getByTestId(testIds.emptyGreeting) },
      { path: `/chat/${chatId}`, ready: page => byTestId(page, testIds.messageAssistant, { 'data-status': 'done' }) },
      { path: '/plugins', ready: page => byTestId(page, testIds.pluginCard, { 'data-plugin-id': 'core-tools' }) },
      { path: '/plugins/core-tools', ready: page => page.getByTestId(testIds.pluginDetail) },
      { path: '/settings/providers', ready: page => byTestId(page, testIds.providerRow, { 'data-provider-id': 'mock' }) },
      { path: '/settings/models', ready: page => byTestId(page, testIds.modelsSection, { 'data-provider-id': 'mock' }) },
      { path: '/settings/general', ready: page => page.getByTestId(testIds.settingsInstructions) },
      { path: '/settings/appearance', ready: page => page.getByTestId(testIds.appearanceShowThinking) },
      { path: '/settings/data', ready: page => page.getByTestId(testIds.pageHeader).filter({ hasText: 'Data' }) },
      { path: '/settings/about', ready: page => page.getByTestId(testIds.aboutCopyDiagnostics) },
    ]
    for (const { path, ready } of pages) {
      await page.goto(path)
      await expect(ready(page), `${path} rendered`).toBeVisible()
      await expectNoSidewaysScroll(page, path)
    }
  })

  test('the composer stays inside the viewport', async ({ page, api, cleanup }) => {
    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    await expectInsideViewport(composer(page), 'the composer of a new chat')

    // Under a transcript taller than the screen, the composer is docked at the bottom, above the safe area.
    const token = uniqueId('dock')
    const { chatId } = await api.sendChat({ modelRef: 'mock:echo', text: wideMarkdown(token) })
    cleanup(api => api.removeChat(chatId))
    await api.sendChat({ chatId, modelRef: 'mock:echo', text: `Second turn ${token} ${wordList(120, 'more').join(' ')}` })
    await page.goto(`/chat/${chatId}`)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(lastAssistantMessage(page)).toContainText(`Second turn ${token}`)
    const dock = composer(page)
    await expectInsideViewport(dock, 'the docked composer')
    await expectInsideViewport(page.getByTestId(testIds.composerSend), 'the send button')
    await expectNoSidewaysScroll(page, 'the long chat')
  })
})
