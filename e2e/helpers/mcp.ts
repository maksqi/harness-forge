// MCP 2.0 helpers for the Phase 14 specs (docs/UI.md 2.20, 7.35, 8.14, 13.14; docs/API.md 4.36 – 4.38; docs/PROVIDERS.md
// 8 "MCP and search mocks (Phase 14)"; ADR-059 … ADR-061): the OAuth MCP fixture (`fixtures/mcp-oauth-server.mjs`, a
// re-export of the server's fixture) started in the Playwright worker, personal http servers made through the API and
// removed through `cleanup`, the API side of a sign-in (start → the fixture's auto-approved `/authorize` → the callback),
// and the locators of the elicitation card.
//
// - The fixture listens on `127.0.0.1` while the app under test runs on `localhost`: the redirect from the fixture's
//   authorization page back to `/oauth/callback` is a genuinely cross-site navigation (open point 9).
// - Personal MCP servers are global state of the server: every helper that adds one removes it through `cleanup`, and
//   specs give them unique ids (`uniqueId`). Their tools are offered in every chat while they exist.
// - Elicitation: `mock:hooks` with `call mcp__<server>__ask {}` (PROVIDERS.md 8) asks for the fixture's basic form
//   (`name` required, `email`, `count` 1..10, `subscribe`, `color` red / green / blue) and answers the action and the
//   field names, never the values. A server added with `policy: 'safe'` runs its tools without an approval card.
import type { Locator, Page } from '@playwright/test'
import type { McpAuthCallbackResult, McpServer, McpStatus, ToolPolicy } from '../../packages/shared/src/index.ts'
import type { FixtureToggles, OAuthMcpServer } from '../fixtures/mcp-oauth-server.mjs'
import type { HarnessApi } from './api.ts'
import type { CleanupTask } from './fixtures.ts'
import type { DataAttributes } from './locators.ts'
import { expect } from '@playwright/test'
import { startOAuthMcpServer } from '../fixtures/mcp-oauth-server.mjs'
import { byTestId } from './locators.ts'
import { testIds } from './testids.ts'

export {
  FIXTURE_CLIENT_ID,
  FIXTURE_CLIENT_SECRET,
  LARGE_URI,
  PIXEL_URI,
  README_URI,
} from '../fixtures/mcp-oauth-server.mjs'
export type { FixtureCounters, FixtureToggles, OAuthMcpServer } from '../fixtures/mcp-oauth-server.mjs'

// ---------- the fixture ----------

/** The tools of the OAuth fixture (`mcp__<server>__<tool>`). */
export const FIXTURE_TOOLS = ['ask', 'ask_echo', 'slow_ask', 'whoami'] as const
/** The message of the fixture's basic form. */
export const FIXTURE_FORM_MESSAGE = 'The OAuth MCP fixture needs a few details.'
/** The fields of the basic form, in order. */
export const FIXTURE_FORM_FIELDS = ['name', 'email', 'count', 'subscribe', 'color'] as const
/** The prompts of the fixture (`/mcp__<server>__<prompt>`). */
export const FIXTURE_PROMPTS = ['greet', 'review', 'with_resource', 'with_image'] as const

/**
 * Starts the OAuth MCP fixture on a free port of `127.0.0.1` (the app runs on `localhost`: cross-site). Stop it with
 * `stop()` (or pass `cleanup` to stop it after the test). `approvePage` serves the Approve / Deny page instead of the
 * auto-approval; `noAuth` answers without a token (no sign-in needed).
 */
export async function startOAuthFixture(toggles: Partial<FixtureToggles> = {}, cleanup?: (task: CleanupTask) => void): Promise<OAuthMcpServer> {
  const fixture = await startOAuthMcpServer({ host: '127.0.0.1', toggles })
  cleanup?.(() => fixture.stop())
  return fixture
}

/** The tool name of an MCP tool (`mcp__<server>__<tool>`; the ids of the specs need no sanitizing). */
export function mcpToolName(serverId: string, tool: string): string {
  return `mcp__${serverId}__${tool}`
}

// ---------- personal servers ----------

export interface HttpMcpServerInput {
  id: string
  name: string
  url: string
  /** Default `ask` (the server's default); `safe` runs the tools without an approval card. */
  policy?: ToolPolicy
  oauth?: { clientId?: string, clientSecret?: string, scopes?: string }
}

/** Deletes a personal MCP server (a server that is already gone is fine). */
export async function removeMcpServer(api: HarnessApi, id: string): Promise<void> {
  try {
    await api.client.mcp.remove({ params: { id } })
  }
  catch (error) {
    if ((error as { code?: unknown }).code !== 'not_found')
      throw error
  }
}

/** Adds a personal http MCP server through the API (`POST /api/mcp`), removed again through `cleanup` (registered first). */
export async function addHttpMcpServer(api: HarnessApi, cleanup: (task: CleanupTask) => void, input: HttpMcpServerInput): Promise<McpServer> {
  cleanup(api => removeMcpServer(api, input.id))
  return api.client.mcp.create({
    body: {
      id: input.id,
      name: input.name,
      transport: { type: 'http', url: input.url, ...(input.oauth === undefined ? {} : { oauth: input.oauth }) },
      ...(input.policy === undefined ? {} : { policy: input.policy }),
    },
  })
}

