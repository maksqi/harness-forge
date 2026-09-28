import { describe, expect, it } from 'vitest'
import { applySettings, resolveDeclTransport, settingText } from './templating.ts'

describe('settingText', () => {
  it.each([
    ['text', 'text'],
    [42, '42'],
    [false, 'false'],
    [['a', '', 'b'], 'a,b'],
    [null, ''],
    [undefined, ''],
    [{ nested: true }, ''],
  ])('%j -> %j', (value, expected) => {
    expect(settingText(value)).toBe(expected)
  })
})

describe('applySettings', () => {
  it('replaces every placeholder and reports empty ones once', () => {
    expect(applySettings('{{settings.a}}-{{settings.b}}-{{settings.a}}-{{settings.c}}', { a: 'x', b: '', c: 3 }))
      .toEqual({ value: 'x--x-3', missing: ['b'] })
    expect(applySettings('no placeholders', {})).toEqual({ value: 'no placeholders', missing: [] })
  })
})

describe('resolveDeclTransport', () => {
  it('resolves http URLs and headers; an empty setting omits its header', () => {
    const transport = resolveDeclTransport('acme', {
      type: 'http',
      url: 'https://mcp.example.com/{{settings.workspace}}/mcp',
      headers: { 'Authorization': 'Bearer {{settings.token}}', 'X-Team': '{{settings.team}}', 'X-Fixed': 'yes' },
    }, { workspace: 'w1', token: 'secret-token-value', team: '' })
    expect(transport).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/w1/mcp',
      headers: { 'Authorization': 'Bearer secret-token-value', 'X-Fixed': 'yes' },
    })
  })

  it('fails naming the setting when the URL needs an empty one', () => {
    expect(() => resolveDeclTransport('acme', { type: 'sse', url: 'https://mcp.example.com/{{settings.workspace}}' }, {}))
      .toThrow(/"acme" needs the setting "workspace" \(URL\)/)
  })

  it('rejects a URL or a header value made invalid by a setting', () => {
    expect(() => resolveDeclTransport('acme', { type: 'http', url: 'https://mcp.example.com/{{settings.path}}' }, { path: 'a b' }))
      .toThrow(/not an absolute http/)
    expect(() => resolveDeclTransport('acme', { type: 'http', url: 'https://mcp.example.com/', headers: { 'X-Token': '{{settings.token}}' } }, { token: 'a\r\nInjected: 1' }))
      .toThrow(/not a valid header value/)
  })

  it('resolves stdio args and env; args need their settings, env entries are omitted', () => {
    const transport = resolveDeclTransport('tool', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server', '--root={{settings.root}}', ''],
      env: { API_KEY: '{{settings.key}}', EMPTY: '{{settings.none}}', LITERAL: '' },
    }, { root: '/srv', key: 'k-123456789' })
    expect(transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server', '--root=/srv', ''],
      env: { API_KEY: 'k-123456789', LITERAL: '' },
    })
    expect(() => resolveDeclTransport('tool', { type: 'stdio', command: 'npx', args: ['--root={{settings.root}}'] }, {}))
      .toThrow(/needs the setting "root" \(argument 1\)/)
  })
})
