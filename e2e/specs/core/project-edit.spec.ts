// Editing project definition files (Phase 12, ADR-056; docs/UI.md 2.19, 9.13, 9.14; docs/API.md 4.34) on the shared
// server, in the spec's own project folders:
// - A project command row: Edit… opens the project file editor ("Edit check.md", the raw file, "Saving never approves
//   hooks or shell lines."); a `` !`echo hi` `` line saved from it writes the file byte for byte and reads "Saved
//   .harness/commands/check.md. 1 item needs your approval." with Review, which opens the project trust dialog on the
//   new command item: saving approved nothing.
// - A project agent changed on disk after the editor read it: Save shows the conflict banner ("reviewer.md changed on
//   disk after you opened it.", focused); Load from disk shows the file as it is now; after another change on disk,
//   Overwrite saves the editor's text over it.
// - An approved project hook (UserPromptSubmit `context`, `mock:hooks` `context?` reads its context) edited in the hook
//   editor (project mode, "Edit project hook", `.harness/settings.json`): the save turns it pending ("… 1 item needs your
//   approval."), and the next turn runs without it (`Context: none`) until it is approved again.
import {
  approveProjectItems,
  byTestId,
  definitionFile,
  expect,
  HOOK_SCRIPT_TEXT,
  hookGroup,
  hookRow,
  listHooks,
  MOCK_HOOKS_MODEL,
  pendingTrustItems,
  seedHookProjectChat,
  seedProject,
  test,
  testIds,
  toastWith,
  trustItem,
  writeProjectFile,
} from '../../helpers/index.ts'
import {
  openProjectFileEditor,
  projectFileContent,
  projectRow,
  readProjectFile,
  replaceProjectFileText,
} from '../../helpers/project-files.ts'

const COMMAND_PATH = '.harness/commands/check.md'
const AGENT_PATH = '.claude/agents/reviewer.md'

function agentFile(description: string): string {
  return definitionFile({ name: 'reviewer', description }, 'Review the code you are given.')
}

