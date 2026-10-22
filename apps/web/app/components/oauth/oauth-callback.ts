// Pure rules of the sign-in callback page `/oauth/callback` (Phase 14, ADR-059; docs/UI.md 6, 8.14, 11.10): the query
// the authorization server sent (`code`, `state`, `iss` or `error`, `error_description`) as the body of `POST
// /mcp/oauth/callback`, the error text of the card and the fallback page. The page never renders the code or the state.
// Signatures from C54 (P14-0b, frozen from Gate P14-0b); W14.7 implements the bodies (it may add helpers).
import type { HarnessError, McpAuthCallbackBody, McpAuthCallbackResult, McpAuthTarget } from '@harness-forge/shared'
import type { LocationQuery } from 'vue-router'
import { mcpAuthTargetSchema } from '@harness-forge/shared'

/** The text of a used, expired or unknown sign-in link (409 `stale`). */
export const CALLBACK_STALE_TEXT = 'This sign-in link was already used or expired.'
/** The text of the page opened without a `state`. */
export const CALLBACK_NO_STATE_TEXT = 'This page finishes a sign-in to an MCP server. Start it from the MCP servers list.'
/** The provider's or the server's text on the card is cut to this many characters (plain text). */
export const CALLBACK_ERROR_MAX_CHARS = 300
/** + W14.7: the card's `data-code` of a page opened without a `state` (nothing was posted). */
export const CALLBACK_NO_STATE_CODE = 'validation_error'
/** + W14.7: the card's text when the answer carries no message. */
export const CALLBACK_GENERIC_TEXT = 'The sign-in did not finish. Try again.'

/** Lengths of the body fields (`mcpAuthCallbackBodySchema`): longer values are cut so the server sees what fits. */
const ERROR_MAX_CHARS = 256
const ERROR_DESCRIPTION_MAX_CHARS = 1000

/** The first string of a query value (`?a=1&a=2` → '1'), else null; empty strings count as missing. */
function first(value: LocationQuery[string] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw !== '' ? raw : null
}

/** Control characters (C0, DEL, C1) become spaces: the server refuses them in an error description. */
function withoutControlChars(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    out += code < 0x20 || (code >= 0x7F && code <= 0x9F) ? ' ' : char
  }
  return out
}

/**
 * The callback body of the query (read once); null without a `state`. An `error` answer wins over a `code` (an
 * authorization server never sends both; the code of such a mixed answer is not exchanged); a query with a state but
 * neither is posted as the error `invalid_request`, so the server ends the pending sign-in. W14.7.
 */
export function readCallbackQuery(query: LocationQuery): McpAuthCallbackBody | null {
  const state = first(query.state)
  if (state === null)
    return null
  const iss = first(query.iss)
  const error = first(query.error)
  const code = first(query.code)
  if (error === null && code !== null)
    return { state, code, ...(iss === null ? {} : { iss }) }
  const description = first(query.error_description)
  const body: McpAuthCallbackBody = { state, error: (error ?? 'invalid_request').slice(0, ERROR_MAX_CHARS) }
  if (iss !== null)
    body.iss = iss
  if (description !== null)
    body.errorDescription = withoutControlChars(description).slice(0, ERROR_DESCRIPTION_MAX_CHARS)
  return body
}

/** The card's text of a failed callback: at most 300 characters; 409 → `CALLBACK_STALE_TEXT`. W14.7. */
export function callbackErrorText(error: Pick<HarnessError, 'code' | 'message' | 'details'>): string {
  if (error.code === 'conflict')
    return CALLBACK_STALE_TEXT
  const text = withoutControlChars(error.message ?? '').replace(/\s+/g, ' ').trim()
  if (text === '')
    return CALLBACK_GENERIC_TEXT
  return text.length > CALLBACK_ERROR_MAX_CHARS ? `${text.slice(0, CALLBACK_ERROR_MAX_CHARS - 1)}…` : text
}

/** Where a sign-in without `returnTo` goes: `/plugins/core-mcp` (global, also unknown) or `/settings/projects`. */
export function callbackFallback(target: McpAuthCallbackResult['target'] | null): string {
  return target?.kind === 'project' ? '/settings/projects' : '/plugins/core-mcp'
}

/**
 * + W14.7: the server a failed callback was for, from the answer's details (`details.target`, or `details.serverId`
 * with `details.projectId` for a project server); null when the answer names none (Try again is offered only then).
 */
export function callbackRetryTarget(error: Pick<HarnessError, 'details'>): McpAuthTarget | null {
  const details = error.details
  if (typeof details !== 'object' || details === null)
    return null
  const record = details as Record<string, unknown>
  const nested = mcpAuthTargetSchema.safeParse(record.target)
  if (nested.success)
    return nested.data
  const flat = mcpAuthTargetSchema.safeParse(typeof record.projectId === 'string'
    ? { kind: 'project', projectId: record.projectId, serverId: record.serverId }
    : { kind: 'global', serverId: record.serverId })
  return flat.success ? flat.data : null
}
