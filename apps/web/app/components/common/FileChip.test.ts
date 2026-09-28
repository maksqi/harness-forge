import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FileChip from './FileChip.vue'

describe('fileChip', () => {
  it('renders images with a URL as a 64px thumbnail', async () => {
    const wrapper = mount(FileChip, {
      props: { name: 'screenshot.png', mime: 'image/png', url: '/api/files/file_abc', removable: true },
      attrs: { 'data-testid': 'file-chip' },
    })
    const root = wrapper.get('[data-testid="file-chip"]')
    expect(root.classes()).toContain('size-16')
    expect(root.attributes('data-state')).toBe('done')
    expect(wrapper.get('img').attributes('src')).toBe('/api/files/file_abc')
    await wrapper.get('button[aria-label="Remove screenshot.png"]').trigger('click')
    await wrapper.get('button[aria-label="Open screenshot.png"]').trigger('click')
    expect(wrapper.emitted('remove')).toHaveLength(1)
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('renders other files as a chip with name and size', () => {
    const wrapper = mount(FileChip, { props: { name: 'notes.md', mime: 'text/markdown', size: 2048 } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('notes.md')
    expect(wrapper.text()).toContain('2 KB')
    expect(wrapper.find('button[aria-label="Remove notes.md"]').exists()).toBe(false)
  })

  it('never uses an unsafe URL as an image source', () => {
    const wrapper = mount(FileChip, { props: { name: 'x.svg', mime: 'image/svg+xml', url: 'javascript:alert(1)' } })
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('offers Retry after a failed upload', async () => {
    const wrapper = mount(FileChip, { props: { name: 'big.pdf', mime: 'application/pdf', state: 'error' } })
    expect(wrapper.attributes('data-state')).toBe('error')
    const retry = wrapper.findAll('button').find(button => button.text() === 'Retry')
    await retry!.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})
