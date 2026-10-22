// MCP sign-in on a phone (Phase 14, ADR-059; docs/UI.md 2.20, 8.14, 14.5), project `mobile` (Pixel 7 at 390x844, touch):
// in Plugins -> core-mcp a `needs-auth` row puts **Sign in** on its own full-width 40 px line under the status; the
// sign-in (the OAuth MCP fixture's authorization page on `127.0.0.1`, Approve, the callback page) returns to the panel;
// a used callback link shows the error card, which fits 390 px with full-width 40 px buttons.
import type { Locator, Page, Request } from '@playwright/test'
import {
  addHttpMcpServer,
  boxOf,
  documentWidths,
  expect,
  mcpServerRow,
  startOAuthFixture,
  test,
  testIds,
  toastWith,
  touchTargetSize,
  uniqueId,
  waitForMcpStatus,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }

async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${name} height` }).toBeGreaterThanOrEqual(40)
  expect((await touchTargetSize(target)).width, `${name} width`).toBeGreaterThanOrEqual(40)
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${where} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

function isCallbackNavigation(request: Request): boolean {
  const url = new URL(request.url())
  return request.isNavigationRequest() && url.pathname === '/oauth/callback' && url.searchParams.has('code')
}

test.describe('mobile MCP sign-in', () => {
  test('Sign in has its own full-width line; the sign-in returns to the panel; the callback page fits 390 px', async ({ page, api, cleanup }) => {
    const fixture = await startOAuthFixture({ approvePage: true }, cleanup)
    const id = uniqueId('oauth')
    const name = `Docs ${id}`
    await addHttpMcpServer(api, cleanup, { id, name, url: fixture.url })
    await waitForMcpStatus(api, id, 'needs-auth')

    await page.goto('/plugins/core-mcp')
    const row = mcpServerRow(page, id)
    await expect(row).toHaveAttribute('data-status', 'needs-auth')
    const signIn = row.getByTestId(testIds.mcpSignIn)
    await expectTouchTarget(signIn, 'Sign in')
    const status = await boxOf(row.getByTestId(testIds.mcpStatus))
    const button = await boxOf(signIn)
    const rowBox = await boxOf(row)
    expect(button.y, 'Sign in sits under the status').toBeGreaterThanOrEqual(status.y + status.height)
    expect(button.width, 'Sign in is full width').toBeGreaterThan(rowBox.width - 48)
    await expectNoSidewaysScroll(page, 'the MCP panel')

    const callback = page.waitForRequest(isCallbackNavigation)
    await signIn.tap()
    await page.waitForURL(url => url.origin === fixture.origin && url.pathname === '/authorize')
    await page.getByRole('button', { name: 'Approve' }).tap()
    const callbackUrl = (await callback).url()
    await expect(page).toHaveURL(/\/plugins\/core-mcp$/)
    await expect(toastWith(page, `Signed in to ${name}.`)).toBeVisible()
    await expect(row).toHaveAttribute('data-status', 'connected')

    // The used link: the error card fits the phone.
    await page.goto(callbackUrl)
    const card = page.getByTestId(testIds.oauthCallbackError)
    await expect(card).toContainText('This sign-in link was already used or expired.')
    await expectNoSidewaysScroll(page, 'the callback page')
    const view = await boxOf(page.getByTestId(testIds.oauthCallback))
    expect(view.x).toBeGreaterThanOrEqual(0)
    expect(view.x + view.width).toBeLessThanOrEqual(VIEWPORT.width)
    const back = page.getByTestId(testIds.oauthCallbackBack)
    await expectTouchTarget(back, 'Back to MCP servers')
    expect((await boxOf(back)).width, 'Back to MCP servers is full width').toBeGreaterThan(view.width - 64)
  })
})
