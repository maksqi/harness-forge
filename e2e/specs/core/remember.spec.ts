// Remember (docs/UI.md 2.17, 7.30; docs/API.md 4.30, 5.29; ADR-047): `/remember [text]` opens RememberDialog with the
// text; Save appends `- {text}` to the chosen target.
// - In a project chat (a saved chat of a project): the project file is the default ("AGENTS.md in {project} (new
//   file)"); Save creates `AGENTS.md` on disk ("Created AGENTS.md in {project}"), journaled under the chat, so the
//   changes panel lists it. The project's instructions ("Saved to the instructions of {project}") show in its
//   Instructions dialog in Settings -> Projects; the custom instructions ("Saved to your custom instructions") in
//   Settings -> General. The last target is remembered (`hf-remember-target`).
// - Outside a project the two project targets are disabled with the reason, and the custom instructions are chosen.
// - The limits: more than 2,000 characters is refused inline (Save disabled); a note that would make the project's
//   instructions longer than 20,000 characters shows the server's refusal inline and keeps the dialog open.
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  byTestId,
  changesFile,
  changesPanel,
  changesToggle,
  expect,
  openNewChat,
  seedProjectChat,
  storageItem,
  test,
  testIds,
  toastWith,
  uniqueId,
} from '../../helpers/index.ts'

/** Types `/remember {text}` into the composer and sends it with Enter: the dialog opens with the text. */
async function openRemember(page: Page, text: string): Promise<ReturnType<Page['getByTestId']>> {
  const input = page.getByTestId(testIds.composerInput)
  await input.fill(text ? `/remember ${text}` : '/remember')
  await input.press('Enter')
  const dialog = page.getByTestId(testIds.rememberDialog)
  await expect(dialog).toBeVisible()
  await expect(input).toHaveValue('')
  return dialog
}

function target(page: Page, value: 'project-file' | 'project-instructions' | 'global') {
  return byTestId(page.getByTestId(testIds.rememberDialog), testIds.rememberTarget, { 'data-value': value })
}

async function fileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return null
  }
}

