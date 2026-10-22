// MCP sign-in (Phase 14, ADR-059; docs/UI.md 2.20, 8.14; docs/API.md 4.36): the OAuth MCP fixture (`helpers/mcp.ts`,
// started on `127.0.0.1` while the app runs on `localhost`, so the redirect back is a genuinely cross-site navigation)
// asks for a sign-in.
// - A personal HTTP server added in Plugins -> core-mcp is `needs-auth` ("Sign in required"); **Sign in** leaves for the
//   fixture's authorization page (Approve / Deny), which redirects to `/oauth/callback`; the page finishes the sign-in
//   and returns to the MCP panel with "Signed in to {server}."; the row is connected and its tools are listed. Sign out
//   (confirmed) forgets the tokens (the fixture counts the revocation): `needs-auth` again. The used callback link, opened
//   again, reads "This sign-in link was already used or expired.".
// - The dialog's OAuth section: client ID, the write-only client secret ("•••• · stored", Remove) and scopes, the
//   redirect URI of this app with Copy; a configured confidential client signs in.
// - With a password (a server of its own, `HF_PASSWORD`): the session cookie is `SameSite=Strict`, so the cross-site
//   redirect itself carries no cookie, and the callback page still finishes the sign-in with its same-origin request.
import type { Request } from '@playwright/test'
import {
  byTestId,
  expect,
  FIXTURE_CLIENT_ID,
  FIXTURE_CLIENT_SECRET,
  FIXTURE_TOOLS,
  HarnessApi,
  mcpServer,
  mcpServerRow,
  mcpToolName,
  openMcpPanel,
  removeMcpServer,
  startOAuthFixture,
  startPasswordServer,
  test,
  testIds,
  toastWith,
  uniqueId,
  waitForMcpStatus,
} from '../../helpers/index.ts'

/** The navigation back from the authorization server to the callback page (with its `code`). */
function isCallbackNavigation(request: Request): boolean {
  const url = new URL(request.url())
  return request.isNavigationRequest() && url.pathname === '/oauth/callback' && url.searchParams.has('code')
}

