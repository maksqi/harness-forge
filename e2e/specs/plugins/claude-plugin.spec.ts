// Claude Code plugins (Phase 12, ADR-053; docs/UI.md 8.3, 8.13, 13.13) installed from a zip and from a folder on the
// server, both made at test time in temporary folders outside the repository (`_support/claude.ts`):
// - From a zip (`claudeKitTree`, zipped inside one top folder): the install preview shows the format badge "Claude Code
//   plugin", the namespace line ("Commands run as /{plugin}:…", "Agents start as {plugin}:reviewer."), "Asks for:" with
//   the secret `userConfig` option and "Ignored:" (`.lsp.json`, `bin/`, the `http` hook handler); the trust warning lists
//   the hook command and the whole-tree pin note, and Install waits for the trust checkbox. Installed, the plugin page
//   lists its components with qualified names (commands, the agent, the skill, the hook), has the "Claude Code plugin"
//   section, no Source tab and no "Edit in wizard"; its Configuration tab shows the `userConfig` secret as a password
//   field that is stored on Save (only the "Stored" state comes back). In a chat, `/{plugin}:review` comes from the
//   slash menu's Plugins group and its expansion reaches the model (`mock:echo` answers with it).
// - From a folder (`claudeNotesTree`, mode Copy): no trust warning, Install at once; the card carries the "Claude Code"
//   format badge.
// The hook of the zip plugin matches no tool (`E2eNeverMatches`), so it never runs; both plugins are uninstalled through
// `cleanup`.
import type { Page } from '@playwright/test'
import {
  byTestId,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  openNewChat,
  seedTempTree,
  selectModel,
  sendMessage,
  test,
  testIds,
  userMessages,
  zipTree,
} from '../../helpers/index.ts'
import {
  claudeKitTree,
  claudeNotesTree,
  KIT_DESCRIPTION,
  KIT_HOOK_COMMAND,
  useCleanPlugin,
} from './_support/claude.ts'
import { chooseZip, openInstallDialog, pluginCard } from './_support/ui.ts'

const KIT = 'e2e-claude-kit'
const NOTES = 'e2e-claude-notes'
const TOKEN = 'e2e-token-value-1234'

/** The command list of the plugin page's Commands section. */
function commandNames(page: Page) {
  return page.getByRole('region', { name: /^Commands\b/ }).locator('li code')
}

