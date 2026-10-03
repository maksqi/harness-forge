// StorageCleanupSection skeleton (docs/UI.md 9.8, 10.4; C15, P7-0b): the "Storage cleanup" section with its root test
// id. W7.13 adds the check, the summary and the cleanup.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import StorageCleanupSection from './StorageCleanupSection.vue'

describe('storageCleanupSection', () => {
  it('renders the "Storage cleanup" section with its root test id', () => {
    const wrapper = mount(StorageCleanupSection)
    const root = wrapper.get(`[data-testid="${testIds.dataCleanupSection}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-slot')).toBe('settings-section')
    expect(root.get('h2').text()).toBe('Storage cleanup')
    wrapper.unmount()
  })
})
