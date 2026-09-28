import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import RecordingIndicator from './RecordingIndicator.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('recordingIndicator', () => {
  it('renders its root with a pulsing dot, the m:ss timer and Cancel, which emits cancel', async () => {
    const wrapper = mount(RecordingIndicator, { props: { elapsedMs: 7_400 }, attachTo: document.body })
    const root = wrapper.get(`[data-testid="${testIds.composerRecording}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes()).toMatchObject({ 'data-state': 'recording', 'role': 'group', 'aria-label': 'Recording' })
    expect(root.find('.bg-destructive').classes()).toContain('motion-safe:animate-pulse')
    const time = wrapper.get(`[data-testid="${testIds.composerRecordingTime}"]`)
    expect(time.text()).toBe('0:07')
    expect(time.attributes('aria-live')).toBeUndefined()
    expect(wrapper.props('transcribing')).toBe(false)
    const cancel = wrapper.get(`[data-testid="${testIds.composerMicCancel}"]`)
    expect(cancel.text()).toBe('Cancel')
    expect(cancel.classes()).toContain('pointer-coarse:h-10')
    await cancel.trigger('click')
    expect(wrapper.emitted('cancel')).toEqual([[]])
    wrapper.unmount()
  })

  it('stops pulsing while transcribing', () => {
    const wrapper = mount(RecordingIndicator, { props: { elapsedMs: 12_000, transcribing: true } })
    expect(wrapper.attributes()).toMatchObject({ 'data-state': 'transcribing', 'aria-label': 'Transcribing' })
    expect(wrapper.find('.bg-destructive').classes()).not.toContain('motion-safe:animate-pulse')
    expect(wrapper.get(`[data-testid="${testIds.composerRecordingTime}"]`).text()).toBe('0:12')
    wrapper.unmount()
  })

  it('formats minutes and clamps invalid times to 0:00', async () => {
    const wrapper = mount(RecordingIndicator, { props: { elapsedMs: 65_000, transcribing: true } })
    const time = () => wrapper.get(`[data-testid="${testIds.composerRecordingTime}"]`).text()
    expect(time()).toBe('1:05')
    await wrapper.setProps({ elapsedMs: 600_000 })
    expect(time()).toBe('10:00')
    await wrapper.setProps({ elapsedMs: -5 })
    expect(time()).toBe('0:00')
    await wrapper.setProps({ elapsedMs: Number.NaN })
    expect(time()).toBe('0:00')
    wrapper.unmount()
  })
})
