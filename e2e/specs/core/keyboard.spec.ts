// Keyboard-only use of the app (docs/UI.md 12, 14.1): every step below is a key press, never a click, and each one
// leaves focus where the next step needs it (`toBeFocused()` after every step). Covered: Mod+Shift+O (new chat),
// Alt+M (model picker: type, Enter picks), Enter (send), Esc (stop), Shift+Esc (focus the composer), ↑ in an empty
// composer (edit the last user message), Alt+R (effort menu), Alt+P (permission menu), Tab / Enter on the approval
// card, Mod+/ (shortcuts dialog), Mod+B (sidebar) and Mod+K (command palette). The edit step only checks that the
// edited text is the last user message and that a reply streams, so it holds for in-place edits and for branches.
// Phase 8 (W8.12): Alt+C shows and hides the changes panel of a project chat (also from the composer; opening focuses
// the active view tab, closing from inside the panel returns focus to the toggle), the shortcuts dialog lists it, and a
// chat without a project ignores it.
// Phase 9 (W9.13): in a project chat Shift+Tab in the composer switches Ask -> Accept edits -> Plan -> Ask (announced,
// focus kept) and the shortcuts dialog lists it; Enter while a reply runs queues the message; Esc closes the `@` mention
// menu first (the reply keeps running), then stops the reply, and the queued message comes back into the composer.
import type { Locator, Page } from '@playwright/test'
import type { TestId } from '../../helpers/index.ts'
import {
  byTestId,
  changesPanel,
  changesToggle,
  changesViewTab,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  composer,
  composerAnnouncement,
  expect,
  expectMessageStatus,
  expectStreamingWith,
  lastAssistantMessage,
  looseQuotes,
  MOCK_CHECKPOINT_DONE,
  openNewChat,
  pressShortcut,
  pressUntilFocused,
  seedProject,
  seedProjectChat,
  selectAllText,
  test,
  testIds,
  uniqueId,
  userMessages,
  wordList,
} from '../../helpers/index.ts'

const TOOL_NAME = 'mock_approval_tool'

function composerInput(page: Page): Locator {
  return page.getByTestId(testIds.composerInput)
}

