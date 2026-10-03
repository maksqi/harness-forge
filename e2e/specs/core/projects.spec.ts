// Projects (docs/UI.md 2.12, 2.13, 7.20, 9.10; docs/API.md 4.20; ADR-031): the Add project dialog creates a project from
// an existing folder through the folder browser (from the sidebar's project switcher) and from a new folder (from
// Settings -> Projects; the folder exists on disk afterwards); the switcher filters the chat list (All chats / No
// project / a project) and the filter survives a reload, as the permission mode of a project chat does; a chat moves
// into a project and out again from the header menu, the sidebar row menu and the header chip, with the toast and its
// Undo; deleting a project keeps its chats (they move to No project) and its folder.
//
// The folders live below the server's workspace root (`seedWorkspaceFolder`, e2e/helpers/workspace.ts), the server has
// no password, so "Add project" needs no password prompt (fresh auth only applies with a password).
import type { Locator, Page } from '@playwright/test'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  byTestId,
  chatRow,
  composer,
  expect,
  projectByPath,
  removeProject,
  removeProjectAt,
  seedProject,
  seedWorkspaceFolder,
  selectPermissionMode,
  test,
  testIds,
  uniqueId,
} from '../../helpers/index.ts'

const FILTER_STORAGE_KEY = 'hf-project-filter'

/** Opens the sidebar's project switcher menu. */
async function openSwitcher(page: Page): Promise<void> {
  await page.getByTestId(testIds.projectSwitcher).click()
  await expect(page.getByTestId(testIds.projectSwitcherOption).first()).toBeVisible()
}

/** Picks a filter in the switcher (`all`, `none` or a project id) and waits until the trigger shows it. */
async function pickFilter(page: Page, value: string): Promise<void> {
  await openSwitcher(page)
  await byTestId(page, testIds.projectSwitcherOption, { 'data-value': value }).click()
  await expect(page.getByTestId(testIds.projectSwitcher)).toHaveAttribute('data-value', value)
}

/** The visible toast with this title (vue-sonner). */
function toastWith(page: Page, text: string): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: text })
}

/** The sidebar row's `⋯` menu trigger of a chat (it sits next to the row link, in the same list item). */
function rowMenuTrigger(page: Page, chatId: string): Locator {
  return page.getByTestId(testIds.sidebar)
    .getByRole('listitem')
    .filter({ has: byTestId(page, testIds.chatRow, { 'data-chat-id': chatId }) })
    .getByTestId(testIds.chatRowMenu)
}

/** In the Add project dialog, from the list of roots: opens the workspace root. */
async function openRoot(dialog: Locator, root: string): Promise<void> {
  const browser = dialog.getByTestId(testIds.folderBrowser)
  await expect(browser).toHaveAttribute('data-path', '')
  await byTestId(browser, testIds.folderBrowserEntry, { 'data-path': root }).click()
  await expect(browser).toHaveAttribute('data-path', root)
  await expect(browser).toHaveAttribute('data-state', /^(?:ready|empty)$/)
}

/** In the Add project dialog: opens a subfolder of the open folder. */
async function openFolder(dialog: Locator, path: string): Promise<void> {
  const browser = dialog.getByTestId(testIds.folderBrowser)
  await byTestId(browser, testIds.folderBrowserEntry, { 'data-path': path }).click()
  await expect(browser).toHaveAttribute('data-path', path)
  await expect(browser).toHaveAttribute('data-state', /^(?:ready|empty)$/)
}

