// Provider key dialog (docs/UI.md 9.1-9.2): Save tests the key first; a fake OpenAI key fails that test (401, or no
// network), so the dialog offers "Save anyway". Once stored, the key is never sent back: the dialog shows only its
// masked hint as the placeholder, and no DOM node contains the key.
import { randomBytes } from 'node:crypto'
import { byTestId, expect, test, testIds } from '../../helpers/index.ts'

const PROVIDER_ID = 'openai'

test.describe('providers', () => {
  test('the key dialog saves a key and shows only its masked hint @smoke', async ({ page, api }) => {
    // The connection test may wait for the network (the server gives it up to 15 s).
    test.setTimeout(90_000)
    const fakeKey = `sk-e2e-${randomBytes(16).toString('hex')}`
    const keyEnd = fakeKey.slice(-4)
    // Start from "Not configured", even after an interrupted earlier run on the same data directory.
    await api.clearCredentials(PROVIDER_ID)

    try {
      await page.goto('/settings/providers')
      const row = byTestId(page, testIds.providerRow, { 'data-provider-id': PROVIDER_ID })
      await expect(row.getByTestId(testIds.providerStatus)).toHaveAttribute('data-status', 'not_configured')
      await row.getByTestId(testIds.providerConfigure).click()

      const dialog = byTestId(page, testIds.keyDialog, { 'data-provider-id': PROVIDER_ID })
      await expect(dialog).toBeVisible()
      const input = byTestId(dialog, testIds.keyInput, { 'data-value': 'apiKey' })
      await expect(input).toHaveValue('')
      await expect(input).toHaveAttribute('type', 'password')
      await input.fill(fakeKey)
      await dialog.getByTestId(testIds.keySave).click()

      const result = dialog.getByTestId(testIds.keyTestResult)
      await expect(result).toHaveAttribute('data-status', 'error', { timeout: 30_000 })
      await dialog.getByTestId(testIds.keySaveAnyway).click()
      await expect(dialog).toBeHidden()
      await expect(row.getByTestId(testIds.providerStatus)).not.toHaveAttribute('data-status', 'not_configured')

      // Stored: the server answers only with a masked hint, and so does the dialog.
      await expect.poll(async () => (await api.getProvider(PROVIDER_ID)).credentials.apiKey?.source).toBe('stored')
      const hint = (await api.getProvider(PROVIDER_ID)).credentials.apiKey?.hint ?? ''
      expect(hint).toContain(keyEnd)
      expect(hint).not.toContain(fakeKey)

      await row.getByTestId(testIds.providerConfigure).click()
      await expect(dialog).toBeVisible()
      await expect(input).toHaveValue('')
      await expect(input).toHaveAttribute('placeholder', `${hint} · stored`)
      await expect(dialog.getByTestId(testIds.keyRemove)).toBeVisible()
      expect(await page.content(), 'no DOM node contains the stored key').not.toContain(fakeKey)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }
    finally {
      await api.clearCredentials(PROVIDER_ID)
    }
  })
})
