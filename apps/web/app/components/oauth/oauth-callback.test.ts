// The pure rules of the sign-in callback page (Phase 14, ADR-059; docs/UI.md 8.14, 11.10; W14.7-T5): the body read from
// the query, the card's text (plain, at most 300 characters; 409 = a used or expired link), the fallback page and the
// server of a failed answer (Try again).
import { HarnessError, mcpAuthCallbackBodySchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { projectId } from '~/utils/testing/fixtures'
import {
  CALLBACK_ERROR_MAX_CHARS,
  CALLBACK_GENERIC_TEXT,
  CALLBACK_STALE_TEXT,
  callbackErrorText,
  callbackFallback,
  callbackRetryTarget,
  readCallbackQuery,
} from './oauth-callback'

const STATE = 'sampleState0000000000001'

describe('readCallbackQuery', () => {
  it('reads a successful redirect: state, code and iss', () => {
    const body = readCallbackQuery({ code: 'sample-code', state: STATE, iss: 'https://auth.example.com' })
    expect(body).toEqual({ state: STATE, code: 'sample-code', iss: 'https://auth.example.com' })
    expect(mcpAuthCallbackBodySchema.safeParse(body).success).toBe(true)
    expect(readCallbackQuery({ code: 'sample-code', state: STATE })).toEqual({ state: STATE, code: 'sample-code' })
  })

  it('reads an error redirect; the description loses control characters and is capped', () => {
    const body = readCallbackQuery({ error: 'access_denied', error_description: 'The user\ndenied\u0007 the request.', state: STATE })
    expect(body).toEqual({ state: STATE, error: 'access_denied', errorDescription: 'The user denied  the request.' })
    expect(mcpAuthCallbackBodySchema.safeParse(body).success).toBe(true)
    const long = readCallbackQuery({ error: 'x'.repeat(300), error_description: 'y'.repeat(1200), state: STATE })!
    expect(long.error).toHaveLength(256)
    expect(long.errorDescription).toHaveLength(1000)
  })

  it('an error wins over a code; a state without either ends the sign-in as invalid_request', () => {
    expect(readCallbackQuery({ code: 'sample-code', error: 'server_error', state: STATE })).toEqual({ state: STATE, error: 'server_error' })
    expect(readCallbackQuery({ state: STATE })).toEqual({ state: STATE, error: 'invalid_request' })
  })

  it('uses the first value of a repeated key and needs a state', () => {
    expect(readCallbackQuery({ code: ['first', 'second'], state: [STATE, 'other'] })).toEqual({ state: STATE, code: 'first' })
    expect(readCallbackQuery({ code: 'sample-code' })).toBeNull()
    expect(readCallbackQuery({ code: 'sample-code', state: '' })).toBeNull()
    expect(readCallbackQuery({ code: 'sample-code', state: [null] })).toBeNull()
    expect(readCallbackQuery({})).toBeNull()
  })
})

describe('callbackErrorText', () => {
  it('a 409 reads as a used or expired link', () => {
    expect(callbackErrorText(new HarnessError({ code: 'conflict', message: 'Unknown state.', details: { reason: 'stale' } }))).toBe(CALLBACK_STALE_TEXT)
    expect(CALLBACK_STALE_TEXT).toBe('This sign-in link was already used or expired.')
  })

  it('keeps the server\'s text as one plain line of at most 300 characters', () => {
    expect(callbackErrorText(new HarnessError({ code: 'auth_invalid', message: 'Linear answered: access_denied (The user denied the request.)' })))
      .toBe('Linear answered: access_denied (The user denied the request.)')
    expect(callbackErrorText({ code: 'auth_invalid', message: 'line one\n\nline <b>two</b>', details: undefined })).toBe('line one line <b>two</b>')
    const long = callbackErrorText({ code: 'auth_invalid', message: 'z'.repeat(500), details: undefined })
    expect(long).toHaveLength(CALLBACK_ERROR_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
    expect(callbackErrorText({ code: 'internal_error', message: '  ', details: undefined })).toBe(CALLBACK_GENERIC_TEXT)
  })
})

describe('callbackFallback and callbackRetryTarget', () => {
  it('falls back to the MCP list of the target', () => {
    expect(callbackFallback({ kind: 'global', serverId: 'linear' })).toBe('/plugins/core-mcp')
    expect(callbackFallback({ kind: 'project', projectId: projectId(1), serverId: 'docs' })).toBe('/settings/projects')
    expect(callbackFallback(null)).toBe('/plugins/core-mcp')
  })

  it('reads the server of a failed answer from its details', () => {
    expect(callbackRetryTarget({ details: { serverId: 'linear' } })).toEqual({ kind: 'global', serverId: 'linear' })
    expect(callbackRetryTarget({ details: { serverId: 'docs', projectId: projectId(1) } })).toEqual({ kind: 'project', projectId: projectId(1), serverId: 'docs' })
    expect(callbackRetryTarget({ details: { target: { kind: 'global', serverId: 'linear' }, reason: 'x' } })).toEqual({ kind: 'global', serverId: 'linear' })
    expect(callbackRetryTarget({ details: { reason: 'stale' } })).toBeNull()
    expect(callbackRetryTarget({ details: { serverId: 'Not An Id!' } })).toBeNull()
    expect(callbackRetryTarget({ details: undefined })).toBeNull()
  })
})
