// Settings -> Customize (docs/UI.md 2.17, 9.12, 13.11; ADR-044, ADR-045): the agents, commands and skills of every
// source on one page.
// - The settings nav and the command palette ("Settings: Customize") open it on the Agents tab with the Built-in agents.
// - A new agent: an empty name and the reserved `explore` are refused inline (Save disabled), a name you already use is
//   a 409 on the name field; "Only these tools" with two tools, a model, an instructions body; the row shows the model
//   and "2 tools", and the server stored them. Turn off, Edit (focus on the description), Delete (the confirmation) and
//   Undo (a new id, still off); a reload keeps everything.
// - Import… reads a Claude Code file: the notes name the ignored keys and the model alias, the tools are mapped. Export
//   .md downloads exactly the stored file, and importing that download again prefills the same fields with no notes.
// - With a project selected: the `.harness/agents` file wins its name over `.claude/agents` (Shadowed, with the winner),
//   a file without a description is Invalid with its diagnostics; View… shows the file; Copy to personal saves a copy
//   that the project's file shadows; a reload keeps the project; without a project the copy is used.
// - Phase 11 (W11.13): five tabs in order Agents · Commands · Skills · Output styles · Hooks (`data-value` agents,
//   commands, skills, output-styles, hooks); New follows the tab (`data-kind` agent / command / skill / style / hook,
//   "New output style", "New hook") and so does `?tab=`; the Hooks tab shows the hooks panel, the Output styles tab its
//   default select and the built-in styles; an unknown `?tab=` falls back to Agents.
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import {
  byTestId,
  chooseRowAction,
  cleanupPersonalDefinition,
  createPersonalDefinition,
  customizationRow,
  customizeSection,
  definitionFile,
  expect,
  fillMarkdownEditor,
  personalDefinition,
  pressShortcut,
  seedProject,
  selectCustomizeProject,
  test,
  testIds,
  toastWith,
  uniqueId,
} from '../../helpers/index.ts'

