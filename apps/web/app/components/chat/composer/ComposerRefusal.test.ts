import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import ComposerRefusal from './ComposerRefusal.vue'

describe('composerRefusal (P11-0b stub)', () => {
  it('renders nothing without a refusal', () => {
    const wrapper = mount(ComposerRefusal, { props: { refusal: null } })
    expect(wrapper.find(`[data-testid="${testIds.composerRefusal}"]`).exists()).toBe(false)
  })

  it('renders a hook-blocked refusal as an alert and emits dismiss', async () => {
    const wrapper = mount(ComposerRefusal, { props: { refusal: { code: 'hook-blocked', reason: 'No keys.', event: 'UserPromptSubmit', source: 'project', command: null } } })
    const root = wrapper.get(`[data-testid="${testIds.composerRefusal}"]`)
    expect(root.attributes()).toMatchObject({ 'data-code': 'hook-blocked', 'data-event': 'UserPromptSubmit', 'role': 'alert' })
    expect(root.text()).toContain('No keys.')
    expect(wrapper.find(`[data-testid="${testIds.composerRefusalReview}"]`).exists()).toBe(false)
    await wrapper.get(`[data-testid="${testIds.composerRefusalDismiss}"]`).trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })

  it('offers Review… for an untrusted command', async () => {
    const wrapper = mount(ComposerRefusal, { props: { refusal: { code: 'untrusted', reason: 'Approve it.', event: null, source: null, command: 'status' } } })
    expect(wrapper.get(`[data-testid="${testIds.composerRefusal}"]`).attributes('data-event')).toBe('')
    expect(wrapper.text()).toContain('/status runs shell lines you haven\'t approved.')
    await wrapper.get(`[data-testid="${testIds.composerRefusalReview}"]`).trigger('click')
    expect(wrapper.emitted('review')).toHaveLength(1)
  })
})
