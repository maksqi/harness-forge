// MCP resources in `@` mentions (Phase 14, ADR-061; docs/UI.md 2.20, 7.35; docs/API.md 4.38): the resources of a
// connected MCP server (the OAuth fixture without OAuth, a personal HTTP server: `fixture://notes/readme.md`,
// `fixture://notes/large.txt` of 6 MiB and `fixture://images/pixel.png`) join the composer's `@` menu in every chat with
// tools on (`mock:hooks`).
// - A chat without a project: `@` lists only "MCP resources"; a pick inserts `@<server>:<uri>` and attaches the resource
//   as a chip (`composer-attachment[data-kind=resource]`) that the sent message carries; the large resource is refused
//   with "This resource is larger than 5 MB." and leaves no chip.
// - A project chat: one listbox "Files and MCP resources" with both sections (files first); the arrow keys run across
//   both.
import type { Page } from '@playwright/test'
import type { CleanupTask, HarnessApi } from '../../helpers/index.ts'
import {
  addHttpMcpServer,
  byTestId,
  composer,
  expect,
  expectMessageStatus,
  LARGE_URI,
  lastAssistantMessage,
  MOCK_HOOKS_MODEL,
  PIXEL_URI,
  README_URI,
  seedProjectChat,
  startOAuthFixture,
  test,
  testIds,
  toastWith,
  uniqueId,
  userMessages,
  waitForMcpStatus,
} from '../../helpers/index.ts'

/** A connected fixture server (no OAuth) with its three resources. */
async function addResourceServer(api: HarnessApi, cleanup: (task: CleanupTask) => void): Promise<{ id: string, name: string }> {
  const fixture = await startOAuthFixture({ noAuth: true }, cleanup)
  const id = uniqueId('res')
  const name = `Notes ${id}`
  await addHttpMcpServer(api, cleanup, { id, name, url: fixture.url })
  await waitForMcpStatus(api, id, 'connected')
  return { id, name }
}

function mentionMenu(page: Page) {
  return page.getByTestId(testIds.mentionMenu)
}

function resourceRow(page: Page, serverId: string, uri: string) {
  return byTestId(mentionMenu(page), testIds.mentionMenuResource, { 'data-server-id': serverId, 'data-uri': uri })
}

function section(page: Page, value: 'files' | 'resources') {
  return byTestId(mentionMenu(page), testIds.mentionMenuSection, { 'data-value': value })
}

test.describe('MCP resources in mentions', () => {
  test('a chat without a project lists MCP resources; a pick inserts the mention and attaches the resource @smoke', async ({ page, api, cleanup }) => {
    const server = await addResourceServer(api, cleanup)
    const chat = await api.createChat({ title: `Resources ${server.id}`, modelRef: MOCK_HOOKS_MODEL })
    cleanup(api => api.removeChat(chat.id))
    await page.goto(`/chat/${chat.id}`)
    const input = page.getByTestId(testIds.composerInput)
    await input.click()
    await page.keyboard.type('Summarize @')

    const menu = mentionMenu(page)
    await expect(menu).toBeVisible()
    await expect(section(page, 'resources')).toBeVisible()
    await expect(section(page, 'resources')).toContainText('MCP resources')
    await expect(section(page, 'files')).toHaveCount(0)
    for (const uri of [README_URI, LARGE_URI, PIXEL_URI])
      await expect(resourceRow(page, server.id, uri)).toBeVisible()
    await expect(resourceRow(page, server.id, README_URI).locator('[data-slot="mention-resource-server"]')).toHaveText(server.name)

    // A query narrows the list; Enter picks the highlighted resource.
    await page.keyboard.type('readme')
    await expect(menu.getByTestId(testIds.mentionMenuResource).first()).toHaveAttribute('data-uri', README_URI)
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(input).toHaveValue(`Summarize @${server.id}:${README_URI} `)
    const chip = byTestId(composer(page), testIds.composerAttachment, { 'data-kind': 'resource', 'data-server-id': server.id })
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveAttribute('data-state', 'done')

    // The large resource is refused: a toast, no chip.
    await page.keyboard.type('and @large')
    await expect(resourceRow(page, server.id, LARGE_URI)).toBeVisible()
    await resourceRow(page, server.id, LARGE_URI).click()
    await expect(toastWith(page, 'This resource is larger than 5 MB.')).toBeVisible()
    await expect(byTestId(composer(page), testIds.composerAttachment, { 'data-kind': 'resource' })).toHaveCount(1)

    // The message carries the attachment.
    await input.fill(`Summarize @${server.id}:${README_URI}`)
    await page.getByTestId(testIds.composerSend).click()
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(userMessages(page).last()).toContainText(`@${server.id}:${README_URI}`)
    const sent = (await api.getChat(chat.id)).messages.find(message => message.role === 'user')
    expect(sent?.parts.filter(part => part.type === 'file')).toHaveLength(1)
  })

  test('a project chat lists files and MCP resources in one listbox; the arrows run across both', async ({ page, api, cleanup }) => {
    const server = await addResourceServer(api, cleanup)
    const { chatId, project } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_HOOKS_MODEL,
      prefix: 'res',
      files: { 'README.md': '# Notes\n', 'docs/readme-extra.md': 'More notes.\n' },
    })
    await page.goto(`/chat/${chatId}`)
    const input = page.getByTestId(testIds.composerInput)
    await input.click()
    await page.keyboard.type('Compare @readme')

    const menu = mentionMenu(page)
    await expect(menu).toHaveAttribute('role', 'listbox')
    await expect(menu).toHaveAccessibleName('Files and MCP resources')
    await expect(section(page, 'files')).toContainText(`Files in ${project.name}`)
    await expect(section(page, 'resources')).toContainText('MCP resources')
    const files = menu.getByTestId(testIds.mentionMenuItem)
    await expect(byTestId(menu, testIds.mentionMenuItem, { 'data-path': 'README.md' })).toBeVisible()
    await expect(resourceRow(page, server.id, README_URI)).toBeVisible()
    // Files come first; the arrow keys move from the last file to the first resource.
    const fileCount = await files.count()
    expect(fileCount).toBeGreaterThan(0)
    for (let index = 0; index < fileCount; index += 1)
      await page.keyboard.press('ArrowDown')
    const activeId = await input.getAttribute('aria-activedescendant')
    expect(activeId).toBeTruthy()
    await expect(menu.locator(`[id="${activeId}"]`)).toHaveAttribute('data-uri', README_URI)
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue(`Compare @${server.id}:${README_URI} `)
    await expect(byTestId(composer(page), testIds.composerAttachment, { 'data-kind': 'resource', 'data-server-id': server.id })).toHaveAttribute('data-state', 'done')
  })
})
