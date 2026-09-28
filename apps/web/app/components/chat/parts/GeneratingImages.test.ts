// Placeholders of an image turn in flight (docs/UI.md 7.16, 10.4): tile count and aspect ratio, the live counter,
// the busy root and the reduced-motion hooks.
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import GeneratingImages from './GeneratingImages.vue'

const NOW = 1_790_600_000_000

function tiles(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('[data-slot="generating-tile"]')
}

function caption(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('[data-slot="generating-caption"]')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  // Store-free (the transcript and a resumed stream render it before any store matters).
  setActivePinia(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('generatingImages', () => {
  it('renders a busy root with the tile count and the sr-only text', () => {
    const wrapper = mount(GeneratingImages, { props: { n: 2, aspectRatio: '16:9', startedAt: NOW } })
    const root = wrapper.get(`[data-testid="${testIds.imageGenerating}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-count')).toBe('2')
    expect(root.attributes('aria-busy')).toBe('true')
    expect(root.get('.sr-only').text()).toBe('Generating images')
    expect(wrapper.props()).toEqual({ n: 2, aspectRatio: '16:9', startedAt: NOW })
    wrapper.unmount()
  })

  it('shows n tiles at the requested aspect ratio in two columns', () => {
    const wrapper = mount(GeneratingImages, { props: { n: 3, aspectRatio: '9:16', startedAt: NOW } })
    expect(tiles(wrapper)).toHaveLength(3)
    for (const tile of tiles(wrapper)) {
      expect(tile.attributes('style')).toContain('aspect-ratio: 9 / 16')
      expect(tile.classes()).toContain('bg-muted')
      expect(tile.classes()).not.toContain('max-h-[70dvh]')
    }
    expect(tiles(wrapper)[0]!.element.parentElement!.classList.contains('grid-cols-2')).toBe(true)
    wrapper.unmount()
  })

  it('shows one square tile at the full width for Auto, capped like a single image', () => {
    const wrapper = mount(GeneratingImages, { props: { n: 1, startedAt: NOW } })
    expect(wrapper.get(`[data-testid="${testIds.imageGenerating}"]`).attributes('data-count')).toBe('1')
    expect(wrapper.props('aspectRatio')).toBeUndefined()
    expect(tiles(wrapper)).toHaveLength(1)
    const tile = tiles(wrapper)[0]!
    expect(tile.attributes('style')).toContain('aspect-ratio: 1 / 1')
    expect(tile.classes()).toEqual(expect.arrayContaining(['w-full', 'max-h-[70dvh]']))
    expect(tile.element.parentElement!.classList.contains('grid-cols-2')).toBe(false)
    wrapper.unmount()
  })

  it('keeps the tile count between 1 and 4', () => {
    expect(tiles(mount(GeneratingImages, { props: { n: 9, startedAt: NOW } }))).toHaveLength(4)
    expect(tiles(mount(GeneratingImages, { props: { n: 0, startedAt: NOW } }))).toHaveLength(1)
  })

  it('counts the seconds since startedAt every second, without announcing them', async () => {
    const wrapper = mount(GeneratingImages, { props: { n: 1, startedAt: NOW - 12_400 } })
    expect(caption(wrapper).text()).toBe('Generating image… 12s')
    expect(caption(wrapper).attributes('aria-live')).toBe('off')
    await vi.advanceTimersByTimeAsync(1000)
    expect(caption(wrapper).text()).toBe('Generating image… 13s')
    await wrapper.setProps({ n: 2 })
    expect(caption(wrapper).text()).toBe('Generating 2 images… 13s')
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never counts below zero when the server clock is ahead', () => {
    const wrapper = mount(GeneratingImages, { props: { n: 2, startedAt: NOW + 5_000 } })
    expect(caption(wrapper).text()).toBe('Generating 2 images… 0s')
    wrapper.unmount()
  })

  it('uses the shimmer classes that turn static under reduced motion', () => {
    const wrapper = mount(GeneratingImages, { props: { n: 1, startedAt: NOW } })
    expect(caption(wrapper).classes()).toContain('hf-shimmer-text')
    const sweep = tiles(wrapper)[0]!.get('[aria-hidden="true"]')
    expect(sweep.classes()).toEqual(expect.arrayContaining(['animate-hf-shimmer', 'motion-reduce:hidden']))
    wrapper.unmount()
  })
})