test.describe('MCP sign-in (OAuth) @plugins', () => {
  test('signs in from the MCP panel through the authorization page, lists the tools and signs out @smoke', async ({ page, api, cleanup }) => {
    const fixture = await startOAuthFixture({ approvePage: true }, cleanup)
    const id = uniqueId('oauth')
    const name = `Docs ${id}`
    cleanup(api => removeMcpServer(api, id))

    // Added in the MCP panel: the server asks for a sign-in.
    const panel = await openMcpPanel(page)
    await panel.getByTestId(testIds.mcpAdd).click()
    const dialog = page.getByTestId(testIds.mcpDialog)
    await expect(dialog).toBeVisible()
    await dialog.locator('[data-field="name"]').fill(name)
    await dialog.locator('[data-field="id"]').fill(id)
    await byTestId(dialog, testIds.mcpTransportTab, { 'data-value': 'http' }).click()
    await dialog.locator('[data-field="url"]').fill(fixture.url)
    await expect(dialog.getByTestId(testIds.mcpOauthSection)).toHaveAttribute('data-state', 'closed')
    await dialog.getByTestId(testIds.mcpSave).click()
    await expect(dialog).toBeHidden()
    const row = mcpServerRow(page, id)
    await expect(row).toHaveAttribute('data-status', 'needs-auth', { timeout: 20_000 })
    await expect(row.getByTestId(testIds.mcpStatus)).toHaveText('Sign in required')
    expect((await mcpServer(api, id))?.tools).toEqual([])

    // Sign in: the fixture's authorization page, Approve, the callback page, back on the MCP panel.
    const callback = page.waitForRequest(isCallbackNavigation)
    await row.getByTestId(testIds.mcpSignIn).click()
    await page.waitForURL(url => url.origin === fixture.origin && url.pathname === '/authorize')
    await expect(page.getByRole('heading', { name: 'Authorize access' })).toBeVisible()
    await page.getByRole('button', { name: 'Approve' }).click()
    const callbackUrl = (await callback).url()
    expect(new URL(callbackUrl).origin, 'the callback is this app').toBe(new URL(page.url()).origin)
    await expect(page).toHaveURL(/\/plugins\/core-mcp$/)
    await expect(toastWith(page, `Signed in to ${name}.`)).toBeVisible()
    await expect(row).toHaveAttribute('data-status', 'connected')
    await expect(row.getByTestId(testIds.mcpStatus)).toHaveText(`Connected · ${FIXTURE_TOOLS.length} tools · Signed in`)
    await expect(row.getByTestId(testIds.mcpSignIn)).toHaveCount(0)
    const tools = FIXTURE_TOOLS.map(tool => mcpToolName(id, tool))
    for (const tool of tools)
      await expect(byTestId(page, testIds.pluginToolRow, { 'data-tool-name': tool })).toBeVisible()
    const signedIn = await mcpServer(api, id)
    expect(signedIn?.auth).toMatchObject({ signedIn: true, client: 'dynamic', issuer: fixture.origin })
    expect([...signedIn?.tools ?? []].sort()).toEqual([...tools].sort())
    expect(fixture.counters().tokens).toBe(1)

    // Sign out (confirmed): the tokens are revoked and forgotten, the server asks for a sign-in again.
    await page.locator(`[data-action="mcp-menu"][data-server-id="${id}"]`).click()
    await byTestId(page, testIds.mcpSignOut, { 'data-server-id': id }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText(`Sign out of ${name}?`)
    await expect(confirm).toContainText('harness-forge forgets the tokens; the server stays configured.')
    await page.locator('[data-action="mcp-sign-out-confirm"]').click()
    await expect(toastWith(page, `Signed out of ${name}.`)).toBeVisible()
    await expect(row).toHaveAttribute('data-status', 'needs-auth')
    await expect(row.getByTestId(testIds.mcpSignIn)).toBeVisible()
    expect((await mcpServer(api, id))?.auth ?? null).toBeNull()
    await expect.poll(() => fixture.counters().revocations, { message: 'the token was revoked' }).toBeGreaterThanOrEqual(1)

    // The used callback link, opened again: the state is gone.
    await page.goto(callbackUrl)
    const error = page.getByTestId(testIds.oauthCallbackError)
    await expect(page.getByTestId(testIds.oauthCallback)).toHaveAttribute('data-state', 'error')
    await expect(error).toHaveAttribute('data-code', 'conflict')
    await expect(error).toContainText('This sign-in link was already used or expired.')
    await expect(page.getByTestId(testIds.oauthCallbackRetry)).toHaveCount(0)
    // The page never keeps the code in its address.
    await expect(page).toHaveURL(/\/oauth\/callback$/)
    await page.getByTestId(testIds.oauthCallbackBack).click()
    await expect(page.getByTestId(testIds.mcpPanel)).toBeVisible()
  })

  test('the OAuth fields: a client ID, a write-only client secret, scopes and the redirect URI with Copy', async ({ page, api, cleanup, context, baseURL }) => {
    const fixture = await startOAuthFixture({}, cleanup)
    const id = uniqueId('oauth')
    const name = `Tracker ${id}`
    cleanup(api => removeMcpServer(api, id))
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])

    const panel = await openMcpPanel(page)
    await panel.getByTestId(testIds.mcpAdd).click()
    const dialog = page.getByTestId(testIds.mcpDialog)
    await dialog.locator('[data-field="name"]').fill(name)
    await dialog.locator('[data-field="id"]').fill(id)
    await byTestId(dialog, testIds.mcpTransportTab, { 'data-value': 'http' }).click()
    await dialog.locator('[data-field="url"]').fill(fixture.url)
    const section = dialog.getByTestId(testIds.mcpOauthSection)
    await expect(section).toHaveAttribute('data-state', 'closed')
    await section.getByRole('button', { name: /Sign-in \(OAuth\)/ }).click()
    await expect(section).toHaveAttribute('data-state', 'open')
    await expect(section).toContainText('Leave empty to register harness-forge with the server when you sign in.')
    const redirectUri = new URL('/oauth/callback', baseURL).href
    await expect(section.getByTestId(testIds.mcpOauthRedirectUri)).toHaveText(redirectUri)
    await section.getByRole('button', { name: 'Copy redirect URI' }).click()
    await expect.poll(() => page.evaluate('navigator.clipboard.readText()')).toBe(redirectUri)
    await section.getByTestId(testIds.mcpOauthClientId).fill(FIXTURE_CLIENT_ID)
    const secret = section.getByTestId(testIds.mcpOauthClientSecret)
    await expect(secret).toHaveAttribute('type', 'password')
    await secret.fill(FIXTURE_CLIENT_SECRET)
    await section.getByTestId(testIds.mcpOauthScopes).fill('mcp:read')
    await dialog.getByTestId(testIds.mcpSave).click()
    await expect(dialog).toBeHidden()

    const row = mcpServerRow(page, id)
    await expect(row).toHaveAttribute('data-status', 'needs-auth', { timeout: 20_000 })
    const saved = await mcpServer(api, id)
    expect(saved?.transport.type === 'http' && saved.transport.oauth).toEqual({ clientId: FIXTURE_CLIENT_ID, clientSecret: expect.objectContaining({ set: true }), scopes: 'mcp:read' })

    // Edit: the section is open (values set); the secret is never read back: an empty input, "•••• · stored", Remove.
    await page.locator(`[data-action="mcp-menu"][data-server-id="${id}"]`).click()
    await byTestId(page, testIds.mcpEdit, { 'data-server-id': id }).click()
    await expect(dialog).toBeVisible()
    await expect(section).toHaveAttribute('data-state', 'open')
    await expect(section.getByTestId(testIds.mcpOauthClientId)).toHaveValue(FIXTURE_CLIENT_ID)
    await expect(secret).toHaveValue('')
    await expect(secret).toHaveAttribute('data-stored', 'true')
    await expect(secret).toHaveAttribute('placeholder', /· stored$/)
    await expect(section.locator('[data-action="remove-secret"]')).toHaveAttribute('aria-pressed', 'false')
    expect(await page.content(), 'the page never holds the client secret').not.toContain(FIXTURE_CLIENT_SECRET)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // The configured confidential client signs in (the fixture auto-approves).
    await row.getByTestId(testIds.mcpSignIn).click()
    await expect(page).toHaveURL(/\/plugins\/core-mcp$/)
    await expect(toastWith(page, `Signed in to ${name}.`)).toBeVisible()
    await expect(row).toHaveAttribute('data-status', 'connected')
    expect((await mcpServer(api, id))?.auth).toMatchObject({ signedIn: true, client: 'configured', scope: 'mcp:read' })
    expect(fixture.counters().registrations, 'no dynamic registration').toBe(0)

    // Editing the URL drops the tokens: the dialog says so before saving.
    await page.locator(`[data-action="mcp-menu"][data-server-id="${id}"]`).click()
    await byTestId(page, testIds.mcpEdit, { 'data-server-id': id }).click()
    await expect(dialog.locator('[data-slot="mcp-signs-out"]')).toHaveCount(0)
    await dialog.locator('[data-field="url"]').fill(`${fixture.origin}/mcp/`)
    await expect(dialog.locator('[data-slot="mcp-signs-out"]')).toHaveText(`Saving signs you out of ${name}.`)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(row).toHaveAttribute('data-status', 'connected')
  })
})

