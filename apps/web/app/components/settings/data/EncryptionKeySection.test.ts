// EncryptionKeySection skeleton (docs/UI.md 9.8, 10.4; C15, P7-0b): the "Encryption key" section with its root test id.
// W7.13 adds the key status, the Rotate key button and the dialog.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import EncryptionKeySection from './EncryptionKeySection.vue'

describe('encryptionKeySection', () => {
  it('renders the "Encryption key" section with its root test id', () => {
    const wrapper = mount(EncryptionKeySection)
    const root = wrapper.get(`[data-testid="${testIds.dataKeySection}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-slot')).toBe('settings-section')
    expect(root.get('h2').text()).toBe('Encryption key')
    wrapper.unmount()
  })
})