test.describe('customize', () => {
  test('the nav and the palette open Customize; a new agent is checked, saved, turned off, edited, deleted and restored @smoke', async ({ page, api, cleanup }) => {
    test.setTimeout(60_000)
    const taken = uniqueId('taken')
    await createPersonalDefinition(api, cleanup, { kind: 'agent', name: taken, content: definitionFile({ name: taken, description: 'Already there.' }, 'PERSONA: taken\n') })
    const name = uniqueId('reviewer')
    cleanupPersonalDefinition(cleanup, 'agent', name)

    // The settings nav entry.
    await page.goto('/settings/general')
    await page.getByTestId(testIds.settingsNavCustomize).click()
    await expect(page).toHaveURL(/\/settings\/customize(?:\?|$)/)
    await expect(page.getByTestId(testIds.settingsNavCustomize)).toHaveAttribute('data-state', 'active')
    await expect(page.getByTestId(testIds.customizeSettings)).toBeVisible()
    await expect(byTestId(page, testIds.customizeTab, { 'data-value': 'agents' })).toHaveAttribute('data-state', 'active')
    await expect(customizationRow(customizeSection(page, 'builtin'), { 'data-name': 'explore' })).toBeVisible()
    await expect(customizationRow(customizeSection(page, 'builtin'), { 'data-name': 'general' })).toBeVisible()

    // The palette entry, from a chat page.
    await page.goto('/')
    await expect(page.getByTestId(testIds.composerInput)).toBeEditable()
    await pressShortcut(page, 'Mod+K')
    const palette = page.getByTestId(testIds.commandPalette)
    await palette.getByTestId(testIds.commandPaletteInput).fill('Customize')
    const entry = byTestId(palette, testIds.commandPaletteItem, { 'data-value': 'go-settings-customize' })
    await expect(entry).toContainText('Settings: Customize')
    await entry.click()
    await expect(page).toHaveURL(/\/settings\/customize(?:\?|$)/)
    await expect(customizeSection(page, 'user')).toBeVisible()

    // New agent: the name is checked like the server checks it.
    const newButton = page.getByTestId(testIds.customizeNew)
    await expect(newButton).toHaveAttribute('data-kind', 'agent')
    await newButton.click()
    const editor = page.getByTestId(testIds.customizationEditor)
    await expect(editor).toHaveAttribute('data-mode', 'new')
    await expect(editor).toHaveAttribute('data-kind', 'agent')
    const nameField = editor.getByTestId(testIds.customizationName)
    const description = editor.getByTestId(testIds.customizationDescription)
    const save = editor.getByTestId(testIds.customizationSave)
    await expect(nameField).toBeFocused()
    await nameField.press('Tab')
    await expect(editor).toContainText('Add a name.')
    await expect(nameField).toHaveAttribute('aria-invalid', 'true')
    await expect(save).toBeDisabled()
    await nameField.fill('explore')
    await expect(editor).toContainText('explore is a built-in name.')
    await expect(save).toBeDisabled()
    await description.fill('Reviews diffs for the e2e run.')
    // A name you already have: the server answers 409 and the name field says so.
    await nameField.fill(taken)
    await expect(save).toBeEnabled()
    await save.click()
    await expect(editor).toContainText(`You already have an agent named ${taken}.`)
    await expect(nameField).toBeFocused()
    await expect(save).toBeDisabled()
    await nameField.fill(name)
    await expect(editor).not.toContainText('You already have an agent named')

    // Only these tools: two tools from the list, shown as chips.
    const toolsMode = editor.getByTestId(testIds.customizationToolsMode)
    await expect(toolsMode).toHaveAttribute('data-value', 'all')
    await toolsMode.getByRole('radio', { name: 'Only these tools' }).click()
    await expect(toolsMode).toHaveAttribute('data-value', 'some')
    const tools = editor.getByTestId(testIds.customizationTools)
    await expect(tools).toHaveAttribute('data-count', '0')
    await tools.click()
    for (const tool of ['read_file', 'list_directory'])
      await byTestId(page, testIds.customizationToolOption, { 'data-tool-name': tool }).click()
    await expect(byTestId(page, testIds.customizationToolOption, { 'data-tool-name': 'task' }), 'a sub-agent never gets task').toHaveCount(0)
    await tools.click()
    await expect(page.getByTestId(testIds.customizationToolOption)).toHaveCount(0)
    await expect(tools).toHaveAttribute('data-count', '2')
    for (const tool of ['read_file', 'list_directory'])
      await expect(byTestId(editor, testIds.customizationToolChip, { 'data-tool-name': tool })).toHaveAttribute('data-state', 'known')

    // A model, and the instructions.
    const model = editor.getByTestId(testIds.customizationModel)
    await expect(model).toHaveAttribute('data-value', '')
    await model.click()
    await byTestId(page, testIds.modelSelectOption, { 'data-model-ref': 'mock:agents' }).click()
    await expect(model).toHaveAttribute('data-value', 'mock:agents')
    await fillMarkdownEditor(page, editor.getByTestId(testIds.customizationBody), 'PERSONA: e2e reviewer\nReview the diff.\n')
    await save.click()
    await expect(toastWith(page, 'Agent saved')).toBeVisible()
    await expect(editor).toBeHidden()

    const row = customizationRow(customizeSection(page, 'user'), { 'data-name': name })
    await expect(row).toHaveAttribute('data-state', 'active')
    await expect(row).toHaveAttribute('data-kind', 'agent')
    await expect(row).toContainText('Reviews diffs for the e2e run.')
    await expect(row).toContainText('Mock Agents')
    await expect(row).toContainText('2 tools')
    const created = await personalDefinition(api, 'agent', name)
    expect(created).toMatchObject({ kind: 'agent', enabled: true, fields: { model: 'mock:agents', description: 'Reviews diffs for the e2e run.' } })
    expect([...(created.kind === 'agent' ? created.fields?.tools ?? [] : [])].sort()).toEqual(['list_directory', 'read_file'])
    expect(created.content).toContain('PERSONA: e2e reviewer')
    await expect(row).toHaveAttribute('data-customization-id', created.id)

    // Turn off: listed, not used.
    await chooseRowAction(page, row, testIds.customizationToggle)
    await expect(row).toHaveAttribute('data-state', 'off')
    await expect(row).toContainText('Off')
    await expect.poll(async () => (await personalDefinition(api, 'agent', name)).enabled).toBe(false)

    // Edit: the editor opens on the description; saving keeps it off and returns focus to the row's menu.
    await chooseRowAction(page, row, testIds.customizationEdit)
    await expect(editor).toHaveAttribute('data-mode', 'edit')
    await expect(description).toBeFocused()
    await expect(nameField).toHaveValue(name)
    await description.fill('Edited for the e2e run.')
    await save.click()
    await expect(editor).toBeHidden()
    await expect(row).toContainText('Edited for the e2e run.')
    await expect(row.getByTestId(testIds.customizationRowMenu)).toBeFocused()
    await expect.poll(async () => (await personalDefinition(api, 'agent', name)).description).toBe('Edited for the e2e run.')

    // Delete asks first; Undo re-creates it (a new id) as it was.
    await chooseRowAction(page, row, testIds.customizationDelete)
    const confirm = page.getByTestId(testIds.customizationDeleteConfirm)
    await expect(page.getByRole('alertdialog')).toContainText(`Delete ${name}?`)
    await expect(page.getByRole('alertdialog')).toContainText('The agent can\'t start it anymore.')
    await expect(confirm).toHaveText('Delete agent')
    await confirm.click()
    await expect(row).toHaveCount(0)
    const deleted = toastWith(page, `Deleted ${name}`)
    await expect(deleted).toBeVisible()
    await deleted.getByTestId(testIds.toastUndo).click()
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-state', 'off')
    const restored = await personalDefinition(api, 'agent', name)
    expect(restored.id).not.toBe(created.id)
    expect(restored).toMatchObject({ enabled: false, description: 'Edited for the e2e run.' })

    // A reload keeps it.
    await page.reload()
    await expect(row).toHaveAttribute('data-state', 'off')
    await expect(row).toContainText('Edited for the e2e run.')
    await expect(row).toContainText('2 tools')
  })

  test('Import… reads a Claude Code file with notes; Export .md downloads the stored file, which imports again @smoke', async ({ page, api, cleanup }) => {
    const name = uniqueId('imported')
    cleanupPersonalDefinition(cleanup, 'agent', name)
    const file = definitionFile(
      { name, description: 'Imported from a Claude Code file.', tools: 'Read, Grep', model: 'sonnet', color: 'blue', permissionMode: 'plan' },
      'PERSONA: imported\nRead the files before you answer.\n',
    )

    await page.goto('/settings/customize?tab=agents')
    await expect(customizeSection(page, 'user')).toBeVisible()
    const choosing = page.waitForEvent('filechooser')
    await page.getByTestId(testIds.customizeImport).click()
    await (await choosing).setFiles({ name: `${name}.md`, mimeType: 'text/markdown', buffer: Buffer.from(file) })

    // The editor in import mode with the notes: the ignored keys, the model alias.
    const editor = page.getByTestId(testIds.customizationEditor)
    await expect(editor).toHaveAttribute('data-mode', 'import')
    const notes = editor.getByTestId(testIds.customizationImportNotes)
    await expect(notes).toContainText(`Imported from ${name}.md. Check the fields, then save.`)
    // Phase 12 (ADR-058): `color` is read now; a Claude model alias resolves through the `modelAliases` setting.
    await expect(notes).toContainText('Ignored: permissionMode')
    await expect(notes).toContainText('Claude model names use the model aliases of the settings')
    await expect(notes).toHaveAttribute('data-count', '3')
    await expect(editor.getByTestId(testIds.customizationName)).toHaveValue(name)
    await expect(editor.getByTestId(testIds.customizationDescription)).toHaveValue('Imported from a Claude Code file.')
    await expect(editor.getByTestId(testIds.customizationToolsMode)).toHaveAttribute('data-value', 'some')
    for (const tool of ['read_file', 'search_files'])
      await expect(byTestId(editor, testIds.customizationToolChip, { 'data-tool-name': tool })).toHaveAttribute('data-state', 'known')
    await expect(editor.getByTestId(testIds.customizationModel)).toHaveAttribute('data-value', '')
    await expect(editor.getByTestId(testIds.customizationBody)).toContainText('PERSONA: imported')
    await editor.getByTestId(testIds.customizationSave).click()
    await expect(toastWith(page, 'Agent saved')).toBeVisible()
    await expect(editor).toBeHidden()

    // Export .md: the download is the stored file.
    const row = customizationRow(customizeSection(page, 'user'), { 'data-name': name })
    await expect(row).toContainText('2 tools')
    const downloading = page.waitForEvent('download')
    await chooseRowAction(page, row, testIds.customizationExport)
    const download = await downloading
    expect(download.suggestedFilename()).toBe(`${name}.md`)
    const exported = await readFile(await download.path(), 'utf8')
    const stored = await personalDefinition(api, 'agent', name)
    expect(exported).toBe(stored.content)
    expect(exported).not.toContain('permissionMode')
    expect(exported).toContain('PERSONA: imported')

    // The exported file imports again with the same fields and no notes beyond the first line.
    const again = page.waitForEvent('filechooser')
    await page.getByTestId(testIds.customizeImport).click()
    await (await again).setFiles({ name: `${name}.md`, mimeType: 'text/markdown', buffer: Buffer.from(exported) })
    await expect(editor).toHaveAttribute('data-mode', 'import')
    // Phase 12 (ADR-058): the editor keeps the Claude model name (`model: sonnet`), so its alias note comes back.
    await expect(editor.getByTestId(testIds.customizationImportNotes)).toHaveAttribute('data-count', '2')
    await expect(editor.getByTestId(testIds.customizationImportNotes)).toContainText('Claude model names use the model aliases of the settings')
    await expect(editor.getByTestId(testIds.customizationName)).toHaveValue(name)
    await expect(editor.getByTestId(testIds.customizationDescription)).toHaveValue(stored.description)
    for (const tool of ['read_file', 'search_files'])
      await expect(byTestId(editor, testIds.customizationToolChip, { 'data-tool-name': tool })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor).toBeHidden()
  })

  test('a project\'s agents: .harness wins over .claude, an invalid file shows its problems; View… and Copy to personal @smoke', async ({ page, api, cleanup }) => {
    const agent = uniqueId('proj-agent')
    const broken = uniqueId('broken')
    const { project } = await seedProject(api, cleanup, {
      prefix: 'customize',
      files: {
        [`.harness/agents/${agent}.md`]: definitionFile({ name: agent, description: 'The harness reviewer.', tools: ['read_file'] }, 'PERSONA: harness reviewer\n'),
        [`.claude/agents/${agent}.md`]: definitionFile({ name: agent, description: 'The Claude reviewer.' }, 'PERSONA: claude reviewer\n'),
        [`.claude/agents/${broken}.md`]: definitionFile({ name: broken }, 'No description here.\n'),
      },
    })
    cleanupPersonalDefinition(cleanup, 'agent', agent)

    await page.goto('/settings/customize')
    await expect(customizeSection(page, 'user')).toBeVisible()
    await expect(customizeSection(page, 'project')).toHaveCount(0)
    await selectCustomizeProject(page, project.id)
    const section = customizeSection(page, 'project')
    await expect(section).toHaveAttribute('data-count', '3')
    await expect(section).toContainText(`In ${project.name} · 3`)
    // The scanned folders of the kind (the server lists `.claude` before `.harness`).
    await expect(section).toContainText(/\.claude\/agents · \.harness\/agents|\.harness\/agents · \.claude\/agents/)

    const winner = customizationRow(section, { 'data-name': agent, 'data-path': `.harness/agents/${agent}.md` })
    await expect(winner).toHaveAttribute('data-state', 'active')
    await expect(winner).toContainText('1 tool')
    const loser = customizationRow(section, { 'data-name': agent, 'data-path': `.claude/agents/${agent}.md` })
    await expect(loser).toHaveAttribute('data-state', 'shadowed')
    await expect(loser).toContainText('Shadowed')
    await expect(loser).toContainText(`Not used: the project's .harness/agents/${agent}.md wins.`)
    const invalid = customizationRow(section, { 'data-name': broken })
    await expect(invalid).toHaveAttribute('data-state', 'invalid')
    await expect(invalid).toContainText('Invalid')
    await expect(invalid.getByTestId(testIds.customizationDiagnostics)).toContainText('Add a description.')

    // View…: the read-only file.
    await chooseRowAction(page, winner, testIds.customizationView)
    const viewer = page.getByTestId(testIds.customizationViewer)
    await expect(viewer).toHaveAttribute('data-source', 'project')
    await expect(viewer).toHaveAttribute('data-kind', 'agent')
    await expect(viewer).toContainText('The harness reviewer.')
    await expect(viewer).toContainText(`.harness/agents/${agent}.md`)
    await expect(viewer.locator('[data-slot="markdown-editor"]')).toContainText('PERSONA: harness reviewer')
    await page.keyboard.press('Escape')
    await expect(viewer).toBeHidden()

    // Copy to personal: the editor in import mode, prefilled from the file.
    await chooseRowAction(page, winner, testIds.customizationDuplicate)
    const editor = page.getByTestId(testIds.customizationEditor)
    await expect(editor).toHaveAttribute('data-mode', 'import')
    await expect(editor.getByTestId(testIds.customizationName)).toHaveValue(agent)
    await expect(editor.getByTestId(testIds.customizationDescription)).toHaveValue('The harness reviewer.')
    await expect(byTestId(editor, testIds.customizationToolChip, { 'data-tool-name': 'read_file' })).toBeVisible()
    await editor.getByTestId(testIds.customizationSave).click()
    await expect(toastWith(page, 'Agent saved')).toBeVisible()
    await expect(editor).toBeHidden()

    // The copy is listed, but the project's file wins the name in this project.
    const personal = customizationRow(customizeSection(page, 'user'), { 'data-name': agent })
    await expect(personal).toHaveAttribute('data-state', 'shadowed')
    await expect(personal).toContainText(`Not used: the project's .harness/agents/${agent}.md wins.`)
    expect((await personalDefinition(api, 'agent', agent)).content).toContain('PERSONA: harness reviewer')

    // A reload keeps the project and the rows.
    await page.reload()
    await expect(page.getByTestId(testIds.customizeProjectSelect)).toHaveAttribute('data-value', project.id)
    await expect(winner).toHaveAttribute('data-state', 'active')
    await expect(loser).toHaveAttribute('data-state', 'shadowed')
    await expect(invalid).toHaveAttribute('data-state', 'invalid')
    await expect(personal).toHaveAttribute('data-state', 'shadowed')

    // Without the project, the personal copy is the one used.
    await selectCustomizeProject(page, null)
    await expect(customizeSection(page, 'project')).toHaveCount(0)
    await expect(personal).toHaveAttribute('data-state', 'active')
  })

  test('five tabs: Agents, Commands, Skills, Output styles and Hooks; New and the query follow the tab @smoke', async ({ page }) => {
    await page.goto('/settings/customize')
    const tabs = page.getByTestId(testIds.customizeTab)
    await expect(tabs).toHaveCount(5)
    const values = ['agents', 'commands', 'skills', 'output-styles', 'hooks']
    expect(await tabs.evaluateAll(items => items.map(item => item.getAttribute('data-value')))).toEqual(values)
    const labels = await tabs.evaluateAll(items => items.map(item => (item.textContent ?? '').replace(/[\d,\s]+$/, '').trim()))
    expect(labels).toEqual(['Agents', 'Commands', 'Skills', 'Output styles', 'Hooks'])
    await expect(page.getByTestId(testIds.customizeSettings)).toBeVisible()
    await expect(page.getByText('Agents, commands, skills, output styles and hooks: yours, your projects\' and your plugins\'.')).toBeVisible()

    const newButton = page.getByTestId(testIds.customizeNew)
    const expected: [string, string, string][] = [
      ['commands', 'command', 'New command'],
      ['skills', 'skill', 'New skill'],
      ['output-styles', 'style', 'New output style'],
      ['hooks', 'hook', 'New hook'],
      ['agents', 'agent', 'New agent'],
    ]
    for (const [value, kind, label] of expected) {
      const tab = byTestId(page, testIds.customizeTab, { 'data-value': value })
      await tab.click()
      await expect(tab).toHaveAttribute('data-state', 'active')
      await expect(page).toHaveURL(new RegExp(`[?&]tab=${value}(?:&|$)`))
      await expect(newButton).toHaveAttribute('data-kind', kind)
      await expect(newButton).toHaveText(label)
      if (value === 'hooks')
        await expect(page.getByTestId(testIds.hooksPanel)).toBeVisible()
      if (value === 'output-styles')
        await expect(page.getByTestId(testIds.customizeStyleDefault)).toBeVisible()
    }

    // The query opens a tab directly; an unknown value falls back to Agents.
    await page.goto('/settings/customize?tab=output-styles')
    await expect(byTestId(page, testIds.customizeTab, { 'data-value': 'output-styles' })).toHaveAttribute('data-state', 'active')
    await expect(customizationRow(customizeSection(page, 'builtin'), { 'data-name': 'explanatory' })).toBeVisible()
    await page.goto('/settings/customize?tab=nope')
    await expect(byTestId(page, testIds.customizeTab, { 'data-value': 'agents' })).toHaveAttribute('data-state', 'active')
  })

  // The five tabs fit on a desktop and the active tab stays in view (fixed in P11-B, W11.19).
  test('a page opened on the Hooks tab shows the whole active tab', async ({ page }) => {
    await page.goto('/settings/customize?tab=hooks')
    const tab = byTestId(page, testIds.customizeTab, { 'data-value': 'hooks' })
    await expect(tab).toHaveAttribute('data-state', 'active')
    const row = page.getByRole('tablist', { name: 'Kinds' }).locator('xpath=..')
    await expect.poll(async () => {
      const [tabBox, rowBox] = [await tab.boundingBox(), await row.boundingBox()]
      return tabBox !== null && rowBox !== null && tabBox.x >= rowBox.x - 0.5 && tabBox.x + tabBox.width <= rowBox.x + rowBox.width + 0.5
    }, { message: 'the active tab lies inside the visible part of its row' }).toBe(true)
  })
})
