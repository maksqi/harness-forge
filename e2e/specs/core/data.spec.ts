// Settings -> Data (docs/UI.md 2.7, 9.8; docs/API.md 4.16, 5.19; ADR-024) on a password-protected server of its own
// (`startPasswordServer({ dedicated: true })`: delete-all wipes every chat, so never the shared e2e server). Export
// backup downloads a zip with the manifest and every chat, but no share link; Delete all data needs the typed DELETE
// (case-sensitive) and, because the login is more than 10 minutes old by then (the browser clock is moved forward),
// the password, and deletes the share links too; importing the zip brings every chat back, into the sidebar with its
// messages (share links are not restored); importing it again skips every chat.
// Phase 10 (W10.13, ADR-044): the backup holds `customizations.json` with the personal agent and command; delete-all
// keeps them, so the spec removes them before the import, and "Restore settings from the backup" brings them back ("2
// personal definitions restored"); the second import keeps the existing ones ("2 kept").
// Phase 11 (W11.13, ADR-048 - ADR-051): a personal output style travels with the backup like the other definitions
// ("3 personal definitions restored"); a personal hook, a project approval and a project MCP variable never do (no
// entry of the zip holds the hook's command, the approved hash or the variable's value), and delete-all keeps all three.
// Phase 12 (W12.14, ADR-056): the personal command has a `` !`…` `` shell line, so the restore brings it back turned off
// and the result panel says "1 command turned off (it runs shell lines)"; the second import (kept) says nothing.
import type { Locator, Page } from '@playwright/test'
import type { Buffer } from 'node:buffer'
import type { PasswordServer } from '../../helpers/index.ts'
import { readFile } from 'node:fs/promises'
import {
  byTestId,
  chatRow,
  createProject,
  definitionFile,
  expect,
  HarnessApi,
  hookGroup,
  isZip,
  lastAssistantMessage,
  projectSettings,
  readZipText,
  removePersonalDefinitions,
  seedWorkspaceFolder,
  startPasswordServer,
  test,
  testIds,
  uniqueId,
  userMessages,
  zipEntries,
} from '../../helpers/index.ts'

interface SeededChat {
  id: string
  title: string
  text: string
}

/** The seed: two chats with one turn each (4 messages), no attachments. */
const SUMMARY = '2 chats · 4 messages · 0 files'
const EMPTY_SUMMARY = '0 chats · 0 messages · 0 files'

/** From anywhere in the app to Settings -> Data through the sidebar (no reload). */
async function openDataSettings(page: Page): Promise<void> {
  await page.getByTestId(testIds.settingsLink).click()
  await page.getByTestId(testIds.settingsNavData).click()
  await expect(page.getByTestId(testIds.settingsNavData)).toHaveAttribute('data-state', 'active')
  await expect(page.getByTestId(testIds.dataSettings)).toBeVisible()
}

/** Chooses the backup in the import section and runs the import; resolves to the result panel. */
async function importBackup(page: Page, file: { name: string, buffer: Buffer }): Promise<Locator> {
  await page.getByTestId(testIds.dataImportFile).setInputFiles({ name: file.name, mimeType: 'application/zip', buffer: file.buffer })
  const start = page.getByTestId(testIds.dataImport)
  await expect(start).toBeEnabled()
  await start.click()
  const result = page.getByTestId(testIds.dataImportResult)
  await expect(result).toHaveAttribute('data-kind', 'backup')
  return result
}

