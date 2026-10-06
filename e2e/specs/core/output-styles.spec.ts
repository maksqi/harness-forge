// Output styles (docs/UI.md 7.32, 9.4, 9.13; ADR-051) with `mock:hooks` (docs/PROVIDERS.md 8 "Hook mocks (Phase 11)":
// `style?` answers `Style: <label> | workspace-rules: <yes|no> | todo-hint: <yes|no>` from the first line of the system
// text, so it proves that the style block comes first and whether the coding instructions stayed).
// - Settings -> Customize -> Output styles lists the built-ins (Default, Explanatory, Learning); a new personal style
//   with "Keep coding instructions" is saved, "Use by default" makes it the global default ("Your default", Settings ->
//   General shows it), and a new chat on Automatic uses it; a style picked on the new-chat page travels with the first
//   message and is saved with the chat; "Manage output styles" opens the tab.
// - A project's style is what Automatic resolves to in its chats ("Uses {name}, set for {project}"), without the coding
//   instructions (`keep-coding-instructions` off); a chat's own choice from the menu and from `/output-style <name>`
//   survives a reload, `/output-style` alone opens the menu, an unknown name is refused, `/output-style auto` goes back.
import type { Page } from '@playwright/test'
import {
  byTestId,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  chooseRowAction,
  cleanupPersonalDefinition,
  composer,
  customizationRow,
  customizeSection,
  definitionFile,
  expect,
  expectMessageStatus,
  fillMarkdownEditor,
  lastAssistantMessage,
  MOCK_HOOKS_MODEL,
  openNewChat,
  personalDefinition,
  seedProjectChat,
  selectModel,
  sendMessage,
  test,
  testIds,
  toastWith,
  uniqueId,
} from '../../helpers/index.ts'

function styleTrigger(page: Page) {
  return composer(page).getByTestId(testIds.outputStyleTrigger)
}

function styleOption(page: Page, value: string) {
  return byTestId(page, testIds.outputStyleOption, { 'data-value': value })
}

/** Sends `style?` and waits for the finished `mock:hooks` answer. */
async function askStyle(page: Page, expected: string): Promise<void> {
  await sendMessage(page, 'style?')
  const reply = lastAssistantMessage(page)
  await expect(reply).toContainText(expected)
  await expectMessageStatus(reply, 'done')
}

/** Types a client command into the composer and presses Enter. */
async function runCommand(page: Page, text: string): Promise<void> {
  const input = page.getByTestId(testIds.composerInput)
  await input.fill(text)
  await input.press('Enter')
}

