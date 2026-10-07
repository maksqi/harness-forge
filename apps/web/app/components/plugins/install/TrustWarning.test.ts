import type { PluginInspection } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { claudePluginInfo, pluginDetail } from '~/utils/testing/fixtures'
import { CLAUDE_TREE_PIN_NOTE, TRUST_WARNING_TEXT } from './install'
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
    format: 'harness',
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
    claude: null,
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

  it('lists the commands of command hooks and command `!` lines under "Runs these commands" (Phase 11)', () => {
    const wrapper = render({
      inspection: inspection({
        manifest: {
          manifestVersion: 1,
          id: 'hook-pack',
          name: 'Hook pack',
          version: '1.0.0',
          engines: { harness: '^1.5.0' },
          contributes: {
            hooks: {
              PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh "$HARNESS_PLUGIN_ROOT/guard.sh"' }] }],
              Stop: [{ hooks: [{ type: 'command', command: 'pnpm lint --quiet', timeout: 30 }] }],
            },
            commands: [{ name: 'status', description: 'Show the status', template: 'Status:\n!`git status --short`\nSummarize it.' }],
          },
        },
      }),
    })
    const block = wrapper.get('[data-slot="trust-run-commands"]')
    expect(block.text()).toContain('Runs these commands')
    expect(block.findAll('li').map(item => item.text())).toEqual([
      'PreToolUse hooksh "$HARNESS_PLUGIN_ROOT/guard.sh"',
      'Stop hookpnpm lint --quiet',
      '/statusgit status --short',
    ])
    wrapper.unmount()
  })

  it('lists the executables of a Claude Code plugin, its hosts and the whole-tree pin note (Phase 12)', () => {
    const claude = claudePluginInfo({
      hosts: ['mcp.example.com'],
      executables: [
        { kind: 'hook', label: 'PostToolUse Write|Edit', command: 'sh "$CLAUDE_PLUGIN_ROOT/hooks/format.sh"' },
        { kind: 'mcp', label: 'github', command: 'node $CLAUDE_PLUGIN_ROOT/server.mjs --stdio' },
        { kind: 'span', label: 'deploy', command: 'git status --short' },
      ],
    })
    const wrapper = render({
      inspection: inspection({
        manifest: { manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '1.2.0', engines: { harness: '^1.6.0' } },
        format: 'claude',
        permissions: [],
        claude,
      }),
    })
    const block = wrapper.get('[data-slot="trust-run-commands"]')
    expect(block.findAll('li').map(item => item.text())).toEqual([
      'PostToolUse hooksh "$CLAUDE_PLUGIN_ROOT/hooks/format.sh"',
      'MCP server githubnode $CLAUDE_PLUGIN_ROOT/server.mjs --stdio',
      '/review-kit:deploygit status --short',
    ])
    // The servers are listed once, with the executables (not under "Starts these programs").
    expect(wrapper.text()).not.toContain('Starts these programs')
    expect(wrapper.get('[aria-label="Hosts"]').text()).toBe('mcp.example.com')
    expect(wrapper.get('[data-slot="trust-tree-note"]').text()).toBe(CLAUDE_TREE_PIN_NOTE)
    wrapper.unmount()
  })

  it('reads the executables of an installed Claude Code plugin from its detail (Phase 12)', () => {
    const detail = pluginDetail({ id: 'review-kit', name: 'Review kit', format: 'claude', source: 'github', sourceRef: 'anthropics/review-kit@0123456789ab', claude: claudePluginInfo() })
    const wrapper = render({ plugin: detail })
    expect(wrapper.get('[data-slot="trust-run-commands"]').findAll('li').map(item => item.text())).toEqual([
      'PostToolUse hooksh "$CLAUDE_PLUGIN_ROOT/hooks/format.sh"',
      'MCP server review-kitnode server.mjs',
    ])
    expect(wrapper.get('[data-slot="trust-source"]').text()).toBe('anthropics/review-kit@0123456789ab')
    expect(wrapper.find('[data-slot="trust-tree-note"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows no tree note for a Claude Code plugin that runs nothing', () => {
    const wrapper = render({ inspection: inspection({ format: 'claude', manifest: { manifestVersion: 1, id: 'notes', name: 'Notes', version: '1.0.0', engines: { harness: '^1.6.0' } }, permissions: [], claude: claudePluginInfo({ executables: [] }) }) })
    expect(wrapper.find('[data-slot="trust-run-commands"]').exists()).toBe(false)
    expect(wrapper.find('[data-slot="trust-tree-note"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
