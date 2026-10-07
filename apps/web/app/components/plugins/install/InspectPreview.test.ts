// InspectPreview (docs/UI.md 8.3 step 2, 8.13): the harness preview and the Claude Code additions of Phase 12 (W12.9).
import type { PluginInspection } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { claudePluginInfo } from '~/utils/testing/fixtures'
import InspectPreview from './InspectPreview.vue'

const HASH = 'e'.repeat(64)
const none = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] }

function inspection(overrides: Partial<PluginInspection> = {}): PluginInspection {
  return {
    manifest: { manifestVersion: 1, id: 'acme', name: 'Acme', version: '1.2.0', description: 'Acme models', engines: { harness: '^1.0.0' } },
    kind: 'declarative',
    format: 'harness',
    source: 'zip',
    sha256: HASH,
    contributions: { ...none, providers: ['acme'], models: 2 },
    networkHosts: ['api.acme.test'],
    secretsRequested: [],
    permissions: [],
    requiresTrust: false,
    compatible: true,
    existing: null,
    files: { count: 2, bytes: 1200 },
    warnings: [],
    claude: null,
    ...overrides,
  }
}

/** A Claude Code plugin from a GitHub repository folder, with commands, an agent, a hook and a stdio server. */
function claudeInspection(overrides: Partial<PluginInspection> = {}): PluginInspection {
  return inspection({
    manifest: { manifestVersion: 1, id: 'review-kit', name: 'review-kit', version: '1.2.0', description: 'Code review commands', engines: { harness: '^1.6.0' } },
    format: 'claude',
    source: 'github',
    sourceRef: 'anthropics/review-kit@3f2a9c1d0e4b/plugins/review-kit',
    contributions: { ...none, commands: ['review-kit:review', 'review-kit:db:migrate'], agents: ['review-kit:code-reviewer'] },
    networkHosts: [],
    requiresTrust: true,
    claude: claudePluginInfo({
      hosts: ['mcp.example.com'],
      userConfig: [
        { key: 'API_TOKEN', title: 'API token', sensitive: true, required: true },
        { key: 'BRANCH', title: 'Default branch', sensitive: false, required: false },
      ],
      unsupported: [
        { component: '.lsp.json', reason: 'LSP servers aren\'t supported.' },
        { component: 'bin/', reason: 'Never run.' },
      ],
    }),
    ...overrides,
  })
}

function render(props: { inspection: PluginInspection, sourceLabel: string }) {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(InspectPreview, props) }) })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('inspectPreview', () => {
  it('shows a harness plugin without the Claude Code lines', () => {
    const wrapper = render({ inspection: inspection(), sourceLabel: 'acme.zip' })
    const root = wrapper.get(`[data-testid="${testIds.installPreview}"]`)
    expect(root.attributes('data-format')).toBe('harness')
    expect(root.text()).toContain('Declarative')
    expect(root.text()).toContain('Zip · acme.zip')
    expect(root.text()).toContain('1 provider · 2 models')
    expect(root.text()).toContain('api.acme.test')
    for (const slot of ['install-format', 'install-commit', 'install-namespace', 'install-user-config', 'install-ignored'])
      expect(root.find(`[data-slot="${slot}"]`).exists(), slot).toBe(false)
    wrapper.unmount()
  })

  it('shows the Claude Code badge, the resolved commit, the namespace, "Asks for" and "Ignored" (Phase 12)', () => {
    const wrapper = render({ inspection: claudeInspection(), sourceLabel: 'anthropics/review-kit@3f2a9c1d0e4b/plugins/review-kit' })
    const root = wrapper.get(`[data-testid="${testIds.installPreview}"]`)
    expect(root.attributes('data-format')).toBe('claude')
    const format = root.get('[data-slot="install-format"]')
    expect(format.attributes('data-value')).toBe('claude')
    expect(format.text()).toBe('Claude Code plugin')
    expect(root.text()).not.toContain('Declarative')
    expect(root.text()).toContain('GitHub · anthropics/review-kit@3f2a9c1d0e4b/plugins/review-kit')
    const commit = root.get('[data-slot="install-commit"]')
    expect(commit.text()).toBe('Resolved commit 3f2a9c1')
    expect(commit.attributes('title')).toBe('3f2a9c1d0e4b')
    // What its files bring (claude.components), and the qualified names.
    expect(root.text()).toContain('3 commands · 1 agent · 1 skill · 1 output style · 1 hook · 1 MCP server')
    expect(root.get('[data-slot="install-namespace"]').text()).toBe('Commands run as /review-kit:review. Agents start as review-kit:code-reviewer.')
    expect(root.get('[data-slot="install-user-config"]').findAll('li').map(item => item.text())).toEqual(['API token (secret) (required)', 'Default branch'])
    expect(root.get('[data-slot="install-ignored"]').findAll('li').map(item => item.text())).toEqual(['.lsp.json (LSP servers aren\'t supported)', 'bin/ (Never run)'])
    expect(root.text()).toContain('mcp.example.com')
    expect(root.text()).not.toContain('Code plugins can register more')
    wrapper.unmount()
  })

  it('shows the version as written and no commit for a marketplace entry from an archive', () => {
    const wrapper = render({
      inspection: claudeInspection({ source: 'marketplace', sourceRef: 'review-kit.tgz', claude: claudePluginInfo({ version: '2024-10-01', userConfig: [], unsupported: [] }) }),
      sourceLabel: 'review-kit.tgz',
    })
    const root = wrapper.get(`[data-testid="${testIds.installPreview}"]`)
    expect(root.text()).toContain('2024-10-01')
    expect(root.text()).toContain('Marketplace · review-kit.tgz')
    expect(root.find('[data-slot="install-commit"]').exists()).toBe(false)
    expect(root.find('[data-slot="install-user-config"]').exists()).toBe(false)
    expect(root.find('[data-slot="install-ignored"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
