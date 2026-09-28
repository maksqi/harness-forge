import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import SharesSettingsSection from './SharesSettingsSection.vue'

describe('sharesSettingsSection', () => {
  it('renders its root test id', () => {
    const wrapper = mount(SharesSettingsSection)
    expect(wrapper.get(`[data-testid="${testIds.sharesSection}"]`).element).toBe(wrapper.element)
    wrapper.unmount()
  })
})
