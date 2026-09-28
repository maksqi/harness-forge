import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import ImageSettings from './ImageSettings.vue'

describe('imageSettings', () => {
  it('renders the Images section as its root', () => {
    const wrapper = mount(ImageSettings)
    const root = wrapper.get(`[data-testid="${testIds.imageSettings}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.element.tagName).toBe('SECTION')
    expect(root.get('h2').text()).toBe('Images')
    expect(root.text()).toContain('Generate pictures with your own providers.')
    wrapper.unmount()
  })
})
