// The gallery of generated images (docs/UI.md 7.16, 10.4): layout by count, tiles, the lightbox (keys, ends, counter,
// Download), focus return, safe URLs, and no store (the share page renders it too).
import type { FileUIPart } from 'ai'
import { flushPromises, mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { testIds } from '~/utils/testids'
import ImageGallery from './ImageGallery.vue'

const MESSAGE_ID = 'msg_assistant0000001'

function image(index: number, overrides: Partial<FileUIPart> = {}): FileUIPart {
  return { type: 'file', mediaType: 'image/png', url: `/api/files/file_${index}`, filename: `image-${index}.png`, ...overrides }
}

let wrapper: { unmount: () => void } | null = null

function mountGallery(images: FileUIPart[], messageId = MESSAGE_ID) {
  const mounted = mount(ImageGallery, { props: { images, messageId }, attachTo: document.body })
  wrapper = mounted
  return mounted
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function allByTestId<T extends HTMLElement = HTMLElement>(id: string): T[] {
  return Array.from(document.body.querySelectorAll<T>(`[data-testid="${id}"]`))
}

function lightbox(): HTMLElement | null {
  return byTestId(testIds.imageLightbox)
}

async function settle() {
  for (let round = 0; round < 3; round++) {
    await flushPromises()
    await nextTick()
  }
}

async function openTile(index: number) {
  allByTestId<HTMLButtonElement>(testIds.imageTile)[index]!.click()
  await settle()
}

async function press(key: string) {
  lightbox()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await settle()
}

beforeEach(() => {
  // No active Pinia: any store in the tree would throw (the share page is store-free).
  setActivePinia(undefined)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

describe('imageGallery: layout', () => {
  it('renders its root with the message id and the image count', () => {
    const images = [image(1), image(2)]
    const gallery = mountGallery(images)
    const root = gallery.get(`[data-testid="${testIds.imageGallery}"]`)
    expect(root.element).toBe(gallery.element)
    expect(root.attributes('data-message-id')).toBe(MESSAGE_ID)
    expect(root.attributes('data-count')).toBe('2')
    expect(gallery.props('images')).toEqual(images)
  })

  it('shows one image at the full column width, at most 70dvh tall', () => {
    mountGallery([image(1)])
    const root = byTestId(testIds.imageGallery)!
    expect(root.classList.contains('grid-cols-2')).toBe(false)
    const tiles = allByTestId(testIds.imageTile)
    expect(tiles).toHaveLength(1)
    const img = tiles[0]!.querySelector('img')!
    expect(img.className).toContain('w-full')
    expect(img.className).toContain('max-h-[70dvh]')
    expect(img.className).toContain('object-contain')
  })

  it.each([2, 3, 4])('shows %i images in two columns, labelled in order', (count) => {
    mountGallery(Array.from({ length: count }, (_, index) => image(index + 1)))
    expect(byTestId(testIds.imageGallery)!.classList.contains('grid-cols-2')).toBe(true)
    const tiles = allByTestId<HTMLButtonElement>(testIds.imageTile)
    expect(tiles.map(tile => tile.dataset.index)).toEqual(Array.from({ length: count }, (_, index) => String(index)))
    tiles.forEach((tile, index) => {
      expect(tile.tagName).toBe('BUTTON')
      expect(tile.getAttribute('aria-label')).toBe(`Open image ${index + 1} of ${count}`)
      const img = tile.querySelector('img')!
      expect(img.getAttribute('alt')).toBe(`Generated image ${index + 1} of ${count}`)
      expect(img.getAttribute('src')).toBe(`/api/files/file_${index + 1}`)
      expect(img.getAttribute('loading')).toBe('lazy')
      expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
      expect(img.className).not.toContain('max-h-[70dvh]')
    })
  })

  it('accepts share URLs and parts without a filename', () => {
    mountGallery([{ type: 'file', mediaType: 'image/webp', url: '/api/share/token/files/file_1' }], 'share-message-3')
    const root = byTestId(testIds.imageGallery)!
    expect(root.dataset.messageId).toBe('share-message-3')
    expect(root.dataset.count).toBe('1')
    expect(byTestId(testIds.imageTile)!.querySelector('img')!.getAttribute('src')).toBe('/api/share/token/files/file_1')
  })

  it('leaves out images whose URL is not safe', () => {
    mountGallery([image(1, { url: 'javascript:alert(1)' }), image(2), image(3, { url: '//evil.example/x.png' })])
    expect(byTestId(testIds.imageGallery)!.dataset.count).toBe('1')
    const tiles = allByTestId(testIds.imageTile)
    expect(tiles).toHaveLength(1)
    expect(tiles[0]!.getAttribute('aria-label')).toBe('Open image 1 of 1')
    expect(document.body.innerHTML).not.toContain('javascript:')
  })
})

describe('imageGallery: lightbox', () => {
  it('opens on the clicked image with the counter and the Download link', async () => {
    mountGallery([image(1), image(2), image(3)])
    expect(lightbox()).toBeNull()
    await openTile(1)
    const box = lightbox()!
    expect(box.dataset.index).toBe('1')
    expect(box.getAttribute('role')).toBe('dialog')
    const img = box.querySelector('img')!
    expect(img.getAttribute('src')).toBe('/api/files/file_2')
    expect(img.getAttribute('alt')).toBe('Generated image 2 of 3')
    expect(box.textContent).toContain('2 / 3')
    const download = byTestId<HTMLAnchorElement>(testIds.imageDownload)!
    expect(download.tagName).toBe('A')
    expect(download.getAttribute('href')).toBe('/api/files/file_2')
    expect(download.getAttribute('download')).toBe('image-2.png')
    expect(download.textContent?.trim()).toBe('Download')
    // Opening lands on Next image.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Next image')
  })

  it('moves with ArrowLeft / ArrowRight and the buttons, which are disabled at the ends', async () => {
    mountGallery([image(1), image(2), image(3)])
    await openTile(0)
    const previous = () => lightbox()!.querySelector<HTMLButtonElement>('[aria-label="Previous image"]')!
    const next = () => lightbox()!.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!
    expect(previous().getAttribute('aria-disabled')).toBe('true')
    expect(next().getAttribute('aria-disabled')).toBeNull()

    await press('ArrowLeft')
    expect(lightbox()!.dataset.index).toBe('0')
    await press('ArrowRight')
    expect(lightbox()!.dataset.index).toBe('1')
    expect(previous().getAttribute('aria-disabled')).toBeNull()
    next().click()
    await settle()
    expect(lightbox()!.dataset.index).toBe('2')
    expect(lightbox()!.querySelector('img')!.getAttribute('src')).toBe('/api/files/file_3')
    expect(lightbox()!.textContent).toContain('3 / 3')
    expect(next().getAttribute('aria-disabled')).toBe('true')
    await press('ArrowRight')
    expect(lightbox()!.dataset.index).toBe('2')
    next().click()
    await settle()
    expect(lightbox()!.dataset.index).toBe('2')
    previous().click()
    await settle()
    expect(lightbox()!.dataset.index).toBe('1')
  })

  it('names downloads by the filename, else image-<n>.<ext>', async () => {
    mountGallery([
      image(1, { filename: undefined, mediaType: 'image/jpeg' }),
      image(2, { filename: 'fox.webp', mediaType: 'image/webp' }),
      image(3, { filename: '../../etc/passwd', mediaType: 'image/png' }),
    ])
    await openTile(0)
    expect(byTestId(testIds.imageDownload)!.getAttribute('download')).toBe('image-1.jpg')
    await press('ArrowRight')
    expect(byTestId(testIds.imageDownload)!.getAttribute('download')).toBe('fox.webp')
    await press('ArrowRight')
    expect(byTestId(testIds.imageDownload)!.getAttribute('download')).toBe('passwd')
  })

  it('offers no Download link for another origin', async () => {
    mountGallery([image(1, { url: 'https://cdn.example.com/a.png' })])
    await openTile(0)
    expect(lightbox()!.querySelector('img')!.getAttribute('src')).toBe('https://cdn.example.com/a.png')
    expect(byTestId(testIds.imageDownload)).toBeNull()
  })

  it('shows a single image without navigation', async () => {
    mountGallery([image(1)])
    await openTile(0)
    expect(lightbox()!.querySelector('[aria-label="Next image"]')).toBeNull()
    expect(lightbox()!.textContent).not.toContain('1 / 1')
    expect(byTestId(testIds.imageDownload)!.getAttribute('download')).toBe('image-1.png')
  })

  it('closes on Esc and returns focus to the tile it was opened from', async () => {
    mountGallery([image(1), image(2), image(3)])
    await openTile(1)
    await press('ArrowRight')
    expect(lightbox()!.dataset.index).toBe('2')
    await press('Escape')
    expect(lightbox()).toBeNull()
    expect(document.activeElement).toBe(allByTestId(testIds.imageTile)[1])
  })

  it('closes with the Close button', async () => {
    mountGallery([image(1), image(2)])
    await openTile(0)
    lightbox()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click()
    await settle()
    expect(lightbox()).toBeNull()
  })

  it('keeps the shown image in range when images go away', async () => {
    const gallery = mountGallery([image(1), image(2), image(3)])
    await openTile(2)
    await gallery.setProps({ images: [image(1)] })
    await settle()
    expect(lightbox()!.dataset.index).toBe('0')
    await gallery.setProps({ images: [] })
    await settle()
    expect(lightbox()).toBeNull()
  })
})
