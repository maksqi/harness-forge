// Test helpers of the MCP OAuth tests (imported by `*.test.ts` only; W14.1): the browser's part of a sign-in against the
// OAuth MCP fixture (`__fixtures__/oauth-mcp-server.mjs`, loopback only): follow the authorization URL to its redirect
// and read `code`, `state` and `iss` from it; one whole sign-in through `deps.mcpAuth`.
import type { McpAuthCallbackResult, McpAuthTarget } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { TEST_ORIGIN } from '../../testing/create-test-app.ts'
import { MCP_OAUTH_CALLBACK_PATH } from './index.ts'

/** The redirect URI of a sign-in started from the test app's origin. */
export const TEST_REDIRECT_URI = `${TEST_ORIGIN}${MCP_OAUTH_CALLBACK_PATH}`

export interface AuthorizationRedirect {
  readonly code: string
  readonly state: string
  readonly iss: string | null
  /** The full redirect URL (`<redirect_uri>?code&state&iss`). */
  readonly location: URL
}

/** Opens the authorization URL like the browser (the fixture auto-approves with a 302) and reads the redirect. */
export async function followAuthorization(authorizationUrl: string): Promise<AuthorizationRedirect> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' })
  await response.body?.cancel().catch(() => {})
  const header = response.headers.get('location')
  if (response.status !== 302 || header === null)
    throw new Error(`The authorization endpoint answered ${response.status} without a redirect.`)
  const location = new URL(header)
  const code = location.searchParams.get('code')
  const state = location.searchParams.get('state')
  if (code === null || state === null)
    throw new Error(`The redirect has no code: ${location.searchParams.get('error') ?? 'unknown'}`)
  return { code, state, iss: location.searchParams.get('iss'), location }
}

/** A whole sign-in through the service: start, the browser's redirect, the callback. */
export async function signIn(t: TestApp, target: McpAuthTarget, returnTo: string | null = null): Promise<{ result: McpAuthCallbackResult, redirect: AuthorizationRedirect, authorizationUrl: string }> {
  const start = await t.deps.mcpAuth.start(target, { origin: TEST_ORIGIN, returnTo })
  if (start.authorizationUrl === null)
    throw new Error('The sign-in needed no authorization.')
  const redirect = await followAuthorization(start.authorizationUrl)
  const result = await t.deps.mcpAuth.complete({ state: redirect.state, code: redirect.code, ...(redirect.iss === null ? {} : { iss: redirect.iss }) }, { origin: TEST_ORIGIN })
  return { result, redirect, authorizationUrl: start.authorizationUrl }
}
