import type { ComposerRefusalData } from './output-style'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import ComposerRefusal from './ComposerRefusal.vue'

const blocked: ComposerRefusalData = { code: 'hook-blocked', reason: 'Don\'t paste API keys into the chat.', event: 'UserPromptSubmit', source: 'project', command: null }

describe('composerRefusal', () => {
  it('renders nothing without a refusal', () => {
    const wrapper = mount(ComposerRefusal, { props: { refusal: null } })
    expect(wrapper.find(`[data-testid="${testIds.composerRefusal}"]`).exists()).toBe(false)
  })

  it('renders a hook-blocked refusal as an alert: the title, the reason and "{event} · {source}"', async () => {
    const wrapper = mount(ComposerRefusal, { props: { refusal: blocked }, attrs: { id: 'refusal-1' } })
    const root = wrapper.get(`[data-testid="${testIds.composerRefusal}"]`)
    expect(root.attributes()).toMatchObject({ 'data-code': 'hook-blocked', 'data-event': 'UserPromptSubmit', 'role': 'alert', 'id': 'refusal-1' })
    expect(root.get('p').text()).toBe('A hook blocked this message')
    expect(root.get('[data-slot="composer-refusal-reason"]').text()).toBe('Don\'t paste API keys into the chat.')
    expect(root.get('[data-slot="composer-refusal-source"]').text()).toBe('UserPromptSubmit · Project hook')
    expect(wrapper.find(`[data-testid="${testIds.composerRefusalReview}"]`).exists()).toBe(false)
    const dismiss = wrapper.get(`[data-testid="${testIds.composerRefusalDismiss}"]`)
    expect(dismiss.attributes('aria-label')).toBe('Dismiss')
    expect(dismiss.classes()).toContain('pointer-coarse:size-10')
    await dismiss.trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })

  it('names personal and plugin hooks, and leaves the line out without a record', async () => {
    const wrapper = mount(ComposerRefusal, { props: { refusal: { ...blocked, event: 'SessionStart', source: 'personal' } } })
    expect(wrapper.get('[data-slot="composer-refusal-source"]').text()).toBe('SessionStart · Personal hook')
    await wrapper.setProps({ refusal: { ...blocked, source: 'plugin' } })
    expect(wrapper.get('[data-slot="composer-refusal-source"]').text()).toBe('UserPromptSubmit · Plugin hook')
    await wrapper.setProps({ refusal: { ...blocked, event: null, source: null } })
    expect(wrapper.find('[data-slot="composer-refusal-source"]').exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${testIds.composerRefusal}"]`).attributes('data-event')).toBe('')
    expect(wrapper.text()).toContain('Don\'t paste API keys into the chat.')
  })

  it('offers Review… for an untrusted command', async () => {
    const wrapper = mount(ComposerRefusal, { props: { refusal: { code: 'untrusted', reason: 'Approve it.', event: null, source: null, command: 'status' } } })
    expect(wrapper.get(`[data-testid="${testIds.composerRefusal}"]`).attributes()).toMatchObject({ 'data-code': 'untrusted', 'data-event': '' })
    expect(wrapper.text()).toContain('/status runs shell lines you haven\'t approved.')
    // The server's text is not repeated: the line says what to do.
    expect(wrapper.find('[data-slot="composer-refusal-reason"]').exists()).toBe(false)
    const review = wrapper.get(`[data-testid="${testIds.composerRefusalReview}"]`)
    expect(review.text()).toBe('Review…')
    expect(review.classes()).toContain('pointer-coarse:h-10')
    await review.trigger('click')
    expect(wrapper.emitted('review')).toHaveLength(1)
    expect(wrapper.emitted('dismiss')).toBeUndefined()
  })

  it('reads "This command" when the command name is unknown', () => {
    const wrapper = mount(ComposerRefusal, { props: { refusal: { code: 'untrusted', reason: 'Approve it.', event: null, source: null, command: null } } })
    expect(wrapper.text()).toContain('This command runs shell lines you haven\'t approved.')
  })
})
