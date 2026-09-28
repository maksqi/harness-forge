import { describe, expect, it } from 'vitest'
import { providerSummary } from '~/utils/testing/fixtures'
import {
  configureLabel,
  formatModelCount,
  isBuiltinProvider,
  isLoopbackHost,
  isPlainHttpFromNetwork,
  providerSubtitle,
  sortProviders,
  statusMessage,
} from './providers'

describe('provider list rules', () => {
  it('orders builtins as in PROVIDERS.md, then plugin providers by name', () => {
    const items = [
      providerSummary({ id: 'together-ai', name: 'Together AI', pluginId: 'together-ai' }),
      providerSummary({ id: 'ollama', name: 'Ollama (local)', pluginId: 'core-providers' }),
      providerSummary({ id: 'mock', name: 'Mock (dev only)', pluginId: 'mock' }),
      providerSummary({ id: 'lmstudio', name: 'LM Studio', pluginId: 'lmstudio' }),
      providerSummary({ id: 'openai', name: 'OpenAI (ChatGPT)', pluginId: 'core-providers' }),
      providerSummary({ id: 'anthropic', name: 'Anthropic (Claude)', pluginId: 'core-providers' }),
    ]
    expect(sortProviders(items).map(provider => provider.id))
      .toEqual(['anthropic', 'openai', 'ollama', 'mock', 'lmstudio', 'together-ai'])
    expect(isBuiltinProvider({ pluginId: 'core-providers' })).toBe(true)
    expect(isBuiltinProvider({ pluginId: 'together-ai' })).toBe(false)
  })

  it('writes the row subtitle', () => {
    expect(providerSubtitle(providerSummary({ modelCount: 23 }))).toBe('23 models')
    expect(providerSubtitle(providerSummary({ modelCount: 1 }))).toBe('1 model')
    expect(providerSubtitle(providerSummary({ modelCount: 0 }))).toBe('')
    expect(providerSubtitle(providerSummary({ local: true, modelCount: 4 }))).toBe('Local — no key')
    expect(providerSubtitle(providerSummary({ pluginId: 'together-ai', modelCount: 12 }), 'Together AI'))
      .toBe('12 models · via Together AI')
    expect(providerSubtitle(providerSummary({ pluginId: 'together-ai', modelCount: 0 }))).toBe('via together-ai')
    expect(formatModelCount(0)).toBe('0 models')
  })

  it('labels the configure button and the error tooltip', () => {
    expect(configureLabel({ status: 'not_configured' })).toBe('Add key')
    expect(configureLabel({ status: 'env' })).toBe('Configure')
    const lastError = { code: 'auth_invalid' as const, message: 'invalid x-api-key', status: 401 }
    expect(statusMessage({ status: 'error', lastError })).toBe('invalid x-api-key')
    expect(statusMessage({ status: 'connected', lastError })).toBeUndefined()
  })
})

describe('plain-HTTP warning', () => {
  it('treats localhost, 127.0.0.0/8 and [::1] as loopback', () => {
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1'])
      expect(isLoopbackHost(host), host).toBe(true)
    for (const host of ['192.168.1.20', 'example.com', 'localhost.example.com', '10.0.0.1', '[::2]'])
      expect(isLoopbackHost(host), host).toBe(false)
  })

  it('warns only over http from a network host', () => {
    expect(isPlainHttpFromNetwork({ protocol: 'http:', hostname: '192.168.1.20' })).toBe(true)
    expect(isPlainHttpFromNetwork({ protocol: 'http:', hostname: 'localhost' })).toBe(false)
    expect(isPlainHttpFromNetwork({ protocol: 'https:', hostname: 'chat.example.com' })).toBe(false)
  })
})