test.describe('data', () => {
  let server: PasswordServer | undefined
  const chats: SeededChat[] = []
  /** The personal definitions of the seed (Phase 10, plus the Phase 11 style). */
  const definitions = { agent: uniqueId('backup-agent'), command: uniqueId('backup-cmd'), style: uniqueId('backup-style') }
  /** Phase 11 state that never goes into a backup: a personal hook, a project approval and a project MCP variable. */
  const kept = { hookMarker: uniqueId('backup-hook'), hookId: '', projectId: '', approved: '', variable: `secret-${uniqueId('value')}` }

  test.beforeAll(async () => {
    server = await startPasswordServer({ dedicated: true, label: 'hf-e2e-data' })
    const owner = await HarnessApi.create(server.baseURL)
    try {
      await owner.client.auth.login({ body: { password: server.password } })
      for (const name of ['alpha', 'bravo']) {
        const token = uniqueId(`data-${name}`)
        const chat = await owner.createChat({ title: `Backup ${name} ${token}` })
        const text = `Backup message ${name} ${token}`
        await owner.sendChat({ chatId: chat.id, text, modelRef: 'mock:echo' })
        chats.push({ id: chat.id, title: chat.title ?? '', text })
      }
      await owner.client.customizations.create({ body: { kind: 'agent', content: definitionFile({ name: definitions.agent, description: 'Kept in the backup.' }, 'PERSONA: backup\n') } })
      await owner.client.customizations.create({ body: { kind: 'command', content: definitionFile({ name: definitions.command, description: 'A personal command.' }, 'Status: !`echo hi`\nPersonal: $ARGUMENTS\n') } })
      await owner.client.customizations.create({ body: { kind: 'style', content: definitionFile({ name: definitions.style, description: 'A personal style.' }, 'Answer briefly.\n') } })
      // Phase 11: a personal hook (Notification: never shown, never run here), and a project whose hook is approved and
      // whose MCP variable is stored (the login above is fresh).
      kept.hookId = (await owner.client.hooks.create({ body: { event: 'Notification', command: `sh ${kept.hookMarker}.sh` } })).id
      const command = 'sh .harness/hooks/note.sh'
      const folder = await seedWorkspaceFolder(owner, {
        prefix: 'backup',
        files: {
          '.harness/hooks/note.sh': '#!/bin/sh\ncat > /dev/null\n',
          '.harness/settings.json': projectSettings({ SessionStart: [hookGroup(command)] }),
        },
      })
      const project = await createProject(owner, { name: folder.name, path: folder.path })
      kept.projectId = project.id
      const pending = (await owner.client.projectTrust.list({ params: { id: project.id } })).items.filter(item => item.state === 'pending')
      expect(pending.map(item => item.kind)).toEqual(['hook'])
      kept.approved = pending[0]!.sha256
      await owner.client.projectTrust.approve({ params: { id: project.id }, body: { items: [{ kind: 'hook', sha256: kept.approved }] } })
      await owner.client.projectMcp.setVariables({ params: { id: project.id }, body: { values: { BACKUP_TOKEN: kept.variable } } })
    }
    finally {
      await owner.dispose()
    }
  })

  test.afterAll(async () => {
    await server?.stop()
  })

  test('export, delete all and import bring every chat back; a second import skips them @smoke', async ({ page }) => {
    const { baseURL, password } = server!
    const [firstChat] = chats
    // Fake timers from the first document on, so the browser clock can be moved forward before the delete below.
    await page.clock.install()
    // The browser's own session: API calls through `page.request` share the page's cookies.
    const session = new HarnessApi(page.request, baseURL)
    await session.client.auth.login({ body: { password } })
    const share = await session.client.shares.create({ body: { chatId: firstChat!.id } })
    const shareToken = share.path.slice(share.path.lastIndexOf('/') + 1)
    await page.goto(`${baseURL}/`)
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    for (const chat of chats)
      await expect(chatRow(page, chat.id)).toHaveText(chat.title)
    await openDataSettings(page)
    const summary = page.getByTestId(testIds.dataSummary)
    await expect(summary).toHaveText(SUMMARY)
    const shares = page.getByTestId(testIds.sharesSection)
    await expect(shares.getByTestId(testIds.sharesRow)).toHaveCount(1)
    await expect(shares.getByTestId(testIds.sharesRow)).toHaveAttribute('data-share-id', share.id)

    // Export backup: the download is a zip with the manifest and every chat.
    const downloading = page.waitForEvent('download')
    await page.getByTestId(testIds.dataExport).click()
    const download = await downloading
    const name = download.suggestedFilename()
    expect(name).toMatch(/^harness-forge-backup-\d{4}-\d{2}-\d{2}\.zip$/)
    const buffer = await readFile(await download.path())
    expect(buffer.length).toBeGreaterThan(0)
    expect(isZip(buffer), 'the download starts with PK\\x03\\x04').toBe(true)
    const entries = zipEntries(buffer).map(entry => entry.name)
    expect(entries).toEqual(expect.arrayContaining(['manifest.json', 'settings.json', 'customizations.json', ...chats.map(chat => `chats/${chat.id}.json`)]))
    const customizations = JSON.parse(readZipText(buffer, 'customizations.json')) as { items: { kind: string, name: string }[] }
    expect(customizations.items.map(item => `${item.kind}:${item.name}`).sort()).toEqual([`agent:${definitions.agent}`, `command:${definitions.command}`, `style:${definitions.style}`])
    expect(JSON.parse(readZipText(buffer, 'manifest.json'))).toMatchObject({
      format: 'harness-forge.backup',
      version: 1,
      chatExportVersion: 2,
      counts: { chats: 2, messages: 4, files: 0 },
    })
    // Share links are never part of a backup.
    for (const entry of entries) {
      const content = readZipText(buffer, entry)
      expect(content, `${entry} has no share link`).not.toContain(share.id)
      expect(content, `${entry} has no share token`).not.toContain(shareToken)
      // Phase 11: no personal hook, project approval or project MCP variable.
      expect(content, `${entry} has no personal hook`).not.toContain(kept.hookMarker)
      expect(content, `${entry} has no hook id`).not.toContain(kept.hookId)
      expect(content, `${entry} has no approval`).not.toContain(kept.approved)
      expect(content, `${entry} has no variable value`).not.toContain(kept.variable)
    }
    const backup = { name, buffer }

    // Delete all data: "Delete everything" waits for exactly DELETE.
    const deleteAll = page.getByTestId(testIds.dataDelete)
    await deleteAll.click()
    const dialog = page.getByTestId(testIds.dataDeleteDialog)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('This deletes 2 chats and 4 messages.')
    const typed = dialog.getByTestId(testIds.dataDeleteConfirmInput)
    const submit = dialog.getByTestId(testIds.dataDeleteSubmit)
    await expect(typed).toBeFocused()
    await expect(submit).toBeDisabled()
    await typed.fill('delete')
    await expect(submit).toBeDisabled()
    await typed.fill('DELETE')
    await expect(submit).toBeEnabled()

    // Delete-all is a fresh-auth route: 11 minutes after the login the dialog asks for the password first.
    await page.clock.fastForward('11:00')
    await submit.click()
    const prompt = page.getByTestId(testIds.confirmPasswordDialog)
    await expect(prompt).toBeVisible()
    await expect(prompt.getByTestId(testIds.confirmPasswordInput)).toBeFocused()
    await prompt.getByTestId(testIds.confirmPasswordInput).fill(password)
    await prompt.getByTestId(testIds.confirmPasswordSubmit).click()
    await expect(prompt).toBeHidden()
    await expect(dialog).toBeHidden()

    // Everything is gone: the app is back at the empty state and the sidebar lists no chat.
    await expect(page).toHaveURL(`${baseURL}/`)
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    for (const chat of chats)
      await expect(chatRow(page, chat.id)).toHaveCount(0)
    await expect(page.getByTestId(testIds.chatRow)).toHaveCount(0)
    await openDataSettings(page)
    await expect(summary).toHaveText(EMPTY_SUMMARY)
    await expect(shares.getByTestId(testIds.sharesEmpty)).toBeVisible()

    // Delete-all keeps the personal hook, the approval and the variable (configuration, like projects).
    expect((await session.client.hooks.list({ query: {} })).items.some(item => item.id === kept.hookId)).toBe(true)
    const trust = await session.client.projectTrust.list({ params: { id: kept.projectId } })
    expect(trust.items.find(item => item.sha256 === kept.approved)?.state).toBe('approved')
    const mcp = await session.client.projectMcp.list({ params: { id: kept.projectId } })
    expect(mcp.variables.find(variable => variable.name === 'BACKUP_TOKEN')?.set).toBe(true)

    // Delete-all keeps the personal definitions: remove them, so the import has something to restore.
    const all = [definitions.agent, definitions.command, definitions.style].sort()
    const listed = async () => (await session.client.customizations.list({})).items.filter(item => item.source === 'user').map(item => item.name).sort()
    expect(await listed()).toEqual(all)
    await removePersonalDefinitions(session, 'agent', definitions.agent)
    await removePersonalDefinitions(session, 'command', definitions.command)
    await removePersonalDefinitions(session, 'style', definitions.style)
    expect(await listed()).toEqual([])

    // Import the backup (existing chats are skipped by default) with "Restore settings": every chat and the three
    // definitions come back.
    await expect(page.getByTestId(testIds.dataImportPolicy)).toHaveAttribute('data-value', 'skip')
    await page.getByTestId(testIds.dataImportRestoreSettings).click()
    await expect(page.getByTestId(testIds.dataImportRestoreSettings)).toHaveAttribute('data-state', 'checked')
    const imported = await importBackup(page, backup)
    await expect(imported).toContainText('Imported 2 chats')
    await expect(imported.locator('[data-slot="data-import-customizations"]')).toHaveText('3 personal definitions restored')
    // Phase 12: the command with a shell line came back turned off, and the panel counts it.
    await expect(imported.locator('[data-slot="data-import-turned-off"]')).toHaveText('1 command turned off (it runs shell lines)')
    expect(await listed()).toEqual(all)
    expect((await session.client.customizations.list({})).items.find(item => item.source === 'user' && item.name === definitions.command)).toMatchObject({ enabled: false })
    await expect(imported.getByTestId(testIds.dataImportItem)).toHaveCount(2)
    for (const chat of chats)
      await expect(byTestId(imported, testIds.dataImportItem, { 'data-chat-id': chat.id })).toHaveAttribute('data-status', 'imported')
    await expect(summary).toHaveText(SUMMARY)
    await expect(shares.getByTestId(testIds.sharesEmpty)).toBeVisible()

    // The chats are back in the sidebar, with their messages.
    await page.getByTestId(testIds.backToApp).click()
    for (const chat of chats)
      await expect(chatRow(page, chat.id)).toHaveText(chat.title)
    await chatRow(page, firstChat!.id).click()
    await expect(page).toHaveURL(`${baseURL}/chat/${firstChat!.id}`)
    await expect(userMessages(page)).toHaveCount(1)
    await expect(userMessages(page).first()).toContainText(firstChat!.text)
    await expect(lastAssistantMessage(page)).toHaveAttribute('data-status', 'done')
    await expect(lastAssistantMessage(page)).toContainText(firstChat!.text)

    // The same backup again: every chat already exists, so every item is skipped and nothing changes.
    await openDataSettings(page)
    await page.getByTestId(testIds.dataImportRestoreSettings).click()
    const again = await importBackup(page, backup)
    await expect(again).toContainText('Imported 0 chats · skipped 2')
    await expect(again.locator('[data-slot="data-import-customizations"]')).toHaveText('0 personal definitions restored · 3 kept')
    await expect(again.locator('[data-slot="data-import-turned-off"]')).toHaveCount(0)
    await expect(again.getByTestId(testIds.dataImportItem)).toHaveCount(2)
    await expect(byTestId(again, testIds.dataImportItem, { 'data-status': 'skipped' })).toHaveCount(2)
    for (const chat of chats)
      await expect(byTestId(again, testIds.dataImportItem, { 'data-chat-id': chat.id })).toHaveAttribute('data-status', 'skipped')
    await expect(summary).toHaveText(SUMMARY)
  })
})
