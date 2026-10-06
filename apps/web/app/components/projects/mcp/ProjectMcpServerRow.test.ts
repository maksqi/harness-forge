// One server of a project's `.mcp.json` (docs/UI.md 7.33, 14.2; W11.9-T4): the state attributes, the status dot and
// text, the exact command or URL from the trust item, the shadow note, Reconnect / Review… and the tools toggle.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { projectMcpServer, trustMcpItem } from '~/utils/testing/fixtures'
import ProjectMcpServerRow from './ProjectMcpServerRow.vue'

describe('projectMcpServerRow', () => {
  it('renders its root with the server id, the state, the transport, the status and the command', () => {
    const wrapper = mount(ProjectMcpServerRow, { props: { server: projectMcpServer(), trust: trustMcpItem(), expanded: false, busy: false } })
    const root = wrapper.get(`[data-testid="${testIds.projectMcpServer}"]`)
    expect(root.attributes()).toMatchObject({ 'data-server-id': 'memory', 'data-state': 'needs-variables', 'data-transport': 'stdio' })
    expect(root.text()).toContain('Set 1 variable')
    expect(root.get('[data-slot="status-dot"]').text()).toBe('Needs variables')
    expect(root.get('[data-slot="project-mcp-command"]').text()).toBe('node tools/mcp-memory.mjs')
    expect(root.find('[data-slot="project-mcp-shadows"]').exists()).toBe(false)
    // Neither Reconnect nor Review… for a server that waits for variables.
    expect(root.find(`[data-testid="${testIds.projectMcpReconnect}"]`).exists()).toBe(false)
    expect(root.find(`[data-testid="${testIds.projectMcpReview}"]`).exists()).toBe(false)
  })

  it('offers Review… while pending and Reconnect for a connected server that shadows a global one', async () => {
    const pending = mount(ProjectMcpServerRow, { props: { server: projectMcpServer({ state: 'pending' }), trust: null, expanded: false, busy: false } })
    expect(pending.text()).toContain('Needs approval')
    expect(pending.find('[data-slot="project-mcp-command"]').exists()).toBe(false)
    await pending.get(`[data-testid="${testIds.projectMcpReview}"]`).trigger('click')
    expect(pending.emitted('review')).toEqual([[]])

    const connected = mount(ProjectMcpServerRow, {
      props: { server: projectMcpServer({ state: 'connected', tools: ['mcp__memory__get', 'mcp__memory__set'], missingVariables: [], shadows: 'memory' }), trust: trustMcpItem(), expanded: false, busy: false },
    })
    expect(connected.text()).toContain('Connected · 2 tools')
    expect(connected.get('[data-slot="project-mcp-shadows"]').text()).toBe('Replaces your server memory in this project\'s chats.')
    const reconnect = connected.get(`[data-testid="${testIds.projectMcpReconnect}"]`)
    expect(reconnect.attributes('aria-label')).toBe('Reconnect memory')
    await reconnect.trigger('click')
    expect(connected.emitted('reconnect')).toEqual([[]])
  })

  it('toggles its tools and disables its action while busy', async () => {
    const server = projectMcpServer({ state: 'error', tools: ['mcp__memory__get'], missingVariables: [], error: { code: 'internal_error', message: 'spawn ENOENT' } })
    const wrapper = mount(ProjectMcpServerRow, { props: { server, trust: trustMcpItem(), expanded: false, busy: true } })
    expect(wrapper.text()).toContain('Error: spawn ENOENT')
    expect(wrapper.get(`[data-testid="${testIds.projectMcpReconnect}"]`).attributes('disabled')).toBeDefined()
    const toggle = wrapper.get('[data-action="toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-slot="project-mcp-tools"]').exists()).toBe(false)
    await toggle.trigger('click')
    expect(wrapper.emitted('toggle')).toEqual([[]])
    await wrapper.setProps({ expanded: true })
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const tools = wrapper.get('[data-slot="project-mcp-tools"]')
    expect(toggle.attributes('aria-controls')).toBe(tools.attributes('id'))
    expect(tools.text()).toContain('mcp__memory__get')
  })
})