/** Alt+M, then the model ref typed into the picker's search (a search shows each model once) and Enter. */
async function pickModel(page: Page, modelRef: string): Promise<void> {
  await page.keyboard.press('Alt+KeyM')
  const picker = page.getByTestId(testIds.modelPicker)
  await expect(picker).toBeVisible()
  const search = picker.getByTestId(testIds.modelPickerSearch)
  await expect(search).toBeFocused()
  await page.keyboard.type(modelRef)
  await expect(picker.getByTestId(testIds.modelPickerItem)).toHaveCount(1)
  await expect(byTestId(picker, testIds.modelPickerItem, { 'data-model-ref': modelRef })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(picker).toBeHidden()
  await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', modelRef)
  await expect(composerInput(page)).toBeFocused()
}

/**
 * Opens a composer radio menu with its Alt shortcut (focus starts on the checked option), moves to `value` with the
 * arrow keys and picks it with Enter; focus returns to the composer.
 */
async function pickMenuOption(page: Page, menu: { shortcut: string, option: TestId, trigger: TestId }, value: string): Promise<void> {
  const trigger = composer(page).getByTestId(menu.trigger)
  const current = await trigger.getAttribute('data-value')
  await page.keyboard.press(menu.shortcut)
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(byTestId(page, menu.option, { 'data-value': current ?? '' })).toBeFocused()
  await pressUntilFocused(page, 'ArrowDown', byTestId(page, menu.option, { 'data-value': value }), 8)
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toHaveAttribute('data-value', value)
  await expect(composerInput(page)).toBeFocused()
}

test.describe('keyboard', () => {
  test.beforeEach(async ({ api }) => {
    // An "Always allow" left on this data directory would skip the approval card.
    await api.client.tools.update({ params: { name: TOOL_NAME }, body: { override: null } })
  })

  test('a chat runs from the keyboard: new chat, model, send, stop, focus and edit @smoke', async ({ page, cleanup }) => {
    const token = uniqueId('keys')
    // 400 words stream for about 10 s: plenty of time for Esc.
    const text = `Keyboard check ${token} ${wordList(400, 'k').join(' ')} end-${token}`
    // 120 words stream for about 3 s: the edit's reply is seen streaming.
    const edited = `Edited keyboard check ${token} ${wordList(120, 'e').join(' ')} edit-end-${token}`

    // Start anywhere else: Mod+Shift+O opens a new chat with the composer focused.
    await page.goto('/plugins')
    await expect(page.getByTestId(testIds.pageHeader)).toBeVisible()
    await pressShortcut(page, 'Mod+Shift+O')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    await expect(composerInput(page)).toBeFocused()

    await pickModel(page, 'mock:echo')

    // Enter sends; the chat opens at /chat/<id> with the composer still focused.
    await page.keyboard.insertText(text)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    const reply = lastAssistantMessage(page)
    await expectStreamingWith(reply, `Keyboard check ${token}`)
    await expect(composerInput(page)).toBeFocused()
    await expect(composerInput(page)).toHaveValue('')

    // Esc stops the running reply; focus stays.
    await page.keyboard.press('Escape')
    await expectMessageStatus(reply, 'aborted')
    await expect(reply).not.toContainText(`end-${token}`)
    await expect(page.getByTestId(testIds.composerSend)).toBeVisible()
    await expect(composerInput(page)).toBeFocused()

    // Shift+Esc brings focus back to the composer from anywhere in the chat.
    await page.keyboard.press('Shift+Tab')
    await expect(composerInput(page)).not.toBeFocused()
    await page.keyboard.press('Shift+Escape')
    await expect(composerInput(page)).toBeFocused()

    // ↑ in the empty composer edits the last user message; Enter sends the edit and a reply streams. The text is
    // replaced from the keyboard with the host's select-all key (text editing follows the host, not the app's Mod).
    await page.keyboard.press('ArrowUp')
    const editor = page.getByTestId(testIds.messageEditInput)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(text)
    await selectAllText(page, editor)
    await page.keyboard.insertText(edited)
    await page.keyboard.press('Enter')
    await expect(editor).toBeHidden()
    // (Contains, not equals: with branches the edited message also shows its version switcher.)
    await expect(userMessages(page).last()).toContainText(edited)
    const editReply = lastAssistantMessage(page)
    await expectStreamingWith(editReply, `Edited keyboard check ${token}`)
    await expectMessageStatus(editReply, 'done', 15_000)
    await expect(editReply).toContainText(`edit-end-${token}`)
    await page.keyboard.press('Shift+Escape')
    await expect(composerInput(page)).toBeFocused()
  })

  test('the effort and permission menus and the approval card work from the keyboard @smoke', async ({ page, cleanup }) => {
    const text = `Keyboard approval ${uniqueId('keys')}`

    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    await expect(composerInput(page)).toBeFocused()

    // Alt+R: the reasoning effort of a reasoning model.
    await pickModel(page, 'mock:reasoning')
    await pickMenuOption(page, { shortcut: 'Alt+KeyR', option: testIds.effortOption, trigger: testIds.effortMenuTrigger }, 'low')

    // Alt+P: the permission mode of a model with tools (Auto, then back to Ask for the approval card).
    await pickModel(page, 'mock:tool-approval')
    const permission = { shortcut: 'Alt+KeyP', option: testIds.permissionOption, trigger: testIds.permissionMenuTrigger }
    await pickMenuOption(page, permission, 'auto')
    await page.keyboard.press('Alt+KeyP')
    await expect(byTestId(page, testIds.permissionOption, { 'data-value': 'auto' })).toBeFocused()
    await pressUntilFocused(page, 'ArrowUp', byTestId(page, testIds.permissionOption, { 'data-value': 'ask' }), 4)
    await page.keyboard.press('Enter')
    await expect(composer(page).getByTestId(testIds.permissionMenuTrigger)).toHaveAttribute('data-value', 'ask')
    await expect(composerInput(page)).toBeFocused()

    // The tool call waits for an approval; Shift+Tab reaches the card, Tab moves Deny -> Allow, Enter allows.
    await page.keyboard.insertText(text)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    const reply = lastAssistantMessage(page)
    const card = byTestId(reply, testIds.toolApproval, { 'data-tool-name': TOOL_NAME })
    await expect(card).toBeVisible()
    await expect(composerInput(page)).toBeFocused()
    await pressUntilFocused(page, 'Shift+Tab', card.getByTestId(testIds.toolApprovalDeny))
    await page.keyboard.press('Tab')
    await expect(card.getByTestId(testIds.toolApprovalAllow)).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(card).toBeHidden()
    const row = byTestId(reply, testIds.toolRow, { 'data-tool-name': TOOL_NAME })
    await expect(row).toHaveAttribute('data-state', 'output-available')
    await expect(reply).toContainText(looseQuotes(`Tool result: {"echoed":"${text}"}`))
    await expectMessageStatus(reply, 'done')
    await page.keyboard.press('Shift+Escape')
    await expect(composerInput(page)).toBeFocused()
  })

  test('the shortcuts dialog, the sidebar and the command palette open from the keyboard @smoke', async ({ page, api, cleanup }) => {
    // A chat with a word that only the server-side search finds (it comes after the eight words of the title).
    const token = uniqueId('keys')
    const { chatId } = await api.sendChat({ modelRef: 'mock:echo', text: `Keyboard palette seed one two three four five ${token}` })
    cleanup(api => api.removeChat(chatId))
    const title = await api.waitForChatTitle(chatId)

    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    await expect(composerInput(page)).toBeFocused()

    // Mod+/ toggles the shortcuts dialog, which takes focus and gives it back.
    const shortcuts = page.getByTestId(testIds.shortcutsDialog)
    await pressShortcut(page, 'Mod+/')
    await expect(shortcuts).toBeVisible()
    await expect(shortcuts).toBeFocused()
    await expect(shortcuts).toContainText('New chat')
    await expect(shortcuts).toContainText('Choose a model')
    await pressShortcut(page, 'Mod+/')
    await expect(shortcuts).toBeHidden()
    await expect(composerInput(page)).toBeFocused()

    // Mod+B collapses and expands the sidebar; focus stays in the composer. (The sidebar compares `event.key` with a
    // lowercase "b", which is what a real keyboard sends; Playwright's "B" would be the shifted letter.)
    const sidebar = page.getByTestId(testIds.sidebar)
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')
    await pressShortcut(page, 'Mod+b')
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
    await expect(composerInput(page)).toBeFocused()
    await pressShortcut(page, 'Mod+b')
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')
    await expect(composerInput(page)).toBeFocused()

    // Mod+K opens the palette on its input; Esc closes it and focus returns.
    const palette = page.getByTestId(testIds.commandPalette)
    const input = palette.getByTestId(testIds.commandPaletteInput)
    await pressShortcut(page, 'Mod+K')
    await expect(palette).toBeVisible()
    await expect(input).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await expect(composerInput(page)).toBeFocused()

    // Typing searches the chats; Enter opens the first result, whose composer takes focus.
    await pressShortcut(page, 'Mod+K')
    await expect(input).toBeFocused()
    await page.keyboard.type(token)
    const result = byTestId(palette, testIds.commandPaletteItem, { 'data-value': `chat:${chatId}` })
    await expect(result).toBeVisible()
    await expect(palette.getByTestId(testIds.commandPaletteItem).first()).toHaveAttribute('data-value', `chat:${chatId}`)
    await page.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`))
    await expect(page.getByTestId(testIds.chatTitle)).toHaveText(title)
    await expect(composerInput(page)).toBeFocused()
  })

  test('Alt+C shows and hides the changes panel of a project chat, also from the composer @smoke', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Keys ${uniqueId('changes')}` })
    const chat = await api.createChat({ title: `Keyboard changes ${uniqueId('chat')}`, projectId: project.id, modelRef: 'mock:checkpoint' })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: 'mock:checkpoint', toolMode: 'auto', text: 'Write the checkpoint.' })).text).toBe(MOCK_CHECKPOINT_DONE)
    const plain = await api.sendChat({ modelRef: 'mock:echo', text: `No project ${uniqueId('keys')}` })
    cleanup(api => api.removeChat(plain.chatId))

    await page.goto(`/chat/${chat.id}`)
    await expect(lastAssistantMessage(page)).toContainText(MOCK_CHECKPOINT_DONE)
    await page.keyboard.press('Shift+Escape')
    await expect(composerInput(page)).toBeFocused()

    // From the composer: Alt+C opens the panel on its active view tab; the arrow keys switch the views.
    const panel = changesPanel(page)
    const toggle = changesToggle(page)
    await page.keyboard.press('Alt+KeyC')
    await expect(panel).toBeVisible()
    await expect(toggle).toHaveAttribute('data-state', 'open')
    await expect(changesViewTab(page, 'chat')).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(changesViewTab(page, 'git')).toBeFocused()
    await expect(panel).toHaveAttribute('data-view', 'git')
    await page.keyboard.press('ArrowLeft')
    await expect(changesViewTab(page, 'chat')).toBeFocused()
    await expect(panel).toHaveAttribute('data-view', 'chat')

    // From inside the panel Alt+C closes it and focus goes to the toggle; Enter on the toggle opens it again.
    await page.keyboard.press('Alt+KeyC')
    await expect(panel).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(panel).toBeVisible()
    await expect(toggle).toBeFocused()

    // Back in the composer, Alt+C closes the panel and focus stays there.
    await page.keyboard.press('Shift+Escape')
    await expect(composerInput(page)).toBeFocused()
    await page.keyboard.press('Alt+KeyC')
    await expect(panel).toHaveCount(0)
    await expect(composerInput(page)).toBeFocused()

    // The shortcuts dialog lists it.
    const shortcuts = page.getByTestId(testIds.shortcutsDialog)
    await pressShortcut(page, 'Mod+/')
    await expect(shortcuts).toContainText('Show or hide changes')
    await pressShortcut(page, 'Mod+/')
    await expect(shortcuts).toBeHidden()
    await expect(composerInput(page)).toBeFocused()

    // A chat without a project has no toggle and ignores Alt+C.
    await page.goto(`/chat/${plain.chatId}`)
    await expect(lastAssistantMessage(page)).toHaveAttribute('data-status', 'done')
    await page.keyboard.press('Shift+Escape')
    await expect(composerInput(page)).toBeFocused()
    await expect(toggle).toHaveCount(0)
    await page.keyboard.press('Alt+KeyC')
    await expect(panel).toHaveCount(0)
    await expect(composerInput(page)).toBeFocused()
    await expect(composerInput(page)).toHaveValue('')
  })

  test('Shift+Tab switches the mode, Enter queues while a reply runs, Esc closes the mention menu before it stops @smoke', async ({ page, api, cleanup }) => {
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: 'mock:steer', prefix: 'keys', files: { 'notes.md': '# Notes\n' } })
    await page.goto(`/chat/${chatId}`)
    await page.keyboard.press('Shift+Escape')
    await expect(composerInput(page)).toBeFocused()

    // Shift+Tab cycles the permission mode of a project chat and keeps the focus in the composer.
    const trigger = composer(page).getByTestId(testIds.permissionMenuTrigger)
    for (const [mode, label] of [['edits', 'Accept edits'], ['plan', 'Plan'], ['ask', 'Ask']] as const) {
      await page.keyboard.press('Shift+Tab')
      await expect(trigger).toHaveAttribute('data-value', mode)
      await expect(composerAnnouncement(page, `Permission mode: ${label}`)).toHaveCount(1)
      await expect(composerInput(page)).toBeFocused()
    }

    // Enter sends; while the reply runs `@` opens the mention menu and Esc closes only the menu.
    await page.keyboard.insertText('steps 12')
    await page.keyboard.press('Enter')
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'streaming')
    await page.keyboard.type('@not')
    const menu = page.getByTestId(testIds.mentionMenu)
    await expect(byTestId(menu, testIds.mentionMenuItem, { 'data-path': 'notes.md' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(composerInput(page)).toHaveValue('@not')
    await expect(reply).toHaveAttribute('data-status', 'streaming')

    // Enter while the reply runs queues the message (a server command waits for the next turn).
    await selectAllText(page, composerInput(page))
    await page.keyboard.insertText('/compact')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId(testIds.slashMenu)).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(testIds.queuedMessages)).toHaveAttribute('data-count', '1')
    await expect(composerInput(page)).toHaveValue('')
    await expect(composerInput(page)).toBeFocused()

    // Esc stops the reply; the queued message comes back into the composer.
    await page.keyboard.press('Escape')
    await expectMessageStatus(reply, 'aborted')
    await expect(page.getByTestId(testIds.queuedMessages)).toHaveCount(0)
    await expect(composerInput(page)).toHaveValue('/compact')
    await expect(composerInput(page)).toBeFocused()
  })

  // The display-only Shift+Tab entry of the shortcuts dialog (docs/UI.md 12: "Switch the permission mode", group
  // Composer), registered by `useComposerShortcuts.ts`.
  test('the shortcuts dialog lists Shift+Tab @smoke', async ({ page }) => {
    await openNewChat(page)
    const shortcuts = page.getByTestId(testIds.shortcutsDialog)
    await pressShortcut(page, 'Mod+/')
    await expect(shortcuts).toContainText('Switch the permission mode')
  })
})
