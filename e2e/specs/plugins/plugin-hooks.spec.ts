// Plugin command hooks (docs/UI.md 7.31, 8.4, 8.8, 9.13; plugin API 1.5.0; ADR-048) with the `hook-pack` example
// (`examples/plugins/hook-pack`: a PostToolUse command hook on `Write|Edit|MultiEdit` that runs
// `sh "$HARNESS_PLUGIN_ROOT/scripts/remind-tests.sh"` and the output style `reviewer`), installed from a zip of its
// folder. Its hook runs shell commands, so the plugin needs trust:
// - The install preview's trust warning lists the command under "Runs these commands" ("PostToolUse hook"), and Install
//   waits for the trust checkbox.
// - Installed without trust (`untrusted`): the card summary reads "1 output style · 1 hook", the detail's banner shows
//   the same warning, the Hooks tab of Customize lists no hook of it, and a project chat's `write_file` runs without a
//   hook record (`mock:hooks` `call write_file …` answers `hooks: none`).
// - "Review and trust" on the detail page trusts it: the Hooks section lists the PostToolUse hook ("Runs only while you
//   trust this plugin."), the Output styles section lists `reviewer`, and the next `write_file` of a project chat gets
//   the hook's context: the reply's `hooks:` names it and the tool row holds the note "Hook added context ·
//   PostToolUse · From Hook pack". The plugin is uninstalled again right away (its hook would run in every chat).
import type { APIRequestContext } from '@playwright/test'
import type { HarnessApi } from '../../helpers/index.ts'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createZip } from '../../fixtures/zip.ts'
import {
  byTestId,
  expect,
  hookNote,
  hookRow,
  MOCK_HOOKS_MODEL,
  mockCall,
  REPO_ROOT,
  seedHookProjectChat,
  test,
  testIds,
  toolRowHook,
} from '../../helpers/index.ts'
import { getPlugin, installZip, removePlugin } from './_support/api.ts'
import { chooseZip, openInstallDialog, pluginCard } from './_support/ui.ts'

const PLUGIN_ID = 'hook-pack'
const PLUGIN_NAME = 'Hook pack'
const PLUGIN_DIR = join(REPO_ROOT, 'examples/plugins/hook-pack')
const FILES = ['plugin.json', 'README.md', 'scripts/remind-tests.sh']
const ZIP_NAME = 'hook-pack-1.0.0.zip'
/** The command of its hook, as `plugin.json` has it. */
const HOOK_COMMAND = 'sh "$HARNESS_PLUGIN_ROOT/scripts/remind-tests.sh"'
/** What `remind-tests.sh` prints as `additionalContext`. */
const HOOK_CONTEXT = 'A file changed: run the project tests before you finish.'

/** A zip of the example's folder. */
function hookPackZip(): Buffer {
  return createZip(FILES.map(name => ({ name, data: readFileSync(join(PLUGIN_DIR, name)) })))
}

/** Removes the plugin (also one left over by an earlier run). */
async function uninstall(request: APIRequestContext): Promise<void> {
  await removePlugin(request, PLUGIN_ID)
}

/** The same through the `cleanup` fixture's API (it also runs after a timeout). */
async function uninstallWith(api: HarnessApi): Promise<void> {
  try {
    await api.client.plugins.remove({ params: { id: PLUGIN_ID }, query: {} })
  }
  catch (error) {
    if ((error as { code?: unknown }).code !== 'not_found')
      throw error
  }
}

