// One item of the project trust review (docs/UI.md 7.33, 14.2; W11.9-T2): the named article, the checkbox or Revoke,
// the title, path and state, "Changed since you approved it.", the exact command in a `pre` named "Command" with Copy,
// the details (names only) and the warnings.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { trustCommandItem, trustHookItem, trustMcpItem, trustSha } from '~/utils/testing/fixtures'
import ProjectTrustItem from './ProjectTrustItem.vue'

type Props = InstanceType<typeof ProjectTrustItem>['$props']

function mountItem(props: Props) {
  // CopyButton renders a tooltip: a provider is needed, like in the app.
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(ProjectTrustItem, props) }) })
}

describe('projectTrustItem', () => {
  it('renders a pending hook as a named article with its checkbox, title, path, state and command', async () => {
    const wrapper = mountItem({ item: trustHookItem({ changed: true }), selected: false, busy: false })
    const root = wrapper.get(`[data-testid="${testIds.projectTrustItem}"]`)
    expect(root.element.tagName).toBe('ARTICLE')
    expect(root.attributes()).toMatchObject({ 'data-kind': 'hook', 'data-state': 'changed', 'data-key': trustSha(1) })
    expect(root.attributes('aria-label')).toBe('Hook sh .claude/hooks/guard.sh, Changed')
    expect(root.text()).toContain('PreToolUse · Bash')
    expect(root.text()).toContain('.claude/settings.json')
    expect(root.text()).toContain('Changed since you approved it.')
    const pre = root.get('pre[data-slot="project-trust-command"]')
    expect(pre.attributes('aria-label')).toBe('Command')
    expect(pre.text()).toBe('sh .claude/hooks/guard.sh')
    expect(root.find('button[aria-label="Copy command"]').exists()).toBe(true)
    expect(root.text()).toContain('Runs .claude/hooks/guard.sh')
    expect(root.find(`[data-testid="${testIds.projectTrustRevoke}"]`).exists()).toBe(false)

    // The checkbox has the title as its visible label and asks the parent to toggle.
    const checkbox = root.get(`[data-testid="${testIds.projectTrustSelect}"]`)
    const label = root.get(`label[for="${checkbox.attributes('id')}"]`)
    expect(label.text()).toBe('PreToolUse · Bash')
    await checkbox.trigger('click')
    const item = wrapper.findComponent(ProjectTrustItem)
    expect(item.emitted('toggle')).toEqual([[]])
  })

  it('reads a new MCP server: transport, names only, variables with their state and the warnings', () => {
    const wrapper = mountItem({
      item: trustMcpItem(),
      selected: true,
      busy: false,
      variables: [{ name: 'MCP_TOKEN', set: true, hint: null, usedBy: ['memory'] }],
    })
    const root = wrapper.get(`[data-testid="${testIds.projectTrustItem}"]`)
    expect(root.attributes()).toMatchObject({ 'data-kind': 'mcp', 'data-state': 'new' })
    expect(root.attributes('aria-label')).toBe('MCP server memory, New')
    expect(root.get('[data-slot="mcp-transport-badge"]').text()).toBe('stdio')
    expect(root.get('pre').text()).toBe('node tools/mcp-memory.mjs')
    expect(root.text()).toContain('Environment: MCP_TOKEN')
    expect(root.text()).toContain('Variables: MCP_TOKEN (set)')
    expect(root.text()).not.toContain('Changed since you approved it.')
    expect(root.get('[data-slot="project-trust-warnings"] [data-value="runs-repository-code"]').text())
      .toBe('Runs code from this repository that isn\'t pinned (like npm test): later changes to that code run without a new approval.')
    expect(root.get(`[data-testid="${testIds.projectTrustSelect}"]`).attributes('data-state')).toBe('checked')
  })

  it('offers Revoke instead of a checkbox on an approved item and shows its shell lines one per line', async () => {
    const wrapper = mountItem({
      item: trustCommandItem({ detail: { name: 'status', spans: ['git status --short', 'git log -1'] } }),
      selected: false,
      busy: false,
      variables: [],
    })
    const root = wrapper.get(`[data-testid="${testIds.projectTrustItem}"]`)
    expect(root.attributes()).toMatchObject({ 'data-kind': 'command', 'data-state': 'approved' })
    expect(root.text()).toContain('/status')
    expect(root.text()).toContain('Approved')
    expect(root.get('pre').text()).toBe('git status --short\ngit log -1')
    expect(root.find(`[data-testid="${testIds.projectTrustSelect}"]`).exists()).toBe(false)
    const revoke = root.get(`[data-testid="${testIds.projectTrustRevoke}"]`)
    expect(revoke.attributes('aria-label')).toBe('Revoke /status')
    await revoke.trigger('click')
    expect(wrapper.findComponent(ProjectTrustItem).emitted('revoke')).toEqual([[]])
  })

  it('disables its controls while busy', () => {
    const wrapper = mountItem({ item: trustCommandItem(), selected: true, busy: true, variables: [] })
    const root = wrapper.get(`[data-testid="${testIds.projectTrustItem}"]`)
    expect(root.attributes('aria-busy')).toBe('true')
    expect(root.get(`[data-testid="${testIds.projectTrustRevoke}"]`).attributes('disabled')).toBeDefined()
    const pending = mountItem({ item: trustHookItem(), selected: false, busy: true })
    expect(pending.get(`[data-testid="${testIds.projectTrustSelect}"]`).attributes('disabled')).toBeDefined()
  })
})
