import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import RecordingIndicator from './RecordingIndicator.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('recordingIndicator', () => {
  it('renders its root with the m:ss timer and emits cancel', async () => {
    const wrapper = mount(RecordingIndicator, { props: { elapsedMs: 7_400 }, attachTo: document.body })
    const root = wrapper.get(`[data-testid="${testIds.composerRecording}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(wrapper.get(`[data-testid="${testIds.composerRecordingTime}"]`).text()).toBe('0:07')
    expect(wrapper.props('transcribing')).toBe(false)
    const cancel = wrapper.get(`[data-testid="${testIds.composerMicCancel}"]`)
    expect(cancel.text()).toBe('Cancel')
    await cancel.trigger('click')
    expect(wrapper.emitted('cancel')).toEqual([[]])
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
