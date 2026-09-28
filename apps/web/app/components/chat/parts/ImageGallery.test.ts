import type { FileUIPart } from 'ai'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import ImageGallery from './ImageGallery.vue'

const MESSAGE_ID = 'msg_assistant0000001'

function image(index: number): FileUIPart {
  return { type: 'file', mediaType: 'image/png', url: `/api/files/file_${index}`, filename: `image-${index}.png` }
}

describe('imageGallery', () => {
  it('renders its root with the message id and the image count, without a Pinia (store-free for the share page)', () => {
    const images = [image(1), image(2)]
    const wrapper = mount(ImageGallery, { props: { images, messageId: MESSAGE_ID } })
    const root = wrapper.get(`[data-testid="${testIds.imageGallery}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-message-id')).toBe(MESSAGE_ID)
    expect(root.attributes('data-count')).toBe('2')
    expect(wrapper.props('images')).toEqual(images)
    wrapper.unmount()
  })

  it('accepts share URLs and parts without a filename', () => {
    const images: FileUIPart[] = [{ type: 'file', mediaType: 'image/webp', url: '/api/share/token/files/file_1' }]
    const wrapper = mount(ImageGallery, { props: { images, messageId: 'share-message-3' } })
    const root = wrapper.get(`[data-testid="${testIds.imageGallery}"]`)
    expect(root.attributes('data-message-id')).toBe('share-message-3')
    expect(root.attributes('data-count')).toBe('1')
    wrapper.unmount()
  })
})
