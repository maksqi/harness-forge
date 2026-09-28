import type { CredentialField, ProviderSummary } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { providerSummary } from '~/utils/testing/fixtures'
import {
  changedValues,
  credentialFieldViews,
  draftErrors,
  envNotice,
  fieldLinks,
  formatEnvVars,
  hasStoredSecret,
  isOverridden,
  safeLink,
  splitFieldViews,
  testSuccessText,
  valuesSignature,
} from './key-dialog'

const apiKey: CredentialField = { key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: 'ANTHROPIC_API_KEY' }
const baseURL: CredentialField = { key: 'baseURL', label: 'Base URL', type: 'url', default: 'https://api.anthropic.com/v1', advanced: true }

function anthropic(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return providerSummary({
    credentialFields: [apiKey, baseURL],
    credentials: {
      apiKey: { set: false, hint: null, source: null },
      baseURL: { set: false, hint: null, source: null },
    },
    keyUrl: 'https://platform.claude.com/settings/keys',
    ...overrides,
  })
}

describe('credential field views', () => {
  it('never loads a stored secret: empty start value, masked hint as placeholder', () => {
    const views = credentialFieldViews(anthropic({
      credentials: {
        apiKey: { set: true, hint: 'sk-ant-…9fQ2', source: 'stored' },
        baseURL: { set: false, hint: null, source: null },
      },
    }))
    expect(views[0]).toMatchObject({ key: 'apiKey', secret: true, initial: '', placeholder: 'sk-ant-…9fQ2 · stored', source: 'stored' })
    expect(views[1]).toMatchObject({ key: 'baseURL', secret: false, advanced: true, initial: '', placeholder: 'https://api.anthropic.com/v1' })
    expect(hasStoredSecret(views)).toBe(true)
  })

  it('describes unset, env and optional fields', () => {
    const [unset] = credentialFieldViews(anthropic())
    expect(unset!.placeholder).toBe('Paste your key…')
    const [env] = credentialFieldViews(anthropic({
      credentials: { apiKey: { set: true, hint: 'sk-…abcd', source: 'env' } },
    }))
    expect(env!.placeholder).toBe('sk-…abcd · from env')
    expect(hasStoredSecret([env!])).toBe(false)
    const [optional] = credentialFieldViews(providerSummary({
      credentialFields: [{ key: 'apiKey', label: 'API key', type: 'secret', advanced: true }],
    }))
    expect(optional!.placeholder).toBe('Optional')
  })

  it('starts non-secret fields with their stored override', () => {
    const views = credentialFieldViews(anthropic({
      credentials: { baseURL: { set: true, hint: null, source: 'stored', value: 'https://proxy.example.com/v1' } },
    }))
    expect(views[1]!.initial).toBe('https://proxy.example.com/v1')
    expect(isOverridden(views[1]!)).toBe(true)
    expect(isOverridden(views[0]!)).toBe(false)
  })

  it('starts select fields with the stored choice, else the default', () => {
    const region: CredentialField = { key: 'region', label: 'Region', type: 'select', options: ['us', 'eu'], default: 'eu' }
    expect(credentialFieldViews(providerSummary({ credentialFields: [region] }))[0]!.initial).toBe('eu')
    expect(credentialFieldViews(providerSummary({
      credentialFields: [region],
      credentials: { region: { set: true, hint: null, source: 'stored', value: 'us' } },
    }))[0]!.initial).toBe('us')
  })

  it('splits main and advanced fields', () => {
    const { main, advanced } = splitFieldViews(credentialFieldViews(anthropic()))
    expect(main.map(view => view.key)).toEqual(['apiKey'])
    expect(advanced.map(view => view.key)).toEqual(['baseURL'])
  })
})