test.describe('output styles', () => {
  test('the Output styles tab: built-ins, a new personal style used by default in General and in new chats @smoke', async ({ page, api, cleanup }) => {
    const before = (await api.getSettings()).outputStyle
    cleanup(() => api.updateSettings({ outputStyle: before }))
    const name = uniqueId('terse')
    cleanupPersonalDefinition(cleanup, 'style', name)

    await page.goto('/settings/customize?tab=output-styles')
    await expect(byTestId(page, testIds.customizeTab, { 'data-value': 'output-styles' })).toHaveAttribute('data-state', 'active')
    for (const builtin of ['default', 'explanatory', 'learning'])
      await expect(customizationRow(customizeSection(page, 'builtin'), { 'data-name': builtin, 'data-kind': 'style' })).toBeVisible()
    await expect(page.getByTestId(testIds.customizeStyleDefault)).toHaveAttribute('data-value', before)

    // A new personal style that keeps the coding instructions.
    const newButton = page.getByTestId(testIds.customizeNew)
    await expect(newButton).toHaveAttribute('data-kind', 'style')
    await newButton.click()
    const editor = page.getByTestId(testIds.customizationEditor)
    await expect(editor).toHaveAttribute('data-kind', 'style')
    await editor.getByTestId(testIds.customizationName).fill(name)
    await editor.getByTestId(testIds.customizationDescription).fill('Short, direct answers.')
    const keep = editor.getByTestId(testIds.customizationKeepCoding)
    await expect(keep).toHaveAttribute('data-state', 'unchecked')
    await keep.click()
    await expect(keep).toHaveAttribute('data-state', 'checked')
    await fillMarkdownEditor(page, editor.getByTestId(testIds.customizationBody), 'Answer in short sentences.\n')
    const save = editor.getByTestId(testIds.customizationSave)
    await expect(save).toHaveText('Save output style')
    await save.click()
    await expect(toastWith(page, 'Output style saved')).toBeVisible()
    await expect(editor).toBeHidden()
    const row = customizationRow(customizeSection(page, 'user'), { 'data-name': name, 'data-kind': 'style' })
    await expect(row).toHaveAttribute('data-state', 'active')
    await expect(row).toContainText('Short, direct answers.')
    await expect(row).toContainText('Keeps coding instructions')
    const stored = await personalDefinition(api, 'style', name)
    expect(stored.content).toContain('keep-coding-instructions: true')

    // Use by default: the global default ("Your default"), also in Settings -> General.
    await chooseRowAction(page, row, testIds.customizationSetDefault)
    await expect(row.locator('[data-slot="style-default-badge"]')).toHaveText('Your default')
    await expect(page.getByTestId(testIds.customizeStyleDefault)).toHaveAttribute('data-value', name)
    await expect.poll(async () => (await api.getSettings()).outputStyle, { message: 'the global default' }).toBe(name)
    await page.goto('/settings/general')
    await expect(page.getByTestId(testIds.settingsOutputStyle)).toHaveAttribute('data-value', name)

    // A new chat on Automatic uses it: its block comes first, with the coding instructions kept.
    await openNewChat(page)
    await selectModel(page, MOCK_HOOKS_MODEL)
    const trigger = styleTrigger(page)
    await expect(trigger).toHaveAttribute('data-value', name)
    await expect(trigger).toHaveAttribute('data-source', 'automatic')
    await expect(trigger).toHaveAccessibleName(`Output style: ${name} (automatic)`)
    await sendMessage(page, 'style?')
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    await expect(lastAssistantMessage(page)).toContainText(`Style: ${name} | workspace-rules: no`)

    // A style picked on the new-chat page travels with the first message and is saved with the chat.
    await openNewChat(page)
    await selectModel(page, MOCK_HOOKS_MODEL)
    await trigger.click()
    await styleOption(page, 'explanatory').click()
    await expect(trigger).toHaveAttribute('data-value', 'explanatory')
    await expect(trigger).toHaveAttribute('data-source', 'chat')
    await sendMessage(page, 'style?')
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const pickedId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(pickedId))
    await expect(lastAssistantMessage(page)).toContainText('Style: Explanatory | workspace-rules: no')
    await expect.poll(async () => (await api.getChat(pickedId)).settings.outputStyle, { message: 'the new chat saved its style' }).toBe('explanatory')

    // Manage output styles opens the tab.
    await trigger.click()
    await page.getByTestId(testIds.outputStyleManage).click()
    await expect(page).toHaveURL(/\/settings\/customize\?tab=output-styles$/)
    await expect(byTestId(page, testIds.customizeTab, { 'data-value': 'output-styles' })).toHaveAttribute('data-state', 'active')
  })

  test('a project style is Automatic in its chats; the menu and /output-style set the chat\'s own style, which survives a reload @smoke', async ({ page, api, cleanup }) => {
    const projectStyle = uniqueId('house')
    const { chatId, project } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_HOOKS_MODEL,
      prefix: 'styles',
      files: { [`.harness/output-styles/${projectStyle}.md`]: definitionFile({ name: projectStyle, description: 'The project voice.' }, 'Speak like the project.\n') },
    })
    await api.client.projects.update({ params: { id: project.id }, body: { outputStyle: projectStyle } })

    await page.goto(`/chat/${chatId}`)
    const trigger = styleTrigger(page)
    await expect(trigger).toHaveAttribute('data-value', projectStyle)
    await expect(trigger).toHaveAttribute('data-source', 'automatic')
    await trigger.click()
    await expect(styleOption(page, '')).toHaveAttribute('data-state', 'checked')
    await expect(styleOption(page, '').locator('[data-slot="output-style-automatic"]')).toHaveText(`Uses ${projectStyle}, set for ${project.name}`)
    await expect(styleOption(page, projectStyle).locator('[data-slot="output-style-source"]')).toHaveText('Project')
    await expect(styleOption(page, 'learning').locator('[data-slot="output-style-source"]')).toHaveText('Built-in')
    await page.keyboard.press('Escape')
    await expect(styleOption(page, '')).toHaveCount(0)
    // keep-coding-instructions is off: no workspace rules, no todo hint.
    await askStyle(page, `Style: ${projectStyle} | workspace-rules: no | todo-hint: no`)

    // The menu: the chat's own choice.
    await trigger.click()
    await styleOption(page, 'learning').click()
    await expect(trigger).toHaveAttribute('data-value', 'learning')
    await expect(trigger).toHaveAttribute('data-source', 'chat')
    await expect.poll(async () => (await api.getChat(chatId)).settings.outputStyle, { message: 'the chat saved its style' }).toBe('learning')

    // `/output-style <name>`, `/output-style` alone (opens the menu) and an unknown name.
    const input = page.getByTestId(testIds.composerInput)
    await runCommand(page, '/output-style explanatory')
    await expect(trigger).toHaveAttribute('data-value', 'explanatory')
    await expect(input).toHaveValue('')
    await runCommand(page, '/output-style')
    await expect(styleOption(page, 'explanatory')).toHaveAttribute('data-state', 'checked')
    await page.keyboard.press('Escape')
    await expect(styleOption(page, '')).toHaveCount(0)
    await runCommand(page, '/output-style nope')
    await expect(toastWith(page, 'Unknown output style "nope". Use auto, default, explanatory, learning or a style from the menu.')).toBeVisible()
    await expect(trigger).toHaveAttribute('data-value', 'explanatory')
    await input.fill('')
    await askStyle(page, 'Style: Explanatory | workspace-rules: yes | todo-hint: yes')

    // A reload keeps the chat's choice; `/output-style auto` goes back to the project's style.
    await page.reload()
    await expect(trigger).toHaveAttribute('data-value', 'explanatory')
    await expect(trigger).toHaveAttribute('data-source', 'chat')
    await runCommand(page, '/output-style auto')
    await expect(trigger).toHaveAttribute('data-value', projectStyle)
    await expect(trigger).toHaveAttribute('data-source', 'automatic')
    await expect.poll(async () => (await api.getChat(chatId)).settings.outputStyle ?? null, { message: 'the chat dropped its style' }).toBeNull()
  })
})