test.describe('plugin hooks @plugins', () => {
  test('hook-pack: the trust warning lists its command; untrusted its hook never runs, trusted it adds context @smoke', async ({ page, request, api, cleanup }) => {
    await uninstall(request)
    cleanup(uninstallWith)
    const { chatId } = await seedHookProjectChat(api, cleanup, { prefix: 'plugin-hooks' })
    const zip = hookPackZip()

    // The install preview: the trust warning lists the hook's command, Install waits for the checkbox.
    await page.goto('/plugins')
    const dialog = await openInstallDialog(page)
    await chooseZip(dialog, ZIP_NAME, Buffer.from(zip))
    await dialog.getByTestId(testIds.installInspect).click()
    await expect(dialog.getByTestId(testIds.installPreview)).toHaveAttribute('data-plugin-id', PLUGIN_ID)
    const commands = dialog.getByTestId(testIds.trustWarning).locator('[data-slot="trust-run-commands"]')
    await expect(commands).toContainText('Runs these commands')
    await expect(commands).toContainText('PostToolUse hook')
    await expect(commands.locator('code')).toHaveText([HOOK_COMMAND])
    await expect(dialog.getByTestId(testIds.installSubmit)).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Installed without trust: listed, but its hook is not registered.
    const installed = await installZip(request, ZIP_NAME, zip)
    expect(installed).toMatchObject({ state: 'untrusted', runsCode: true, trust: { required: true, trusted: false } })
    await page.reload()
    await expect(pluginCard(page, PLUGIN_ID)).toContainText('1 output style · 1 hook')
    const untrusted = await api.sendChat({ chatId, modelRef: MOCK_HOOKS_MODEL, toolMode: 'auto', text: mockCall('write_file', { path: 'first.txt', content: 'first\n' }) })
    expect(untrusted.text).toMatch(/^Called write_file: ok \| .* \| hooks: none$/)
    expect(untrusted.chunks.some(chunk => chunk.type === 'data-hook'), 'no hook record while untrusted').toBe(false)
    await page.goto('/settings/customize?tab=hooks')
    await expect(page.getByTestId(testIds.hooksPanel)).toBeVisible()
    await expect(byTestId(page, testIds.hooksSection, { 'data-source': 'personal' })).toBeVisible()
    await expect(hookRow(page, { 'data-plugin-id': PLUGIN_ID })).toHaveCount(0)

    // The detail page: the warning lists the command; "Review and trust" trusts it.
    await page.goto(`/plugins/${PLUGIN_ID}`)
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'untrusted')
    const banner = page.locator('[data-slot="plugin-status-banner"][data-state="untrusted"]')
    await expect(banner.locator('[data-slot="trust-run-commands"] code')).toHaveText([HOOK_COMMAND])
    await banner.getByRole('button', { name: 'Review and trust' }).click()
    const trust = page.getByTestId(testIds.trustDialog)
    await expect(trust).toBeVisible()
    await expect(trust.locator('[data-slot="trust-run-commands"]')).toContainText('PostToolUse hook')
    await trust.getByTestId(testIds.trustCheckbox).click()
    await trust.getByTestId(testIds.trustConfirm).click()
    await expect(trust).toBeHidden()
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'active')
    expect((await getPlugin(request, PLUGIN_ID))?.trust).toMatchObject({ required: true, trusted: true })

    // The detail sections: Hooks (the command hook) and Output styles (`reviewer`).
    const hooks = page.getByTestId(testIds.pluginHooks)
    await expect(hooks).toHaveAttribute('data-count', '1')
    await expect(hooks.locator('[data-slot="plugin-hooks-trust-note"]')).toHaveText('Runs only while you trust this plugin.')
    const hook = byTestId(hooks, testIds.pluginHook, { 'data-event': 'PostToolUse', 'data-kind': 'command' })
    await expect(hook).toContainText('Write|Edit|MultiEdit')
    await expect(hook.locator('code')).toHaveText(HOOK_COMMAND)
    const styles = byTestId(page, testIds.pluginCustomizations, { 'data-kind': 'style' })
    await expect(styles).toHaveAttribute('data-count', '1')
    await expect(byTestId(styles, testIds.pluginCustomization, { 'data-name': 'reviewer' })).toContainText('Short, critical replies')

    // Trusted, the hook runs after `write_file`: its context reaches the model at the next step and shows in the row.
    const trusted = await api.sendChat({ chatId, modelRef: MOCK_HOOKS_MODEL, toolMode: 'auto', text: mockCall('write_file', { path: 'second.txt', content: 'second\n' }) })
    expect(trusted.text.startsWith('Called write_file: ok | ')).toBe(true)
    expect(trusted.text.endsWith(`| hooks: ${HOOK_CONTEXT}`)).toBe(true)
    await page.goto(`/chat/${chatId}`)
    const reply = page.getByTestId(testIds.messageAssistant).last()
    await expect(reply).toContainText(trusted.text)
    const row = byTestId(reply, testIds.toolRow, { 'data-tool-name': 'write_file' })
    // A context record is no decision: no badge in the status cell.
    await expect(toolRowHook(row)).toHaveCount(0)
    await row.getByRole('button').first().click()
    const note = hookNote(row.locator('xpath=ancestor::*[@data-slot="tool-part"][1]'), { 'data-event': 'PostToolUse', 'data-outcome': 'context', 'data-variant': 'tool', 'data-source': 'plugin' })
    await expect(note.locator('[data-slot="hook-note-line"]')).toHaveText('Hook added context · PostToolUse')
    await expect(note.locator('[data-slot="hook-note-source"]')).toHaveText(` · From ${PLUGIN_NAME}`)
    await note.getByTestId(testIds.hookNoteToggle).click()
    await expect(note.getByTestId(testIds.hookNoteDetails).locator('[data-slot="hook-context"]')).toHaveText(HOOK_CONTEXT)
    await uninstall(request)
  })
})