describe('field links', () => {
  it('puts the provider key page on the primary secret field', () => {
    expect(fieldLinks(anthropic())).toEqual({
      apiKey: { href: 'https://platform.claude.com/settings/keys', label: 'Get a key', getKey: true },
    })
  })

  it('uses "Download" for a keyless local provider and help links elsewhere', () => {
    const ollama = providerSummary({
      id: 'ollama',
      local: true,
      keyUrl: 'https://ollama.com/download',
      credentialFields: [
        { key: 'baseURL', label: 'Base URL', type: 'url', required: true, default: 'http://localhost:11434/v1' },
        { key: 'apiKey', label: 'API key', type: 'secret', advanced: true, helpUrl: 'https://example.com/help' },
      ],
    })
    expect(fieldLinks(ollama)).toEqual({
      baseURL: { href: 'https://ollama.com/download', label: 'Download', getKey: false },
      apiKey: { href: 'https://example.com/help', label: 'Learn more', getKey: false },
    })
  })

  it('never renders non-http links', () => {
    expect(fieldLinks(anthropic({ keyUrl: 'javascript:alert(1)' }))).toEqual({})
    expect(safeLink('https://x.test/keys')).toBe('https://x.test/keys')
    expect(safeLink('//evil.test')).toBeNull()
    expect(safeLink(null)).toBeNull()
  })
})

describe('env notice', () => {
  it('names the variables that can provide the value', () => {
    expect(formatEnvVars(['ANTHROPIC_API_KEY'])).toBe('ANTHROPIC_API_KEY')
    expect(formatEnvVars(['A', 'B'])).toBe('A or B')
    expect(formatEnvVars(['A', 'B', 'C'])).toBe('A, B or C')
    expect(envNotice({ envVars: ['ANTHROPIC_API_KEY'], secret: true }))
      .toBe('Using ANTHROPIC_API_KEY from the server environment. A key saved here takes priority.')
    expect(envNotice({ envVars: [], secret: false }))
      .toBe('Using a variable from the server environment. A value saved here takes priority.')
  })
})

describe('draft values', () => {
  const views = credentialFieldViews(anthropic({
    credentials: { baseURL: { set: true, hint: null, source: 'stored', value: 'https://proxy.example.com/v1' } },
  }))

  it('sends typed secrets and changed non-secret values only', () => {
    expect(changedValues(views, { apiKey: '', baseURL: 'https://proxy.example.com/v1' })).toEqual({})
    expect(changedValues(views, { apiKey: '  sk-new  ', baseURL: 'https://proxy.example.com/v1' })).toEqual({ apiKey: 'sk-new' })
    expect(changedValues(views, { apiKey: '', baseURL: '' })).toEqual({ baseURL: '' })
    expect(changedValues(views, { apiKey: '', baseURL: 'https://other.example.com' })).toEqual({ baseURL: 'https://other.example.com' })
  })

  it('compares with the values captured when the dialog opened', () => {
    // An override stored elsewhere while the dialog is open is not an edit here.
    expect(changedValues(views, { apiKey: '', baseURL: '' }, { apiKey: '', baseURL: '' })).toEqual({})
    // A field without a draft yet keeps its starting value.
    expect(changedValues(views, {})).toEqual({})
  })

  it('rejects base URLs that are not http(s)', () => {
    expect(draftErrors(views, { apiKey: '', baseURL: 'ftp://example.com' })).toEqual({
      baseURL: 'Enter a URL that starts with http:// or https://.',
    })
    expect(draftErrors(views, { apiKey: 'sk', baseURL: '' })).toEqual({})
    expect(draftErrors(views, { apiKey: 'x'.repeat(4097), baseURL: '' })).toHaveProperty('apiKey')
  })

  it('identifies a set of values regardless of key order', () => {
    expect(valuesSignature({ a: '1', b: '2' })).toBe(valuesSignature({ b: '2', a: '1' }))
    expect(valuesSignature({ a: '1' })).not.toBe(valuesSignature({ a: '2' }))
  })
})

describe('test result', () => {
  it('summarizes a passing test', () => {
    expect(testSuccessText({ latencyMs: 379.6, modelCount: 23 })).toBe('Connected · 23 models · 380 ms')
    expect(testSuccessText({ latencyMs: 12 })).toBe('Connected · 12 ms')
    expect(testSuccessText({ latencyMs: 5, modelCount: 1 })).toBe('Connected · 1 model · 5 ms')
  })
})