test.describe('projects', () => {
  test('adds a project for an existing folder from the switcher and filters by it @smoke', async ({ page, api, cleanup }) => {
    const folder = await seedWorkspaceFolder(api, { files: { 'README.md': '# Demo\n' } })
    cleanup(() => folder.remove())
    cleanup(api => removeProjectAt(api, folder.path))
    const name = `Demo ${uniqueId('add')}`

    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    await expect(page.getByTestId(testIds.projectSwitcher)).toHaveAttribute('data-value', 'all')
    await openSwitcher(page)
    await page.getByTestId(testIds.projectAdd).click()
    const dialog = page.getByTestId(testIds.addProjectDialog)
    await expect(dialog).toBeVisible()

    // The roots first; a root itself cannot be the project folder, the folder below it can.
    await openRoot(dialog, folder.root)
    const submit = dialog.getByTestId(testIds.addProjectSubmit)
    await expect(submit).toBeDisabled()
    await openFolder(dialog, folder.path)
    await expect(dialog).toContainText(`Selected: ${folder.path}`)
    const nameInput = dialog.getByTestId(testIds.addProjectName)
    await expect(nameInput).toHaveValue(folder.name)
    await nameInput.fill(name)
    await expect(submit).toBeEnabled()
    await submit.click()

    await expect(dialog).toBeHidden()
    await expect(toastWith(page, 'Project added')).toBeVisible()
    const project = await projectByPath(api, folder.path)
    expect(project, 'the server has the project').toBeDefined()
    expect(project).toMatchObject({ name, path: folder.path, available: true, chatCount: 0 })
    // The switcher now filters by the new project, which has no chats yet.
    const switcher = page.getByTestId(testIds.projectSwitcher)
    await expect(switcher).toHaveAttribute('data-value', project!.id)
    await expect(switcher).toHaveAccessibleName(`Project filter: ${name}`)
    await expect(page.getByTestId(testIds.chatList)).toContainText(`No chats in ${name} yet`)

    // The folder is now a project: the browser shows it disabled with the "Project" badge.
    await openSwitcher(page)
    await expect(byTestId(page, testIds.projectSwitcherOption, { 'data-value': project!.id })).toContainText(folder.path)
    await page.getByTestId(testIds.projectAdd).click()
    await expect(dialog).toBeVisible()
    await openRoot(dialog, folder.root)
    const entry = byTestId(dialog, testIds.folderBrowserEntry, { 'data-path': folder.path })
    await expect(entry).toBeDisabled()
    await expect(entry).toContainText('Project')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('adds a project with a new folder from Settings -> Projects; the folder exists on disk @smoke', async ({ page, api, cleanup }) => {
    const parent = await seedWorkspaceFolder(api, { prefix: 'parent' })
    cleanup(() => parent.remove())
    const folderName = uniqueId('fresh')
    const folderPath = join(parent.path, folderName)
    cleanup(api => removeProjectAt(api, folderPath))

    await page.goto('/settings/projects')
    await expect(page.getByTestId(testIds.pageHeader)).toContainText('Projects')
    await expect(page.getByTestId(testIds.settingsNavProjects)).toHaveAttribute('data-state', 'active')
    await expect(page.getByTestId(testIds.projectsSettings)).toBeVisible()
    await page.getByTestId(testIds.pageHeader).getByTestId(testIds.projectAdd).click()
    const dialog = page.getByTestId(testIds.addProjectDialog)
    await expect(dialog).toBeVisible()
    await openRoot(dialog, parent.root)
    await openFolder(dialog, parent.path)
    await expect(dialog.getByTestId(testIds.folderBrowser)).toHaveAttribute('data-state', 'empty')
    await expect(dialog.getByTestId(testIds.folderBrowser)).toContainText('No folders here.')

    // "New folder" reveals the folder name; the name follows it, the selection shows the folder to be created.
    await dialog.getByTestId(testIds.folderBrowserNew).click()
    const folderInput = dialog.getByTestId(testIds.folderBrowserNewInput)
    await folderInput.fill('.hidden')
    await expect(dialog).toContainText('start with a dot')
    await expect(dialog.getByTestId(testIds.addProjectSubmit)).toBeDisabled()
    await folderInput.fill(folderName)
    await expect(dialog).toContainText(`Selected: ${folderPath}`)
    await expect(dialog.getByTestId(testIds.addProjectName)).toHaveValue(folderName)
    await dialog.getByTestId(testIds.addProjectSubmit).click()

    await expect(dialog).toBeHidden()
    await expect(toastWith(page, 'Project added')).toBeVisible()
    const project = await projectByPath(api, folderPath)
    expect(project, 'the server has the project').toBeDefined()
    const row = byTestId(page, testIds.projectRow, { 'data-project-id': project!.id })
    await expect(row).toContainText(folderName)
    await expect(row).toContainText(folderPath)
    await expect(row).toContainText('0 chats')
    expect((await stat(folderPath)).isDirectory(), 'the new folder exists on disk').toBe(true)

    // The same new folder again: 409, "A folder with this name already exists."
    await page.getByTestId(testIds.pageHeader).getByTestId(testIds.projectAdd).click()
    await expect(dialog).toBeVisible()
    await openRoot(dialog, parent.root)
    await openFolder(dialog, parent.path)
    await dialog.getByTestId(testIds.folderBrowserNew).click()
    await dialog.getByTestId(testIds.folderBrowserNewInput).fill(folderName)
    await dialog.getByTestId(testIds.addProjectName).fill(`Again ${folderName}`)
    await dialog.getByTestId(testIds.addProjectSubmit).click()
    const error = dialog.getByTestId(testIds.addProjectError)
    await expect(error).toHaveAttribute('data-code', 'conflict')
    await expect(error).toContainText('A folder with this name already exists.')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('the switcher filters the chats; the filter and a project chat\'s mode survive a reload @smoke', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Filter ${uniqueId('filter')}` })
    const token = uniqueId('chats')
    const inProject = await api.createChat({ title: `In project ${token}`, projectId: project.id, modelRef: 'mock:tool-approval' })
    cleanup(api => api.removeChat(inProject.id))
    const outside = await api.createChat({ title: `Outside ${token}` })
    cleanup(api => api.removeChat(outside.id))

    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    const switcher = page.getByTestId(testIds.projectSwitcher)
    await expect(switcher).toHaveAttribute('data-value', 'all')
    await expect(switcher).toHaveAccessibleName('Project filter: All chats')
    await expect(chatRow(page, inProject.id)).toBeVisible()
    await expect(chatRow(page, outside.id)).toBeVisible()

    // The menu: All chats (checked), No project, the project with its path and chat count, Add project…, Manage projects.
    await openSwitcher(page)
    await expect(byTestId(page, testIds.projectSwitcherOption, { 'data-value': 'all' })).toHaveAttribute('data-state', 'checked')
    const option = byTestId(page, testIds.projectSwitcherOption, { 'data-value': project.id })
    await expect(option).toContainText(project.name)
    await expect(option).toContainText(project.path)
    await expect(option).toContainText('1')
    await expect(page.getByTestId(testIds.projectAdd)).toBeVisible()
    await expect(page.getByTestId(testIds.projectManage)).toHaveAttribute('href', '/settings/projects')
    await page.keyboard.press('Escape')

    await pickFilter(page, 'none')
    await expect(switcher).toHaveAccessibleName('Project filter: No project')
    await expect(chatRow(page, outside.id)).toBeVisible()
    await expect(chatRow(page, inProject.id)).toHaveCount(0)

    await pickFilter(page, project.id)
    await expect(switcher).toHaveAccessibleName(`Project filter: ${project.name}`)
    await expect(chatRow(page, inProject.id)).toBeVisible()
    await expect(chatRow(page, outside.id)).toHaveCount(0)
    // A new chat defaults to the filter's project.
    await expect(page.getByTestId(testIds.newChatProject)).toHaveAttribute('data-value', project.id)
    expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(FILTER_STORAGE_KEY)})`)).toBe(project.id)

    // A reload keeps the filter.
    await page.reload()
    await expect(switcher).toHaveAttribute('data-value', project.id)
    await expect(chatRow(page, inProject.id)).toBeVisible()
    await expect(chatRow(page, outside.id)).toHaveCount(0)

    // Accept edits is offered in the project chat; the chosen mode is saved with the chat and survives a reload.
    await chatRow(page, inProject.id).click()
    await expect(page).toHaveURL(new RegExp(`/chat/${inProject.id}$`))
    await expect(page.getByTestId(testIds.chatProjectChip)).toHaveAttribute('data-value', project.id)
    await selectPermissionMode(page, 'edits')
    await expect(composer(page).getByTestId(testIds.permissionMenuTrigger)).toHaveAccessibleName('Permission mode: Accept edits')
    await expect.poll(async () => (await api.getChat(inProject.id)).settings.toolMode, { message: 'the chat saved the mode' }).toBe('edits')
    await page.reload()
    await expect(composer(page).getByTestId(testIds.permissionMenuTrigger)).toHaveAttribute('data-value', 'edits')
    await expect(switcher).toHaveAttribute('data-value', project.id)

    // A chat without a project shows no chip.
    await page.goto(`/chat/${outside.id}`)
    await expect(page.getByTestId(testIds.chatTitle)).toHaveText(outside.title ?? '')
    await expect(page.getByTestId(testIds.chatProjectChip)).toHaveCount(0)
  })

  test('moves a chat into a project and out again, with the toast and Undo @smoke', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Move ${uniqueId('move')}` })
    const chat = await api.createChat({ title: `Movable ${uniqueId('chat')}` })
    cleanup(api => api.removeChat(chat.id))
    const projectOf = async () => (await api.getChat(chat.id)).projectId

    await page.goto(`/chat/${chat.id}`)
    await expect(page.getByTestId(testIds.chatTitle)).toHaveText(chat.title ?? '')
    const chip = page.getByTestId(testIds.chatProjectChip)
    await expect(chip).toHaveCount(0)

    // Header menu: "Move to project" ▸ the project.
    await page.getByTestId(testIds.chatMenuTrigger).click()
    await page.getByTestId(testIds.chatMenuMove).click()
    await expect(byTestId(page, testIds.projectOption, { 'data-value': 'none' })).toHaveAttribute('data-state', 'checked')
    await byTestId(page, testIds.projectOption, { 'data-value': project.id }).click()
    const movedIn = toastWith(page, `Moved to ${project.name}`)
    await expect(movedIn).toBeVisible()
    await expect(chip).toHaveAttribute('data-value', project.id)
    await expect(chip).toHaveAttribute('data-state', 'ok')
    await expect(chip).toContainText(project.name)
    await expect.poll(projectOf).toBe(project.id)

    // Undo moves it back.
    await movedIn.getByTestId(testIds.toastUndo).click()
    await expect(chip).toHaveCount(0)
    await expect.poll(projectOf).toBeNull()

    // Sidebar row menu: "Move to project" ▸ the project.
    await chatRow(page, chat.id).hover()
    await rowMenuTrigger(page, chat.id).click()
    await page.getByTestId(testIds.chatRowMove).click()
    await byTestId(page, testIds.projectOption, { 'data-value': project.id }).click()
    await expect(toastWith(page, `Moved to ${project.name}`)).toBeVisible()
    await expect(chip).toHaveAttribute('data-value', project.id)
    await expect.poll(projectOf).toBe(project.id)

    // With the project as the filter, moving the chat out takes it off the list: the chip's menu, "No project".
    await pickFilter(page, project.id)
    await expect(chatRow(page, chat.id)).toBeVisible()
    await chip.click()
    await expect(byTestId(page, testIds.projectOption, { 'data-value': project.id })).toHaveAttribute('data-state', 'checked')
    await byTestId(page, testIds.projectOption, { 'data-value': 'none' }).click()
    await expect(toastWith(page, `Moved out of ${project.name}`)).toBeVisible()
    await expect(chip).toHaveCount(0)
    await expect(chatRow(page, chat.id)).toHaveCount(0)
    await expect.poll(projectOf).toBeNull()
  })

  test('deleting a project keeps its chats and its folder @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, {
      name: `Delete ${uniqueId('delete')}`,
      files: { 'notes.txt': 'keep me\n' },
    })
    const chat = await api.createChat({ title: `Survivor ${uniqueId('chat')}`, projectId: project.id })
    cleanup(api => api.removeChat(chat.id))

    await page.goto('/settings/projects')
    const row = byTestId(page, testIds.projectRow, { 'data-project-id': project.id })
    await expect(row).toContainText('1 chat')
    await row.getByTestId(testIds.projectRowMenu).click()
    await page.getByTestId(testIds.projectDelete).click()
    const confirm = page.getByTestId(testIds.projectDeleteConfirm)
    await expect(confirm).toBeVisible()
    await expect(page.getByRole('alertdialog')).toContainText(`Delete ${project.name}?`)
    await expect(page.getByRole('alertdialog')).toContainText('The folder and its files are not touched.')
    await confirm.click()
    await expect(toastWith(page, 'Project deleted')).toBeVisible()
    await expect(row).toHaveCount(0)

    // The chat stays, without a project; the folder and its file stay on disk.
    expect((await api.getChat(chat.id)).projectId).toBeNull()
    expect((await stat(join(folder.path, 'notes.txt'))).isFile(), 'the folder keeps its files').toBe(true)
    expect(await projectByPath(api, folder.path)).toBeUndefined()
    await page.getByTestId(testIds.backToApp).click()
    await expect(chatRow(page, chat.id)).toBeVisible()
    // Nothing left to delete for the cleanup.
    await removeProject(api, project.id)
  })
})
