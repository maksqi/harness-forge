// Login (docs/UI.md 6, 9.7; ADR-012) against a second server that requires a password (`HF_PASSWORD`): a page opened
// without a session redirects to /login?redirect=<path>, a wrong password shows an inline error, the right one opens
// the requested page, and the session survives a reload. See `startPasswordServer()` for how the server is found.
import type { PasswordServer } from '../../helpers/index.ts'
import { expect, HarnessApi, startPasswordServer, test, testIds } from '../../helpers/index.ts'

test.describe('login', () => {
  let server: PasswordServer | undefined

  test.beforeAll(async () => {
    server = await startPasswordServer()
  })

  test.afterAll(async () => {
    await server?.stop()
  })

  test('a password-protected server redirects to login, rejects a wrong password and lets the right one in @smoke', async ({ page }) => {
    const { baseURL, password } = server!
    const target = '/settings/general'
    const passwordInput = page.getByTestId(testIds.loginPassword)
    const submit = page.getByTestId(testIds.loginSubmit)

    // Without a session the API refuses everything but the public routes.
    const anonymous = await HarnessApi.create(baseURL)
    try {
      await expect(anonymous.getSettings()).rejects.toMatchObject({ code: 'unauthorized' })
      expect(await anonymous.client.auth.status()).toMatchObject({ enabled: true, authenticated: false })
    }
    finally {
      await anonymous.dispose()
    }

    await page.goto(`${baseURL}${target}`)
    await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('redirect') === target)
    await expect(page.getByTestId(testIds.loginForm)).toBeVisible()
    await expect(page.getByTestId(testIds.sidebar)).toHaveCount(0)
    await expect(passwordInput).toBeFocused()

    await passwordInput.fill(`wrong-${password}`)
    await submit.click()
    await expect(page.getByTestId(testIds.loginError)).toHaveText('Wrong password')
    await expect(page).toHaveURL(url => url.pathname === '/login')

    await passwordInput.fill(password)
    await submit.click()
    await expect(page).toHaveURL(`${baseURL}${target}`)
    await expect(page.getByTestId(testIds.settingsDisplayName)).toBeVisible()
    await expect(page.getByTestId(testIds.sidebar)).toBeVisible()

    await page.reload()
    await expect(page).toHaveURL(`${baseURL}${target}`)
    await expect(page.getByTestId(testIds.settingsDisplayName)).toBeVisible()

    // The browser's session cookie authenticates API calls too.
    const session = new HarnessApi(page.request, baseURL)
    expect(await session.client.auth.status()).toMatchObject({ enabled: true, authenticated: true })
    expect((await session.getSettings()).sendKey).toBeTruthy()
  })
})
