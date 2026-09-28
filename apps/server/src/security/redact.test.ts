// SEC-D2: the redactor behind every log line and error message. Secrets hide in URL query strings (with prefixed names
// such as `X-Amz-Signature`), in name / value pairs of free text and JSON excerpts, and under sensitive field names;
// ordinary text around them (token counts, messages that merely mention a password) stays readable. Share tokens
// (ADR-025) never reach a log: `redactText` masks `/share/<token>`, the access log masks the path segment (W5.7-T6).
import { SHARE_TOKEN_PATTERN } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createRedactor, REDACTED, redactSharePath } from './redact.ts'

describe('redactText', () => {
  const redactor = createRedactor()

  it.each([
    ['presigned URL', 'https://b.s3.amazonaws.com/p.zip?X-Amz-Credential=AKIAEXAMPLE0001&X-Amz-Signature=abcdef0123456789&X-Amz-Security-Token=FwoGZXIvYXdzEJr', ['AKIAEXAMPLE0001', 'abcdef0123456789', 'FwoGZXIvYXdzEJr']],
    ['OAuth query', 'https://oauth.example.com/token?client_secret=s3cr3tvalue123&refresh_token=rt_998877665544&code=abc', ['s3cr3tvalue123', 'rt_998877665544']],
    ['plain query', 'https://example.com/v1/models?key=AIzaSecretSecretSecretSecret&sig=0a1b2c3d4e', ['AIzaSecret', '0a1b2c3d4e']],
    ['JSON excerpt', 'upstream said {"error":{"message":"bad","api_key":"live_abcdef123456"}}', ['live_abcdef123456']],
    ['assignments', 'password=hunter2hunter2 token: tok_0123456789abcdef passphrase = "correcthorsebattery"', ['hunter2hunter2', 'tok_0123456789abcdef', 'correcthorsebattery']],
    ['header lines', 'x-api-key: 0123456789abcdef0123\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\nauthorization: Bearer abcdefghijklmnop', ['0123456789abcdef0123', 'dXNlcjpwYXNzd29yZA==', 'abcdefghijklmnop']],
    ['provider keys', 'keys sk-proj-abc123 gsk_0123456789abcdefghij hf_0123456789abcdefghij', ['sk-proj-abc123', 'gsk_0123456789abcdefghij', 'hf_0123456789abcdefghij']],
    ['session cookie', 'cookie: hf_session=v1.eyJpYXQiOjF9.c2lnbmF0dXJl; theme=dark', ['v1.eyJpYXQiOjF9.c2lnbmF0dXJl']],
  ])('masks secrets: %s', (_name, text, secrets) => {
    const out = redactor.redactText(text)
    for (const secret of secrets)
      expect(out, secret).not.toContain(secret)
    expect(out).toContain(REDACTED)
  })

  it.each([
    'usage {"inputTokens": 12345, "outputTokens": 12, "maxTokens": 4096, "token_type": "bearer"}',
    'The password is set by HF_PASSWORD; change or remove it in the server environment.',
    'Invalid value for "token": must be a string',
    'token: none',
    'secretsRequested: ["API key (Provider x)"]',
    'https://example.com/?page=2&author=me&monkey=1&sv=2020',
    'The request header "x-api-key" has an invalid value.',
  ])('keeps ordinary text: %s', (text) => {
    expect(redactor.redactText(text)).toBe(text)
  })

  it('masks registered secrets anywhere, longest first, and ignores very short ones', () => {
    const own = createRedactor()
    own.addSecret('shortsecret')
    own.addSecret('shortsecret-and-longer')
    own.addSecret('ab')
    expect(own.redactText('a shortsecret-and-longer b shortsecret c about')).toBe(`a ${REDACTED} b ${REDACTED} c about`)
  })
})

