// Pure rules of the sign-in callback page `/oauth/callback` (Phase 14, ADR-059; docs/UI.md 6, 8.14, 11.10): the query
// the authorization server sent (`code`, `state`, `iss` or `error`, `error_description`) as the body of `POST
// /mcp/oauth/callback`, the error text of the card and the fallback page. The page never renders the code or the state.
// Signatures from C54 (P14-0b, frozen from Gate P14-0b); W14.7 implements the bodies (it may add helpers).
import type { HarnessError, McpAuthCallbackBody, McpAuthCallbackResult } from '@harness-forge/shared'
import type { LocationQuery } from 'vue-router'

/** The text of a used, expired or unknown sign-in link (409 `stale`). */
export const CALLBACK_STALE_TEXT = 'This sign-in link was already used or expired.'
/** The text of the page opened without a `state`. */
export const CALLBACK_NO_STATE_TEXT = 'This page finishes a sign-in to an MCP server. Start it from the MCP servers list.'
/** The provider's or the server's text on the card is cut to this many characters (plain text). */
export const CALLBACK_ERROR_MAX_CHARS = 300

/** The callback body of the query (read once); null without a `state`. W14.7. */
export function readCallbackQuery(_query: LocationQuery): McpAuthCallbackBody | null {
  return null
}

/** The card's text of a failed callback: at most 300 characters; 409 → `CALLBACK_STALE_TEXT`. W14.7. */
export function callbackErrorText(error: Pick<HarnessError, 'code' | 'message' | 'details'>): string {
  return error.message.slice(0, CALLBACK_ERROR_MAX_CHARS)
}

/** Where a sign-in without `returnTo` goes: `/plugins/core-mcp` (global, also unknown) or `/settings/projects`. */
export function callbackFallback(target: McpAuthCallbackResult['target'] | null): string {
  return target?.kind === 'project' ? '/settings/projects' : '/plugins/core-mcp'
}
