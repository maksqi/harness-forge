import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { projectMcpServer, trustMcpItem } from '~/utils/testing/fixtures'
import ProjectMcpServerRow from './ProjectMcpServerRow.vue'

describe('projectMcpServerRow (P11-0b stub)', () => {
  it('renders its root with the server id, the state and the transport', () => {
    const wrapper = mount(ProjectMcpServerRow, { props: { server: projectMcpServer(), trust: trustMcpItem(), expanded: false, busy: false } })
    const root = wrapper.get(`[data-testid="${testIds.projectMcpServer}"]`)
    expect(root.attributes()).toMatchObject({ 'data-server-id': 'memory', 'data-state': 'needs-variables', 'data-transport': 'stdio' })
    expect(root.text()).toContain('Set 1 variable')
  })
})