describe('redact (structured)', () => {
  it('masks values under sensitive names, keeps numbers and booleans', () => {
    const redactor = createRedactor()
    const out = redactor.redact({
      headers: new Headers({ 'x-api-key': 'k-1', 'proxy-authorization': 'Basic abc', 'content-type': 'application/json' }),
      clientSecret: 'x',
      passphrase: 'pp',
      credentials: { apiKey: 'c' },
      signature: 'sig',
      privateKey: 'k',
      usage: { inputTokens: 12 },
      authenticated: true,
      url: new URL('https://example.com/?token=abcdef123456'),
    })
    expect(out).toEqual({
      headers: { 'x-api-key': REDACTED, 'proxy-authorization': REDACTED, 'content-type': 'application/json' },
      clientSecret: REDACTED,
      passphrase: REDACTED,
      credentials: { apiKey: REDACTED },
      signature: REDACTED,
      privateKey: REDACTED,
      usage: { inputTokens: 12 },
      authenticated: true,
      url: `https://example.com/?token=${REDACTED}`,
    })
  })

  it('errors keep name, message, code and status, redacted; other properties (request bodies, headers) are dropped', () => {
    const redactor = createRedactor()
    redactor.addSecret('registered-secret-value')
    const error = Object.assign(new Error('call failed with registered-secret-value'), {
      status: 401,
      requestBodyValues: { apiKey: 'body-secret' },
      responseHeaders: { 'set-cookie': 'session=abc' },
    })
    const out = redactor.redact({ err: error }) as { err: Record<string, unknown> }
    expect(out.err).toMatchObject({ name: 'Error', message: `call failed with ${REDACTED}`, status: 401 })
    expect(JSON.stringify(out)).not.toContain('body-secret')
    expect(JSON.stringify(out)).not.toContain('session=abc')
  })
})

describe('share tokens (ADR-025)', () => {
  /** A well-formed share token: the 16-character share id suffix + 22 base64url characters. */
  const TOKEN = 'AbCdEfGh12345678Zz09_-aBcDeFgHiJkLmNoP'
  const MAC = TOKEN.slice(16)
  const redactor = createRedactor()

  it('the sample is a token', () => {
    expect(TOKEN).toMatch(SHARE_TOKEN_PATTERN)
  })

  it.each([
    ['a share page URL', `open https://harness.example.com/share/${TOKEN} to read it`],
    ['a public API path', `Unknown API route: GET /api/share/${TOKEN}/nope`],
    ['a share file path', `/api/share/${TOKEN}/files/file_0000000000000001`],
    ['an upper-case segment', `/Share/${TOKEN}`],
    ['encoded slashes', `GET /api/share%2F${TOKEN} and /api%2Fshare%2f${TOKEN}`],
    ['a link with a trailing character', `(see /share/${TOKEN})`],
    ['a token followed by more characters', `/share/${TOKEN}extra`],
    ['a JSON excerpt', JSON.stringify({ url: `/share/${TOKEN}`, referer: `https://h.example/share/${TOKEN}#x` })],
  ])('redactText masks %s', (_name, text) => {
    const out = redactor.redactText(text)
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(MAC)
    expect(out).toContain(REDACTED)
  })

  it('keeps share ids, other paths and short segments', () => {
    for (const text of ['/api/shares/shr_AbCdEfGh12345678', '/api/shares?chatId=0199a8f0-0000-7000-8000-000000000001', '/share/short', `/shared/${TOKEN}`, `/sharepoint/${TOKEN}`])
      expect(redactor.redactText(text), text).toBe(text)
  })

  it('structured values: every string field is masked', () => {
    const out = JSON.stringify(redactor.redact({ path: `/share/${TOKEN}`, nested: { url: new URL(`https://h.example/share/${TOKEN}`) } }))
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(MAC)
  })

  it.each([
    [`/api/share/${TOKEN}`, `/api/share/${REDACTED}`],
    [`/api/share/${TOKEN}/files/file_0000000000000001`, `/api/share/${REDACTED}/files/file_0000000000000001`],
    [`/share/${TOKEN}`, `/share/${REDACTED}`],
    [`/share/${TOKEN}/`, `/share/${REDACTED}/`],
    ['/share/abc', `/share/${REDACTED}`],
    [`/share/${TOKEN}x.y`, `/share/${REDACTED}`],
    [`/share/${TOKEN.slice(0, 30)}`, `/share/${REDACTED}`],
    [`//share//${TOKEN}`, `//share//${REDACTED}`],
    [`/SHARE/${TOKEN}`, `/SHARE/${REDACTED}`],
    [`/api/share%2F${TOKEN}`, `/api/share%2F${REDACTED}`],
    ['/api/shares/shr_AbCdEfGh12345678', '/api/shares/shr_AbCdEfGh12345678'],
    ['/api/shares', '/api/shares'],
    ['/share/', '/share/'],
    ['/api/chats/0199a8f0-0000-7000-8000-000000000001', '/api/chats/0199a8f0-0000-7000-8000-000000000001'],
  ])('redactSharePath(%s) -> %s', (path, expected) => {
    expect(redactSharePath(path)).toBe(expected)
  })
})
