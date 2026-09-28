import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from './logger.ts'
import { createRedactor, REDACTED } from './security/redact.ts'

describe('logger', () => {
  it('writes structured records with bindings, filtered by level', () => {
    const { logger, records } = createMemoryLogger({ level: 'info' })
    const child = logger.child({ reqId: 'req-1', pluginId: 'core-tools' })
    child.debug('hidden')
    child.info('hello', { durationMs: 12 })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ level: 'info', msg: 'hello', reqId: 'req-1', pluginId: 'core-tools', durationMs: 12 })
    expect(Number.isNaN(Date.parse(records[0]?.time ?? ''))).toBe(false)
    expect(logger.isLevelEnabled('debug')).toBe(false)
  })

  it('redacts sensitive fields, token-like strings and registered secrets', () => {
    const redactor = createRedactor()
    const { logger, text } = createMemoryLogger({ redactor })
    redactor.addSecret('my-very-private-value')
    logger.warn('call failed with key sk-proj-abc123 and my-very-private-value', {
      headers: { 'authorization': 'Bearer abcdefghijklmnop', 'x-api-key': 'k-123', 'content-type': 'application/json' },
      cookie: 'hf_session=v1.abc.def',
      apiKey: 'plain',
      usage: { inputTokens: 12, outputTokens: 3 },
      url: 'https://example.com/v1/models?key=AIzaSecretSecretSecretSecret&page=2',
      err: new Error('upstream said Bearer zyxwvutsrqponmlk'),
    })
    const output = text()
    for (const secret of ['sk-proj-abc123', 'my-very-private-value', 'abcdefghijklmnop', 'k-123', 'v1.abc.def', 'plain', 'AIzaSecret', 'zyxwvutsrqponmlk'])
      expect(output).not.toContain(secret)
    expect(output).toContain(REDACTED)
    expect(output).toContain('"inputTokens":12')
    expect(output).toContain('page=2')
    expect(output).toContain('application/json')
  })
})

describe('redactor', () => {
  it('handles cycles, errors and binary data', () => {
    const redactor = createRedactor()
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    const error = Object.assign(new Error('boom sk-12345'), { code: 'E_TEST' })
    const result = redactor.redact({ cyclic, error, bytes: new Uint8Array(4) }) as Record<string, any>
    expect(result.cyclic.self).toBe('[circular]')
    expect(result.error).toMatchObject({ name: 'Error', message: `boom ${REDACTED}`, code: 'E_TEST' })
    expect(result.bytes).toBe('[binary 4 bytes]')
  })

  it('ignores very short secrets', () => {
    const redactor = createRedactor()
    redactor.addSecret('ab')
    expect(redactor.redactText('about')).toBe('about')
  })
})
