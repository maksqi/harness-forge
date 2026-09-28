import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import GeneratingImages from './GeneratingImages.vue'

describe('generatingImages', () => {
  it('renders a busy root with the tile count and the sr-only text', () => {
    const wrapper = mount(GeneratingImages, { props: { n: 2, aspectRatio: '16:9', startedAt: 1_790_600_000_000 } })
    const root = wrapper.get(`[data-testid="${testIds.imageGenerating}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-count')).toBe('2')
    expect(root.attributes('aria-busy')).toBe('true')
    expect(root.get('.sr-only').text()).toBe('Generating images')
    expect(wrapper.props()).toEqual({ n: 2, aspectRatio: '16:9', startedAt: 1_790_600_000_000 })
    wrapper.unmount()
  })

  it('takes the aspect ratio as optional (Auto)', () => {
    const wrapper = mount(GeneratingImages, { props: { n: 1, startedAt: 0 } })
    expect(wrapper.get(`[data-testid="${testIds.imageGenerating}"]`).attributes('data-count')).toBe('1')
    expect(wrapper.props('aspectRatio')).toBeUndefined()
    wrapper.unmount()
  })
})
