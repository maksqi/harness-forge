// Installing plugins from a zip (docs/UI.md 8.3-8.4, docs/PLUGINS.md 12-13, docs/API.md 5.16). The archives are built
// at test time from `e2e/fixtures/plugins/`: a declarative provider (inspect preview -> install -> counts and card
// update live -> listed in Settings, key added there -> in the model picker), a code plugin zipped inside a top-level
// folder (the trust warning and its checkbox gate Install), and a hostile archive whose `../` entry must be rejected
// before anything is installed.
import type { MockOpenAIServer } from '../../fixtures/mock-openai-server.ts'
import { expect, test } from '@playwright/test'
import { startMockOpenAI } from '../../fixtures/mock-openai-server.ts'
import { fixtureZip, withBaseURL } from '../../fixtures/plugins.ts'
import { createZip } from '../../fixtures/zip.ts'
import { getPlugin, inspectZip, postZipInstall, removePlugin, toolNames } from './_support/api.ts'
import { testIds } from './_support/testids.ts'
import {
  browseFilter,
  browseFilterCount,
  byTestId,
  chooseZip,
  openInstallDialog,
  openModelPicker,
  pluginCard,
  startNewChatInApp,
} from './_support/ui.ts'

const PROVIDER_PLUGIN = 'e2e-zip-provider'
const CODE_PLUGIN = 'e2e-zip-code'
const EVIL_PLUGIN = 'e2e-zip-evil'
const API_KEY = 'sk-e2e-zip-1234'
/** The trust warning of docs/PLUGINS.md section 13, verbatim. */
const TRUST_WARNING = 'Runs code on your server with harness-forge\'s permissions. It can read API keys and conversations and make network requests. Only install plugins from sources you trust.'

