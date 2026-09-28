// Provider errors and the no-provider state (docs/UI.md 7.4, 7.13): `mock:error` fails inside the stream with
// `auth_invalid`, a model of a provider without a key fails before the stream with `provider_not_configured`; both show
// an alert whose "Open settings" action deep-links to the provider's key dialog. With no usable provider the empty
// state shows "Connect a provider to start" and Send stays disabled.
import {
  byTestId,
  composer,
  expect,
  lastAssistantMessage,
  openNewChat,
  sendMessage,
  startChat,
  test,
  testIds,
  uniqueId,
} from '../../helpers/index.ts'

test.describe('chat errors', () => {
  test('mock:error shows the error alert with open settings @smoke', async ({ page }) => {
    await startChat(page, { modelRef: 'mock:error', text: `Error check ${uniqueId('error')}` })

    const alert = page.getByTestId(testIds.chatError)
    await expect(alert).toBeVisible()
    await expect(alert).toHaveAttribute('data-code', 'auth_invalid')
    await expect(alert).toContainText('rejected the API key')
    await expect(alert).toContainText('Mock authentication failure')
    await expect(lastAssistantMessage(page)).toHaveAttribute('data-status', 'error')
    await expect(page.getByTestId(testIds.composerSend)).toBeVisible()

    const openSettings = byTestId(alert, testIds.chatErrorAction, { 'data-action': 'configure-provider' })
    await expect(openSettings).toHaveText('Open settings')
    await openSettings.click()
    await expect(page).toHaveURL(/\/settings\/providers\?configure=mock$/)
    await expect(byTestId(page, testIds.keyDialog, { 'data-provider-id': 'mock' })).toBeVisible()
  })

  test('a model whose provider has no key shows no api key with open settings @smoke', async ({ page, api }) => {
    const models = (await api.client.models.list({ query: { providerId: 'anthropic' } })).items
    const modelRef = models.find(model => model.kind === 'chat')?.ref
    expect(modelRef, 'the catalog lists an Anthropic chat model').toBeTruthy()
    expect((await api.getProvider('anthropic')).status).toBe('not_configured')
    const previous = (await api.getSettings()).defaultModelRef
    await api.updateSettings({ defaultModelRef: modelRef! })
    try {
      await openNewChat(page)
      await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', modelRef!)
      await sendMessage(page, `No key check ${uniqueId('nokey')}`)

      const alert = page.getByTestId(testIds.chatError)
      await expect(alert).toBeVisible()
      await expect(alert).toHaveAttribute('data-code', 'provider_not_configured')
      await expect(alert).toContainText('No API key for')
      const openSettings = byTestId(alert, testIds.chatErrorAction, { 'data-action': 'configure-provider' })
      await expect(openSettings).toHaveText('Open settings')
      await openSettings.click()
      await expect(page).toHaveURL(/\/settings\/providers\?configure=anthropic$/)
      await expect(byTestId(page, testIds.keyDialog, { 'data-provider-id': 'anthropic' })).toBeVisible()
    }
    finally {
      await api.updateSettings({ defaultModelRef: previous })
    }
  })

  test('the empty state asks to connect a provider when none is usable @smoke', async ({ page, api }) => {
    const restore = await api.disableUsableProviders()
    try {
      await page.goto('/')
      const callout = page.getByTestId(testIds.noProviderCallout)
      await expect(callout).toBeVisible()
      await expect(callout).toContainText('Connect a provider to start')

      await page.getByTestId(testIds.composerInput).fill(`Nothing to send to ${uniqueId('none')}`)
      await expect(page.getByTestId(testIds.composerSend)).toHaveAttribute('data-state', 'disabled')

      await page.getByTestId(testIds.noProviderConnect).click()
      await expect(page).toHaveURL(/\/settings\/providers$/)
      await expect(byTestId(page, testIds.providerRow, { 'data-provider-id': 'mock' })).toBeVisible()
    }
    finally {
      await restore()
    }

    // With a usable provider again, the callout is gone.
    await openNewChat(page)
    await expect(page.getByTestId(testIds.noProviderCallout)).toBeHidden()
  })
})
