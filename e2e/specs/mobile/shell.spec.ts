// Mobile app shell (docs/UI.md 2.6, 14.5, 14.6), project `mobile` (Pixel 7 at 390x844, touch): below `md` the sidebar
// is a sheet opened from the header's trigger that closes after a navigation, and its rows are touch targets of at
// least 40x40 px.
import {
  boxOf,
  chatRow,
  expect,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }
/** The sheet is 18rem wide (`SIDEBAR_WIDTH_MOBILE`): about 288 px, never the whole screen. */
const SHEET_MIN_WIDTH = 256

test.describe('mobile shell', () => {
  test('the sidebar is a sheet from the header that closes after a navigation', async ({ page, api, cleanup }) => {
    const chat = await api.createChat({ title: `Mobile sheet ${uniqueId('mobile')}` })
    cleanup(api => api.removeChat(chat.id))

    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    const sidebar = page.getByTestId(testIds.sidebar)
    await expect(sidebar).toBeHidden()

    // The header's trigger opens the sheet: a dialog along the left edge, full height, narrower than the screen.
    const trigger = page.getByTestId(testIds.sidebarTrigger)
    const triggerSize = await touchTargetSize(trigger)
    expect(Math.min(triggerSize.width, triggerSize.height), 'the sidebar trigger').toBeGreaterThanOrEqual(40)
    await trigger.tap()
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')
    const sheet = page.getByRole('dialog').filter({ has: sidebar })
    await expect(sheet).toBeVisible()
    await expect.poll(async () => {
      const box = await boxOf(sheet)
      return { left: Math.round(box.x), top: Math.round(box.y), bottom: Math.round(box.y + box.height) }
    }).toEqual({ left: 0, top: 0, bottom: VIEWPORT.height })
    const sheetBox = await boxOf(sheet)
    expect(sheetBox.width).toBeGreaterThanOrEqual(SHEET_MIN_WIDTH)
    expect(sheetBox.width).toBeLessThan(VIEWPORT.width)

    // Its rows are touch targets.
    const rows = {
      'new chat': page.getByTestId(testIds.newChat),
      'search': page.getByTestId(testIds.searchChats),
      'chat row': chatRow(page, chat.id),
      'settings': page.getByTestId(testIds.settingsLink),
    }
    for (const [name, row] of Object.entries(rows)) {
      await expect(row, name).toBeVisible()
      const size = await touchTargetSize(row)
      expect(size.height, `${name} height`).toBeGreaterThanOrEqual(40)
      expect(size.width, `${name} width`).toBeGreaterThanOrEqual(40)
    }

    // Opening a chat closes the sheet; the chat header has the trigger too.
    await chatRow(page, chat.id).tap()
    await expect(page).toHaveURL(new RegExp(`/chat/${chat.id}$`))
    await expect(sidebar).toBeHidden()
    await expect(page.getByTestId(testIds.chatTitle)).toHaveText(chat.title ?? '')

    await page.getByTestId(testIds.sidebarTrigger).tap()
    await expect(sidebar).toBeVisible()
    await page.getByTestId(testIds.modeTabPlugins).tap()
    await expect(page).toHaveURL(/\/plugins$/)
    await expect(sidebar).toBeHidden()
    await expect(page.getByTestId(testIds.pluginCard).first()).toBeVisible()
  })
})