test.describe('Install from a zip @plugins', () => {
  let mock: MockOpenAIServer

  test.beforeAll(async ({ request }) => {
    mock = await startMockOpenAI({ apiKeys: [API_KEY] })
    for (const id of [PROVIDER_PLUGIN, CODE_PLUGIN, EVIL_PLUGIN])
      await removePlugin(request, id)
  })

  test.afterAll(async ({ request }) => {
    for (const id of [PROVIDER_PLUGIN, CODE_PLUGIN, EVIL_PLUGIN])
      await removePlugin(request, id)
    await mock?.close()
  })

  test('installs a declarative provider zip after the inspect preview @smoke', async ({ page, request }) => {
    const fileName = `${PROVIDER_PLUGIN}-1.0.0.zip`
    const zip = fixtureZip(PROVIDER_PLUGIN, { manifest: withBaseURL(mock.baseURL) })

    await page.goto('/plugins')
    await expect(browseFilterCount(page, 'all')).toBeVisible()
    const before = {
      all: Number(await browseFilterCount(page, 'all').textContent()),
      providers: Number(await browseFilterCount(page, 'providers').textContent()),
      commands: Number(await browseFilterCount(page, 'commands').textContent()),
    }
    const dialog = await openInstallDialog(page)
    await expect(dialog.getByTestId(testIds.installTabZip)).toHaveAttribute('data-state', 'active')
    await chooseZip(dialog, fileName, zip)
    await dialog.getByTestId(testIds.installInspect).click()

    const preview = dialog.getByTestId(testIds.installPreview)
    await expect(dialog).toHaveAttribute('data-step', 'preview')
    await expect(preview).toHaveAttribute('data-kind', 'declarative')
    await expect(preview).toHaveAttribute('data-plugin-id', PROVIDER_PLUGIN)
    await expect(preview).toContainText('E2E Zip Provider')
    await expect(preview).toContainText('1.0.0')
    await expect(preview).toContainText('Declarative')
    await expect(preview).toContainText('1 provider')
    await expect(preview).toContainText(`127.0.0.1:${mock.port}`)
    await expect(preview).toContainText(fileName)
    await expect(dialog.getByTestId(testIds.trustWarning)).toHaveCount(0)
    await expect(dialog.getByTestId(testIds.trustCheckbox)).toHaveCount(0)

    await dialog.getByTestId(testIds.installSubmit).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Installed E2E Zip Provider')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/plugins/${PROVIDER_PLUGIN}(?:\\?|$)`))
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'active')
    expect(await getPlugin(request, PROVIDER_PLUGIN)).toMatchObject({
      kind: 'declarative',
      source: 'zip',
      state: 'active',
      contributions: { providers: [PROVIDER_PLUGIN], commands: ['e2e-zip'] },
    })
    // The sidebar counts and the list follow without a reload.
    await expect(browseFilterCount(page, 'all')).toHaveText(String(before.all + 1))
    await expect(browseFilterCount(page, 'providers')).toHaveText(String(before.providers + 1))
    await expect(browseFilterCount(page, 'commands')).toHaveText(String(before.commands + 1))
    await browseFilter(page, 'providers').click()
    const card = pluginCard(page, PROVIDER_PLUGIN)
    await expect(card).toHaveAttribute('data-state', 'active')
    await expect(card).toContainText('zip')
    await expect(card).toContainText('1 provider')
    await expect(card).toContainText('1 command')

    // Settings -> Providers lists the plugin's provider; it needs its key before the picker shows it.
    await page.getByTestId(testIds.settingsLink).click()
    await expect(page).toHaveURL(/\/settings\/providers/)
    const row = byTestId(page, testIds.providerRow, { 'data-provider-id': PROVIDER_PLUGIN })
    await expect(row).toContainText('E2E Zip')
    await expect(row.getByTestId(testIds.providerStatus)).toHaveAttribute('data-status', 'not_configured')
    await row.getByTestId(testIds.providerConfigure).click()
    const keyDialog = byTestId(page, testIds.keyDialog, { 'data-provider-id': PROVIDER_PLUGIN })
    await byTestId(keyDialog, testIds.keyInput, { 'data-value': 'apiKey' }).fill(API_KEY)
    await keyDialog.getByTestId(testIds.keySave).click()
    await expect(keyDialog).toBeHidden()
    await expect(row.getByTestId(testIds.providerStatus)).toHaveAttribute('data-status', 'connected')
    expect(mock.requests.some(request => request.authorization === `Bearer ${API_KEY}`)).toBe(true)

    await page.getByTestId(testIds.backToApp).click()
    await startNewChatInApp(page)
    const picker = await openModelPicker(page)
    await expect(byTestId(picker, testIds.modelPickerGroup, { 'data-value': PROVIDER_PLUGIN })).toContainText('E2E Zip')
    await expect(byTestId(picker, testIds.modelPickerItem, { 'data-model-ref': `${PROVIDER_PLUGIN}:zip-chat` }).first()).toBeVisible()
  })

  test('installs a code plugin zip only after the trust checkbox is checked @smoke', async ({ page, request }) => {
    const fileName = `${CODE_PLUGIN}-1.0.0.zip`
    const zip = fixtureZip(CODE_PLUGIN, { folder: CODE_PLUGIN })

    await page.goto('/plugins')
    const dialog = await openInstallDialog(page)
    await chooseZip(dialog, fileName, zip)
    await dialog.getByTestId(testIds.installInspect).click()

    const preview = dialog.getByTestId(testIds.installPreview)
    await expect(preview).toHaveAttribute('data-kind', 'code')
    await expect(preview).toHaveAttribute('data-plugin-id', CODE_PLUGIN)
    await expect(preview).toContainText('Runs code')
    const warning = dialog.getByTestId(testIds.trustWarning)
    await expect(warning).toBeVisible()
    await expect(warning).toContainText(TRUST_WARNING)
    await expect(warning).toContainText('Stores data')
    await expect(dialog).toContainText(`I trust ${fileName}`)

    const submit = dialog.getByTestId(testIds.installSubmit)
    await expect(submit).toBeDisabled()
    await dialog.getByTestId(testIds.trustCheckbox).click()
    await expect(dialog.getByTestId(testIds.trustCheckbox)).toHaveAttribute('data-state', 'checked')
    await expect(submit).toBeEnabled()
    await submit.click()

    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/plugins/${CODE_PLUGIN}(?:\\?|$)`))
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'active')
    const installed = await getPlugin(request, CODE_PLUGIN)
    expect(installed).toMatchObject({ kind: 'code', source: 'zip', state: 'active', runsCode: true, editable: false })
    expect(installed?.trust).toMatchObject({ required: true, trusted: true })
    expect(installed?.trust.trustedHash).toBe(installed?.trust.hash)
    expect(await toolNames(request)).toContain('e2e_zip_code_ping')
  })

  test('rejects a zip with a "../" entry and installs nothing @smoke', async ({ page, request }) => {
    const manifest = { manifestVersion: 1, id: EVIL_PLUGIN, name: 'E2E Zip Evil', version: '1.0.0', engines: { harness: '^1.0.0' } }
    const zip = createZip([
      { name: 'plugin.json', data: JSON.stringify(manifest) },
      { name: '../evil.txt', data: 'written outside the plugin folder' },
    ])

    const inspected = await inspectZip(request, 'evil.zip', zip)
    expect(inspected.status()).toBe(400)
    const envelope = await inspected.json() as { error: { code: string, message: string } }
    expect(envelope.error.code).toBe('validation_error')
    expect(envelope.error.message).toContain('"../evil.txt"')

    await page.goto('/plugins')
    const dialog = await openInstallDialog(page)
    await chooseZip(dialog, 'evil.zip', zip)
    await dialog.getByTestId(testIds.installInspect).click()
    const error = dialog.getByRole('alert').filter({ hasText: '../evil.txt' })
    await expect(error).toBeVisible()
    await expect(error).toContainText('".." segment')
    await expect(dialog).toHaveAttribute('data-step', 'source')
    await expect(dialog.getByTestId(testIds.installPreview)).toHaveCount(0)

    const installed = await postZipInstall(request, 'evil.zip', zip)
    expect(installed.status()).toBe(400)
    expect(await getPlugin(request, EVIL_PLUGIN)).toBeNull()
  })
})