test.describe('remember', () => {
  test('a project chat saves to AGENTS.md (in the changes panel), the project\'s instructions and the custom instructions @smoke', async ({ page, api, cleanup }) => {
    const settings = await api.getSettings()
    cleanup(api => api.updateSettings({ instructions: settings.instructions }))
    const { project, folder, chatId } = await seedProjectChat(api, cleanup, { modelRef: 'mock:echo', prefix: 'remember' })
    await api.sendChat({ chatId, modelRef: 'mock:echo', text: 'Hello.' })
    const fileNote = `Run pnpm check before every commit ${uniqueId('file')}.`
    const projectNote = `Prefer small commits ${uniqueId('project')}.`
    const globalNote = `Answer in plain English ${uniqueId('global')}.`

    await page.goto(`/chat/${chatId}`)
    await expect(page.getByTestId(testIds.composerInput)).toBeEditable()

    // The project file: the default target of a project chat; a prefilled dialog opens on the selected target.
    let dialog = await openRemember(page, fileNote)
    await expect(dialog.getByTestId(testIds.rememberText)).toHaveValue(fileNote)
    await expect(target(page, 'project-file')).toHaveAttribute('data-state', 'checked')
    await expect(target(page, 'project-file')).toBeFocused()
    await expect(target(page, 'project-file')).toContainText(`AGENTS.md in ${project.name} (new file)`)
    await expect(target(page, 'project-instructions')).toContainText(`Instructions of ${project.name}`)
    await expect(target(page, 'global')).toContainText('Custom instructions')
    await expect(dialog.locator('[data-slot="remember-counter"]')).toHaveText(`${fileNote.length} / 2,000`)
    await dialog.getByTestId(testIds.rememberSave).click()
    await expect(toastWith(page, `Created AGENTS.md in ${project.name}`)).toBeVisible()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId(testIds.composerInput)).toBeFocused()
    expect(await fileText(join(folder.path, 'AGENTS.md'))).toBe(`- ${fileNote}\n`)
    // Journaled under the chat: the changes panel lists the new file.
    await expect(changesToggle(page)).toHaveAttribute('data-count', '1')
    await changesToggle(page).click()
    await expect(changesFile(page, 'AGENTS.md')).toBeVisible()
    await changesPanel(page).getByTestId(testIds.changesClose).click()

    // The project's instructions.
    dialog = await openRemember(page, projectNote)
    await target(page, 'project-instructions').click()
    await expect(target(page, 'project-instructions')).toHaveAttribute('data-state', 'checked')
    await dialog.getByTestId(testIds.rememberSave).click()
    await expect(toastWith(page, `Saved to the instructions of ${project.name}`)).toBeVisible()
    await expect(dialog).toBeHidden()

    // The custom instructions.
    dialog = await openRemember(page, globalNote)
    await expect(target(page, 'project-instructions'), 'the last target is the default').toHaveAttribute('data-state', 'checked')
    await target(page, 'global').click()
    await dialog.getByTestId(testIds.rememberSave).click()
    await expect(toastWith(page, 'Saved to your custom instructions')).toBeVisible()
    await expect(dialog).toBeHidden()
    expect(await storageItem(page, 'hf-remember-target')).toBe('global')
    expect(await fileText(join(folder.path, 'AGENTS.md')), 'only the first note went into the file').toBe(`- ${fileNote}\n`)

    // Settings -> Projects: the project's Instructions dialog holds the note.
    await page.goto('/settings/projects')
    const row = byTestId(page, testIds.projectRow, { 'data-project-id': project.id })
    await row.getByTestId(testIds.projectRowMenu).click()
    await page.getByTestId(testIds.projectInstructions).click()
    const instructions = page.getByTestId(testIds.projectInstructionsDialog)
    await expect(instructions).toBeVisible()
    await expect(instructions.getByTestId(testIds.projectInstructionsInput)).toHaveValue(`- ${projectNote}`)
    await page.keyboard.press('Escape')
    await expect(instructions).toBeHidden()

    // Settings -> General: the custom instructions end with the note.
    await page.goto('/settings/general')
    await expect(page.getByTestId(testIds.settingsInstructions)).toHaveValue(new RegExp(`- ${globalNote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    expect((await api.getSettings()).instructions.endsWith(`- ${globalNote}`)).toBe(true)
  })

  test('outside a project the project targets are disabled; more than 2,000 characters and the instructions cap are refused @smoke', async ({ page, api, cleanup }) => {
    // A chat without a project (the new-chat page): only the custom instructions.
    await openNewChat(page)
    let dialog = await openRemember(page, '')
    await expect(dialog.getByTestId(testIds.rememberText)).toBeFocused()
    await expect(dialog).toContainText('Open a chat in a project to use this.')
    for (const value of ['project-file', 'project-instructions'] as const) {
      await expect(target(page, value)).toHaveAttribute('data-disabled', '')
      await expect(target(page, value)).toHaveAttribute('aria-disabled', 'true')
      await expect(target(page, value)).toHaveAccessibleDescription(/Open a chat in a project to use this\./)
    }
    await expect(target(page, 'project-file')).toContainText('AGENTS.md in a project (new file)')
    await expect(target(page, 'global')).toHaveAttribute('data-state', 'checked')
    const save = dialog.getByTestId(testIds.rememberSave)
    await expect(save).toBeDisabled()

    // Over 2,000 characters: refused inline.
    await dialog.getByTestId(testIds.rememberText).fill('x'.repeat(2001))
    await expect(dialog).toContainText('Use at most 2,000 characters.')
    await expect(dialog.locator('[data-slot="remember-counter"]')).toHaveText('2,001 / 2,000')
    await expect(dialog.getByTestId(testIds.rememberText)).toHaveAttribute('aria-invalid', 'true')
    await expect(save).toBeDisabled()
    await dialog.getByTestId(testIds.rememberText).fill('x'.repeat(2000))
    await expect(save).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // A project whose instructions are nearly full: the server refuses, the dialog stays open with its text.
    const { project, chatId } = await seedProjectChat(api, cleanup, { modelRef: 'mock:echo', prefix: 'remember' })
    await api.sendChat({ chatId, modelRef: 'mock:echo', text: 'Hello.' })
    await api.client.projects.update({ params: { id: project.id }, body: { instructions: 'i'.repeat(19_990) } })
    await page.goto(`/chat/${chatId}`)
    await expect(page.getByTestId(testIds.composerInput)).toBeEditable()
    dialog = await openRemember(page, 'A note that does not fit into the instructions any more.')
    await target(page, 'project-instructions').click()
    await dialog.getByTestId(testIds.rememberSave).click()
    const error = dialog.getByTestId(testIds.rememberError)
    await expect(error).toHaveText('The instructions would be longer than 20,000 characters. Shorten them in Settings first.')
    await expect(error).toHaveAttribute('data-code', 'validation_error')
    await expect(error).toHaveAttribute('role', 'alert')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId(testIds.rememberText)).toHaveValue('A note that does not fit into the instructions any more.')
    expect((await api.client.projects.list()).items.find(item => item.id === project.id)?.instructions).toBe('i'.repeat(19_990))
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})
