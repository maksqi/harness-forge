// SEC-D2: the redactor behind every log line and error message. Secrets hide in URL query strings (with prefixed names
// such as `X-Amz-Signature`), in name / value pairs of free text and JSON excerpts, and under sensitive field names;
// ordinary text around them (token counts, messages that merely mention a password) stays readable.
import { describe, expect, it } from 'vitest'
import { createRedactor, REDACTED } from './redact.ts'

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
