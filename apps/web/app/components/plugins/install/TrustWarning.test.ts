import type { PluginInspection } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { pluginDetail } from '~/utils/testing/fixtures'
import { TRUST_WARNING_TEXT } from './install'
import TrustWarning from './TrustWarning.vue'

const HASH = 'b'.repeat(64)

function inspection(overrides: Partial<PluginInspection> = {}): PluginInspection {
  return {
    manifest: {
      manifestVersion: 1,
      id: 'mcp-echo',
      name: 'MCP echo',
      version: '1.0.0',
      engines: { harness: '^1.0.0' },
      permissions: ['process', 'network'],
      contributes: { mcpServers: [{ id: 'mcp-echo', name: 'Echo', transport: { type: 'stdio', command: 'npx', args: ['-y', 'echo-server'] } }] },
    },
    kind: 'declarative',
    source: 'zip',
    sha256: HASH,
    contributions: { providers: [], models: 0, tools: [], mcpServers: ['mcp-echo'], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] },
    networkHosts: [],
    secretsRequested: [],
    permissions: ['process', 'network'],
    requiresTrust: true,
    compatible: true,
    existing: null,
    files: { count: 1, bytes: 300 },
    warnings: [],
    ...overrides,
  }
}

function render(props: Record<string, unknown>) {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(TrustWarning, props) }) })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('trustWarning', () => {
  it('shows the exact warning, the permissions, the programs and the sha256 of an inspection', () => {
    const wrapper = render({ inspection: inspection() })
    const root = wrapper.get(`[data-testid="${testIds.trustWarning}"]`)
    expect(root.attributes('role')).toBe('alert')
    expect(root.text()).toContain(TRUST_WARNING_TEXT)
    expect(TRUST_WARNING_TEXT).toBe('Runs code on your server with harness-forge\'s permissions. It can read API keys and conversations and make network requests. Only install plugins from sources you trust.')
    expect(root.findAll('[data-value]').map(item => item.text())).toEqual(['Starts programs', 'Connects to the network'])
    expect(root.text()).toContain('npx -y echo-server')
    expect(root.get('[data-slot="trust-sha256"]').text()).toBe(HASH)
    wrapper.unmount()
  })

  it('uses trust.hash and the manifest permissions of an installed plugin', () => {
    const detail = pluginDetail({ trust: { required: true, trusted: false, hash: HASH, trustedHash: 'a'.repeat(64) } })
    detail.manifest = { ...detail.manifest, permissions: ['hooks'] }
    detail.source = 'url'
    detail.sourceRef = 'https://plugins.example.com/dice.zip'
    detail.manifest = { ...detail.manifest, contributes: { providers: [{ id: 'dice-roller', name: 'Dice', baseURL: 'http://127.0.0.1:1234/v1', apiFormat: 'openai-chat' }] } }
    const wrapper = render({ plugin: detail })
    expect(wrapper.get('[data-slot="trust-sha256"]').text()).toBe(HASH)
    expect(wrapper.get('[data-slot="trust-source"]').text()).toBe('plugins.example.com')
    expect(wrapper.findAll('[data-value]').map(item => item.text())).toEqual(['Reads and changes conversations'])
    expect(wrapper.get('[aria-label="Hosts"]').text()).toBe('127.0.0.1:1234')
    expect(wrapper.text()).not.toContain('Starts these programs')
    wrapper.unmount()
  })
})