test.describe('project file editing', () => {
  test('Edit… on a project command saves the raw file; a shell line needs approval and Review opens the trust dialog @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, {
      prefix: 'edit-command',
      files: { [COMMAND_PATH]: definitionFile({ description: 'Check the build' }, 'Check the build of this project.') },
    })
    await page.goto(`/settings/customize?tab=commands&project=${project.id}`)
    const row = projectRow(page, 'command', 'check')
    await expect(row).toBeVisible()

    const editor = await openProjectFileEditor(page, row, COMMAND_PATH, 'Check the build of this project.')
    await expect(editor.getByRole('heading', { name: 'Edit check.md' })).toBeVisible()
    await expect(editor).toContainText(COMMAND_PATH)
    await expect(editor).toContainText('Saving never approves hooks or shell lines.')
    const text = definitionFile({ 'description': 'Check the build', 'x-team-note': 'kept as written' }, 'Status: !`echo hi`\n\nCheck the build of this project.')
    await replaceProjectFileText(page, editor, text)
    await editor.getByTestId(testIds.projectFileSave).click()

    const saved = toastWith(page, `Saved ${COMMAND_PATH}. 1 item needs your approval.`)
    await expect(saved).toBeVisible()
    await expect(editor).toBeHidden()
    expect(await readProjectFile(folder.path, COMMAND_PATH), 'the raw text, unknown keys kept').toBe(text)
    // Saving never approves: the command's shell line waits for approval.
    expect((await pendingTrustItems(api, project.id)).map(item => item.kind)).toEqual(['command'])

    await saved.getByRole('button', { name: 'Review' }).click()
    const trust = page.getByTestId(testIds.projectTrustDialog)
    await expect(trust).toBeVisible()
    await expect(trustItem(trust, { 'data-kind': 'command', 'data-state': 'new' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(trust).toBeHidden()
    await expect(row).toContainText('Needs approval')
  })

  test('a file changed on disk: the conflict banner, Load from disk and Overwrite @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, { prefix: 'edit-stale', files: { [AGENT_PATH]: agentFile('Reviews code.') } })
    await page.goto(`/settings/customize?tab=agents&project=${project.id}`)
    const row = projectRow(page, 'agent', 'reviewer')
    await expect(row).toBeVisible()

    // A change on disk after the editor read the file: Save meets the conflict; Load from disk shows the file as it is.
    const editor = await openProjectFileEditor(page, row, AGENT_PATH, 'Reviews code.')
    await replaceProjectFileText(page, editor, agentFile('Reviews code carefully.'))
    await writeProjectFile(folder.path, AGENT_PATH, agentFile('Reviews code on disk.'))
    await editor.getByTestId(testIds.projectFileSave).click()
    const conflict = editor.getByTestId(testIds.projectFileConflict)
    await expect(conflict).toBeVisible()
    await expect(conflict).toContainText('reviewer.md changed on disk after you opened it.')
    await expect(conflict).toBeFocused()
    await conflict.getByTestId(testIds.projectFileReload).click()
    await expect(conflict).toBeHidden()
    await expect(projectFileContent(editor)).toContainText('Reviews code on disk.')
    expect(await readProjectFile(folder.path, AGENT_PATH)).toBe(agentFile('Reviews code on disk.'))

    // Another change on disk: Overwrite saves the editor's text over it.
    const mine = agentFile('Reviews code, the editor\'s version.')
    await replaceProjectFileText(page, editor, mine)
    await writeProjectFile(folder.path, AGENT_PATH, agentFile('Reviews code, changed again on disk.'))
    await editor.getByTestId(testIds.projectFileSave).click()
    await expect(conflict).toBeVisible()
    await conflict.getByTestId(testIds.projectFileOverwrite).click()
    await expect(toastWith(page, `Saved ${AGENT_PATH}.`)).toBeVisible()
    await expect(editor).toBeHidden()
    expect(await readProjectFile(folder.path, AGENT_PATH)).toBe(mine)
    await expect(row).toContainText('Reviews code, the editor\'s version.')
  })

  test('a project hook edited in the hook editor turns pending and does not run until it is approved @smoke', async ({ page, api, cleanup }) => {
    const seeded = await seedHookProjectChat(api, cleanup, {
      prefix: 'edit-hook',
      scripts: ['context'],
      hooks: commands => ({ UserPromptSubmit: [hookGroup(commands.context!)] }),
    })
    const context = `Context: UserPromptSubmit:${HOOK_SCRIPT_TEXT.context}`
    // Each question in a new chat of the project (a chat's history keeps the context of its earlier turns).
    const ask = async (): Promise<string> => {
      const chat = await api.createChat({ title: `Edit hook ${seeded.folder.name}`, projectId: seeded.project.id, modelRef: MOCK_HOOKS_MODEL })
      cleanup(api => api.removeChat(chat.id))
      return (await api.sendChat({ chatId: chat.id, modelRef: MOCK_HOOKS_MODEL, toolMode: 'ask', text: 'context?' })).text
    }
    expect(await ask()).toBe(context)

    await page.goto(`/settings/customize?tab=hooks&project=${seeded.project.id}`)
    const section = byTestId(page, testIds.hooksSection, { 'data-source': 'project' })
    const active = hookRow(section, { 'data-event': 'UserPromptSubmit', 'data-state': 'active' })
    await expect(active).toBeVisible()
    await active.getByTestId(testIds.hookRowMenu).click()
    await page.getByRole('menu').getByTestId(testIds.hookEdit).click()
    const editor = page.getByTestId(testIds.hookEditor)
    await expect(editor).toHaveAttribute('data-mode', 'project')
    await expect(editor.getByRole('heading', { name: 'Edit project hook' })).toBeVisible()
    await expect(editor.locator('[data-field="hook-path"]')).toHaveText('.harness/settings.json')
    const command = editor.getByTestId(testIds.hookCommand)
    await expect(command).toHaveValue(seeded.commands.context!)
    await command.fill(`${seeded.commands.context!} --edited`)
    await editor.getByTestId(testIds.hookSave).click()
    await expect(toastWith(page, 'Saved .harness/settings.json. 1 item needs your approval.')).toBeVisible()
    await expect(editor).toBeHidden()

    // The file holds the edit; the hook is pending and does not run.
    expect(await readProjectFile(seeded.folder.path, '.harness/settings.json')).toContain(`${seeded.commands.context!} --edited`)
    const listed = (await listHooks(api, seeded.project.id)).items.filter(entry => entry.source === 'project')
    expect(listed.map(entry => entry.state)).toEqual(['pending'])
    expect((await pendingTrustItems(api, seeded.project.id)).map(item => item.kind)).toEqual(['hook'])
    expect(await ask(), 'the edited hook waits for approval').toBe('Context: none')
    // The tab shows the edited row as pending (also after a reload; the test below checks the refresh without one).
    await page.reload()
    const pending = hookRow(section, { 'data-event': 'UserPromptSubmit', 'data-state': 'pending' })
    await expect(pending).toBeVisible()
    await expect(pending.locator('[data-slot="hook-row-command"]')).toContainText('--edited')
    await expect(section.getByTestId(testIds.customizeTrustReview)).toHaveText('Review 1…')

    // Approved again (through the API: the shared server has no password), it runs.
    await approveProjectItems(api, seeded.project.id)
    expect(await ask()).toBe(context)
  })

  test('the Hooks tab shows a project hook saved from the editor without a reload @smoke', async ({ page, api, cleanup }) => {
    const seeded = await seedHookProjectChat(api, cleanup, {
      prefix: 'edit-hook-refresh',
      scripts: ['context'],
      hooks: commands => ({ UserPromptSubmit: [hookGroup(commands.context!)] }),
    })
    await page.goto(`/settings/customize?tab=hooks&project=${seeded.project.id}`)
    const section = byTestId(page, testIds.hooksSection, { 'data-source': 'project' })
    const active = hookRow(section, { 'data-event': 'UserPromptSubmit', 'data-state': 'active' })
    await active.getByTestId(testIds.hookRowMenu).click()
    await page.getByRole('menu').getByTestId(testIds.hookEdit).click()
    const editor = page.getByTestId(testIds.hookEditor)
    await editor.getByTestId(testIds.hookCommand).fill(`${seeded.commands.context!} --edited`)
    await editor.getByTestId(testIds.hookSave).click()
    await expect(editor).toBeHidden()
    const pending = hookRow(section, { 'data-event': 'UserPromptSubmit', 'data-state': 'pending' })
    await expect(pending).toBeVisible()
    await expect(pending.locator('[data-slot="hook-row-command"]')).toContainText('--edited')
  })
})
