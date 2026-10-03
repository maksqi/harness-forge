// FolderBrowser skeleton (docs/UI.md 9.10, 10.4; C15, P7-0b): the root test id with data-path ('' for the roots) and
// data-state. W7.9 adds the browsing.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import FolderBrowser from './FolderBrowser.vue'

describe('folderBrowser', () => {
  it('renders its root with the open folder (empty for the roots) and a state', async () => {
    const wrapper = mount(FolderBrowser, { props: { modelValue: null } })
    const root = wrapper.get(`[data-testid="${testIds.folderBrowser}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-path')).toBe('')
    expect(['loading', 'ready', 'empty', 'error']).toContain(root.attributes('data-state'))

    await wrapper.setProps({ modelValue: '/srv/workspaces/website', disabled: true })
    expect(root.attributes('data-path')).toBe('/srv/workspaces/website')
    expect(wrapper.props()).toEqual({ modelValue: '/srv/workspaces/website', disabled: true })
    wrapper.unmount()
  })
})