/** A personal or plugin MCP server of `GET /api/mcp` (null when it is not listed). */
export async function mcpServer(api: HarnessApi, id: string): Promise<McpServer | null> {
  return (await api.client.mcp.list()).items.find(item => item.id === id) ?? null
}

/** Waits until a server of `GET /api/mcp` has one of these statuses and returns it. */
export async function waitForMcpStatus(api: HarnessApi, id: string, status: McpStatus | readonly McpStatus[], timeout = 20_000): Promise<McpServer> {
  const wanted: readonly McpStatus[] = typeof status === 'string' ? [status] : status
  const found: { server: McpServer | null } = { server: null }
  await expect.poll(async () => {
    found.server = await mcpServer(api, id)
    return found.server !== null && wanted.includes(found.server.status)
  }, { timeout, message: `MCP server ${id} is ${wanted.join(' or ')}` }).toBe(true)
  return found.server!
}

/** The query of the fixture's redirect back to the app (`code`, `state`, `iss`; or `error`). */
export async function followAuthorization(authorizationUrl: string): Promise<Record<string, string>> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (response.status !== 302 || location === null)
    throw new Error(`The authorization page answered ${response.status} without a redirect (is approvePage on?).`)
  return Object.fromEntries(new URL(location, authorizationUrl).searchParams)
}

/**
 * Signs in to a personal server through the API, like the browser does: `POST /api/mcp/:id/oauth`, the fixture's
 * auto-approved `/authorize` (followed with `fetch`, never a browser), then `POST /api/mcp/oauth/callback` with the
 * redirect's `state`, `code` and `iss` (from the API context: its session cookie, when the server has a password). Waits
 * until the server is connected.
 */
export async function signInMcpServer(api: HarnessApi, serverId: string): Promise<McpAuthCallbackResult> {
  const start = await api.client.mcpAuth.start({ params: { id: serverId }, body: {} })
  if (start.authorizationUrl === null)
    throw new Error(`${serverId} needed no sign-in.`)
  const query = await followAuthorization(start.authorizationUrl)
  const result = await api.client.mcpAuth.callback({ body: { state: query.state!, code: query.code!, ...(query.iss ? { iss: query.iss } : {}) } })
  await waitForMcpStatus(api, serverId, 'connected')
  return result
}

/** A personal http server for the fixture, signed in through the API (or connected at once with `noAuth`). */
export async function addSignedInMcpServer(
  api: HarnessApi,
  cleanup: (task: CleanupTask) => void,
  fixture: OAuthMcpServer,
  input: Omit<HttpMcpServerInput, 'url'>,
): Promise<McpServer> {
  await addHttpMcpServer(api, cleanup, { ...input, url: fixture.url })
  const first = await waitForMcpStatus(api, input.id, ['needs-auth', 'connected'])
  if (first.status === 'needs-auth')
    await signInMcpServer(api, input.id)
  return waitForMcpStatus(api, input.id, 'connected')
}

// ---------- the MCP panel (Plugins -> core-mcp) ----------

/** A row of the MCP panel. */
export function mcpServerRow(page: Page, serverId: string): Locator {
  return byTestId(page.getByTestId(testIds.mcpPanel), testIds.mcpServerRow, { 'data-server-id': serverId })
}

/** Opens Plugins -> core-mcp and waits for the MCP panel. */
export async function openMcpPanel(page: Page): Promise<Locator> {
  await page.goto('/plugins/core-mcp')
  const panel = page.getByTestId(testIds.mcpPanel)
  await expect(panel).toBeVisible()
  return panel
}

// ---------- elicitation (docs/UI.md 7.35) ----------

/** The elicitation card of a page or message (`elicitation-card`), optionally by its data attributes. */
export function elicitationCard(scope: Page | Locator, attributes: DataAttributes = {}): Locator {
  return byTestId(scope, testIds.elicitationCard, attributes)
}

/** One field of an elicitation card by its name. */
export function elicitationField(card: Locator, name: string): Locator {
  return byTestId(card, testIds.elicitationField, { 'data-name': name })
}

/** The heading of a card: "{server} needs more information". */
export function elicitationHeading(server: string): string {
  return `${server} needs more information`
}

/** The result line of an answered request (`elicitation-result`, `data-action`). */
export function elicitationResultText(server: string, action: 'accept' | 'decline' | 'cancel'): string {
  if (action === 'accept')
    return `You answered ${server}'s request.`
  return action === 'decline' ? `You declined ${server}'s request.` : `You dismissed ${server}'s request.`
}

/**
 * Fills the fixture's basic form in a card: the name and the email as text, the count, the subscribe checkbox and a
 * color radio (the form has four options or fewer: radios).
 */
export async function fillBasicForm(card: Locator, values: { name: string, email: string, count: number, color: 'red' | 'green' | 'blue' }): Promise<void> {
  await elicitationField(card, 'name').getByRole('textbox').fill(values.name)
  await elicitationField(card, 'email').getByRole('textbox').fill(values.email)
  await elicitationField(card, 'count').getByRole('spinbutton').fill(String(values.count))
  await elicitationField(card, 'subscribe').getByRole('checkbox').click()
  await elicitationField(card, 'color').getByRole('radio', { name: values.color }).click()
}
