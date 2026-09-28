// App shell navigation (docs/UI.md 5.1-5.3, 12): the sidebar's Chat | Plugins mode tabs and the command palette
// (Mod+K), which searches chat titles and messages on the server.
import { byTestId, expect, pressShortcut, test, testIds, uniqueId } from '../../helpers/index.ts'

test.describe('navigation', () => {
  test('the sidebar switches between chat and plugins mode @smoke', async ({ page, api }) => {
    const chat = await api.createChat({ title: `Mode switch ${uniqueId('nav')}` })
    try {
      const sidebar = page.getByTestId(testIds.sidebar)
      const chatTab = page.getByTestId(testIds.modeTabChat)
      const pluginsTab = page.getByTestId(testIds.modeTabPlugins)

      await page.goto(`/chat/${chat.id}`)
      await expect(page.getByTestId(testIds.chatTitle)).toHaveText(chat.title ?? '')
      await expect(sidebar).toHaveAttribute('data-mode', 'chat')
      await expect(chatTab).toHaveAttribute('data-state', 'active')
      await expect(pluginsTab).toHaveAttribute('data-state', 'inactive')
      await expect(page.getByTestId(testIds.chatList)).toBeVisible()

      await pluginsTab.click()
      await expect(page).toHaveURL(/\/plugins$/)
      await expect(sidebar).toHaveAttribute('data-mode', 'plugins')
      await expect(pluginsTab).toHaveAttribute('data-state', 'active')
      await expect(chatTab).toHaveAttribute('data-state', 'inactive')
      await expect(page.getByTestId(testIds.chatList)).toHaveCount(0)
      await expect(byTestId(sidebar, testIds.pluginNavRow, { 'data-plugin-id': 'core-providers' })).toBeVisible()

      // The Chat tab returns to the last chat route.
      await chatTab.click()
      await expect(page).toHaveURL(new RegExp(`/chat/${chat.id}$`))
      await expect(sidebar).toHaveAttribute('data-mode', 'chat')
      await expect(chatTab).toHaveAttribute('data-state', 'active')
      await expect(page.getByTestId(testIds.chatList)).toBeVisible()
    }
    finally {
      await api.deleteChat(chat.id)
    }
  })

  test('mod+k opens the command palette and finds a chat by its content @smoke', async ({ page, api }) => {
    // A real conversation whose unique word comes after the eighth word, so it is in the messages but not in the
    // automatic title (the first eight words): only the server-side search can find it.
    const token = uniqueId('palette')
    const { chatId } = await api.sendChat({ modelRef: 'mock:echo', text: `Palette search seed one two three four five ${token}` })
    const title = await api.waitForChatTitle(chatId)
    expect(title).not.toContain(token)
    expect((await api.searchChats(token)).map(chat => chat.id)).toEqual([chatId])

    try {
      await page.goto('/')
      await expect(page.getByTestId(testIds.composerInput)).toBeEditable()

      await pressShortcut(page, 'Mod+K')
      const palette = page.getByTestId(testIds.commandPalette)
      await expect(palette).toBeVisible()
      const input = palette.getByTestId(testIds.commandPaletteInput)
      await expect(input).toBeFocused()
      await input.fill(token)

      const result = byTestId(palette, testIds.commandPaletteItem, { 'data-value': `chat:${chatId}` })
      await expect(result).toBeVisible()
      await expect(result).toContainText(title)
      await result.click()

      await expect(palette).toBeHidden()
      await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`))
      await expect(page.getByTestId(testIds.chatTitle)).toHaveText(title)
      await expect(page.getByTestId(testIds.messageUser)).toContainText(token)
    }
    finally {
      await api.deleteChat(chatId)
    }
  })
})
