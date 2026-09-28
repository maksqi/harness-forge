import { describe, expect, it } from 'vitest'
import { aspectRatioCss, downloadableUrl, galleryImages, generatingCaption, imageDownloadName, imageExtension } from './image-gallery'

describe('image gallery helpers', () => {
  it('turns an aspect ratio into CSS, Auto into a square', () => {
    expect(aspectRatioCss('16:9')).toBe('16 / 9')
    expect(aspectRatioCss('2:3')).toBe('2 / 3')
    expect(aspectRatioCss(undefined)).toBe('1 / 1')
  })

  it('counts whole seconds in the generating caption, never below zero', () => {
    expect(generatingCaption(1, 0)).toBe('Generating image… 0s')
    expect(generatingCaption(1, 12_999)).toBe('Generating image… 12s')
    expect(generatingCaption(2, 3_000)).toBe('Generating 2 images… 3s')
    expect(generatingCaption(4, -5_000)).toBe('Generating 4 images… 0s')
    expect(generatingCaption(1, Number.NaN)).toBe('Generating image… 0s')
  })

  it('picks the extension of an image type', () => {
    expect(imageExtension('image/png')).toBe('png')
    expect(imageExtension('image/jpeg')).toBe('jpg')
    expect(imageExtension('IMAGE/WEBP; q=1')).toBe('webp')
    expect(imageExtension('image/svg+xml')).toBe('svg')
    expect(imageExtension('image/x-icon')).toBe('xicon')
    expect(imageExtension('application/octet-stream')).toBe('png')
  })

  it('names a download by its filename (never a path), else image-<n>.<ext>', () => {
    expect(imageDownloadName({ mediaType: 'image/png', filename: 'image-1.png' }, 0)).toBe('image-1.png')
    expect(imageDownloadName({ mediaType: 'image/png', filename: 'a/b\\c.png' }, 0)).toBe('c.png')
    expect(imageDownloadName({ mediaType: 'image/gif', filename: '  ' }, 2)).toBe('image-3.gif')
    expect(imageDownloadName({ mediaType: 'image/jpeg' }, 0)).toBe('image-1.jpg')
  })

  it('allows downloads from the same origin only', () => {
    const origin = 'http://127.0.0.1:8787'
    expect(downloadableUrl('/api/files/file_1', origin)).toBe('/api/files/file_1')
    expect(downloadableUrl('/api/share/t/files/f', origin)).toBe('/api/share/t/files/f')
    expect(downloadableUrl('http://127.0.0.1:8787/api/files/f', origin)).toBe('http://127.0.0.1:8787/api/files/f')
    expect(downloadableUrl('blob:http://127.0.0.1:8787/x', origin)).toBe('blob:http://127.0.0.1:8787/x')
    expect(downloadableUrl('data:image/png;base64,AAAA', origin)).toBe('data:image/png;base64,AAAA')
    expect(downloadableUrl('https://cdn.example.com/a.png', origin)).toBeNull()
    expect(downloadableUrl('//evil.example/a.png', origin)).toBeNull()
    expect(downloadableUrl('javascript:alert(1)', origin)).toBeNull()
    expect(downloadableUrl(null, origin)).toBeNull()
  })

  it('labels the usable tiles in order', () => {
    const tiles = galleryImages([
      { type: 'file', mediaType: 'image/png', url: '/api/files/a', filename: 'image-1.png' },
      { type: 'file', mediaType: 'image/png', url: 'javascript:void(0)' },
      { type: 'file', mediaType: 'image/jpeg', url: '/api/files/b' },
    ])
    expect(tiles).toEqual([
      { url: '/api/files/a', mediaType: 'image/png', alt: 'Generated image 1 of 2', label: 'Open image 1 of 2', downloadUrl: '/api/files/a', downloadName: 'image-1.png' },
      { url: '/api/files/b', mediaType: 'image/jpeg', alt: 'Generated image 2 of 2', label: 'Open image 2 of 2', downloadUrl: '/api/files/b', downloadName: 'image-2.jpg' },
    ])
  })
})