test.describe('MCP sign-in with a password @plugins', () => {
  test('the callback page finishes the sign-in with the session cookie after the cross-site redirect', async ({ browser, cleanup }) => {
    const server = await startPasswordServer({ dedicated: true, label: 'hf-e2e-oauth' })
    cleanup(() => server.stop())
    // The app on `localhost`, the fixture on `127.0.0.1`: two sites.
    const appURL = server.baseURL.replace('127.0.0.1', 'localhost')
    const fixture = await startOAuthFixture({ approvePage: true }, cleanup)
    const api = await HarnessApi.create(appURL)
    cleanup(() => api.dispose())
    await api.client.auth.login({ body: { password: server.password } })
    const id = uniqueId('oauth')
    const name = `Wiki ${id}`
    await api.client.mcp.create({ body: { id, name, transport: { type: 'http', url: fixture.url } } })
    await waitForMcpStatus(api, id, 'needs-auth')

    const context = await browser.newContext({ baseURL: appURL })
    cleanup(() => context.close())
    const page = await context.newPage()
    await page.goto('/plugins/core-mcp')
    await expect(page.getByTestId(testIds.loginForm)).toBeVisible()
    await page.getByTestId(testIds.loginPassword).fill(server.password)
    await page.getByTestId(testIds.loginSubmit).click()
    const row = mcpServerRow(page, id)
    await expect(row).toHaveAttribute('data-status', 'needs-auth')
    const session = (await context.cookies()).find(cookie => cookie.name === 'hf_session')
    expect(session?.sameSite, 'the session cookie is SameSite=Strict').toBe('Strict')

    const callback = page.waitForRequest(isCallbackNavigation)
    await row.getByTestId(testIds.mcpSignIn).click()
    await page.waitForURL(url => url.origin === fixture.origin && url.pathname === '/authorize')
    await page.getByRole('button', { name: 'Approve' }).click()
    const navigation = await callback
    expect(await navigation.headerValue('cookie') ?? '', 'the cross-site redirect carries no session cookie').not.toContain('hf_session')
    await expect(page).toHaveURL(/\/plugins\/core-mcp$/)
    await expect(toastWith(page, `Signed in to ${name}.`)).toBeVisible()
    await expect(row).toHaveAttribute('data-status', 'connected')
    expect((await waitForMcpStatus(api, id, 'connected')).auth?.signedIn).toBe(true)
  })
})