test.describe('Claude Code plugins @plugins', () => {
  test('from a zip: the Claude preview, trust, the plugin page, the userConfig secret and /{plugin}:{command} in a chat @smoke', async ({ page, api, cleanup }) => {
    await useCleanPlugin(api, cleanup, KIT)
    const zip = zipTree(claudeKitTree(KIT), { folder: KIT })

    // The preview of a Claude Code plugin.
    await page.goto('/plugins')
    const dialog = await openInstallDialog(page)
    await chooseZip(dialog, `${KIT}-1.0.0.zip`, zip)
    await dialog.getByTestId(testIds.installInspect).click()
    const preview = dialog.getByTestId(testIds.installPreview)
    await expect(preview).toHaveAttribute('data-plugin-id', KIT)
    await expect(preview).toHaveAttribute('data-format', 'claude')
    await expect(preview.locator('[data-slot="install-format"]')).toHaveText('Claude Code plugin')
    await expect(preview).toContainText(KIT_DESCRIPTION)
    const namespace = preview.locator('[data-slot="install-namespace"]')
    await expect(namespace).toContainText(`Commands run as /${KIT}:`)
    await expect(namespace).toContainText(`Agents start as ${KIT}:reviewer.`)
    await expect(preview.locator('[data-slot="install-user-config"] li')).toHaveText(['API URL', 'API token (secret) (required)'])
    const ignored = preview.locator('[data-slot="install-ignored"]')
    await expect(ignored).toContainText('.lsp.json')
    await expect(ignored).toContainText('bin')
    await expect(ignored).toContainText('http')

    // Trust: the hook command and the whole-tree pin; Install waits for the checkbox.
    const warning = dialog.getByTestId(testIds.trustWarning)
    const commands = warning.locator('[data-slot="trust-run-commands"]')
    await expect(commands).toContainText('PostToolUse hook')
    await expect(commands.locator('code')).toHaveText([KIT_HOOK_COMMAND])
    await expect(warning.locator('[data-slot="trust-tree-note"]')).toHaveText('The files are pinned as a whole: editing any file of the plugin asks for your trust again.')
    const install = dialog.getByTestId(testIds.installSubmit)
    await expect(install).toBeDisabled()
    await dialog.getByTestId(testIds.trustCheckbox).click()
    await install.click()

    // Installed: the plugin page with its components under qualified names, no editor.
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/plugins/${KIT}$`))
    const detail = page.getByTestId(testIds.pluginDetail)
    await expect(detail).toHaveAttribute('data-state', 'active')
    const info = page.locator('[data-slot="plugin-claude-info"]')
    await expect(info).toContainText(`Its commands, agents and skills start with ${KIT}:`)
    await expect(info.locator('[data-slot="plugin-claude-version"]')).toHaveText('1.0.0')
    await expect(info.locator('[data-slot="plugin-claude-executables"] code')).toHaveText([KIT_HOOK_COMMAND])
    await expect(info.locator('[data-slot="plugin-claude-ignored"]')).toContainText('.lsp.json')
    // A skill is a slash command too (Claude Code behavior).
    await expect(commandNames(page)).toHaveText([`/${KIT}:db:migrate`, `/${KIT}:notes`, `/${KIT}:review`])
    await expect(byTestId(page, testIds.pluginCustomization, { 'data-name': `${KIT}:reviewer` })).toBeVisible()
    await expect(byTestId(page, testIds.pluginCustomization, { 'data-name': `${KIT}:notes` })).toBeVisible()
    const hooks = page.getByTestId(testIds.pluginHooks)
    await expect(byTestId(hooks, testIds.pluginHook, { 'data-event': 'PostToolUse', 'data-kind': 'command' })).toContainText('E2eNeverMatches')
    await expect(page.getByTestId(testIds.pluginTabSource)).toHaveCount(0)
    await page.getByTestId(testIds.pluginMenu).click()
    await expect(page.getByTestId(testIds.pluginUninstall)).toBeVisible()
    await expect(page.getByTestId(testIds.pluginEdit)).toHaveCount(0)
    await page.keyboard.press('Escape')

    // The settings form: the userConfig secret is a password field; Save stores it, only "Stored" comes back.
    await page.getByTestId(testIds.pluginTabConfiguration).click()
    const tokenField = byTestId(page, testIds.schemaField, { 'data-value': 'API_TOKEN' })
    await expect(tokenField).toContainText('API token')
    const tokenInput = tokenField.locator('input')
    await expect(tokenInput).toHaveAttribute('type', 'password')
    await tokenInput.fill(TOKEN)
    await page.getByTestId(testIds.schemaFormSave).click()
    await expect(tokenField.locator('[data-slot="schema-secret-input"]')).toHaveAttribute('data-state', 'stored')
    await expect(tokenField).toContainText('Stored')
    const settings = await api.client.plugins.getSettings({ params: { id: KIT } })
    expect(JSON.stringify(settings)).not.toContain(TOKEN)

    // `/{plugin}:review` in a chat: listed under Plugins, expanded on the server.
    await openNewChat(page)
    await selectModel(page, 'mock:echo')
    await page.getByTestId(testIds.composerInput).fill(`/${KIT}:rev`)
    await expect(byTestId(page.getByTestId(testIds.slashMenu), testIds.slashMenuItem, { 'data-value': `${KIT}:review`, 'data-group': 'plugin' })).toBeVisible()
    await page.getByTestId(testIds.composerInput).fill('')
    await sendMessage(page, `/${KIT}:review the parser`)
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText('Review the changed files. Focus on the parser.')
    await expect(userMessages(page).last()).toContainText(`/${KIT}:review the parser`)
    const chatId = new URL(page.url()).pathname.split('/').pop() ?? ''
    cleanup(api => api.removeChat(chatId))
  })

  test('from a folder on the server: no trust needed, the Claude Code badge on the card @smoke', async ({ page, api, cleanup }) => {
    await useCleanPlugin(api, cleanup, NOTES)
    const folder = await seedTempTree(cleanup, 'claude-plugin', claudeNotesTree(NOTES))

    await page.goto('/plugins')
    const dialog = await openInstallDialog(page)
    await dialog.getByTestId(testIds.installTabFolder).click()
    await dialog.getByTestId(testIds.installFolderInput).fill(folder.path)
    await byTestId(dialog, testIds.installFolderMode).locator('[data-value="copy"]').click()
    await dialog.getByTestId(testIds.installInspect).click()
    const preview = dialog.getByTestId(testIds.installPreview)
    await expect(preview).toHaveAttribute('data-plugin-id', NOTES)
    await expect(preview.locator('[data-slot="install-format"]')).toHaveText('Claude Code plugin')
    await expect(preview.locator('[data-slot="install-namespace"]')).toContainText(`Commands run as /${NOTES}:`)
    await expect(dialog.getByTestId(testIds.trustWarning)).toHaveCount(0)
    await expect(dialog.getByTestId(testIds.trustCheckbox)).toHaveCount(0)
    await dialog.getByTestId(testIds.installSubmit).click()
    await expect(page).toHaveURL(new RegExp(`/plugins/${NOTES}$`))
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'active')
    await expect(commandNames(page)).toHaveText([`/${NOTES}:note`, `/${NOTES}:summarize`])
    await expect(page.getByTestId(testIds.pluginTabSource)).toHaveCount(0)

    await page.goto('/plugins')
    const card = pluginCard(page, NOTES)
    await expect(card.locator('[data-slot="plugin-format-badge"]')).toHaveAttribute('data-value', 'claude')
    await expect(card.locator('[data-slot="plugin-format-badge"]')).toHaveText('Claude Code')
  })
})
