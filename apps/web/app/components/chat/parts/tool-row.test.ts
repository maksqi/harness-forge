import { describe, expect, it } from 'vitest'
import { toolRowArgument } from './tool-row'

describe('toolRowArgument', () => {
  it('reads the prompt of generate_image, whatever the key order', () => {
    expect(toolRowArgument('generate_image', { aspectRatio: '16:9', n: 2, prompt: 'A red fox' })).toBe('A red fox')
    expect(toolRowArgument('generate_image', { prompt: `Line one\n  line ${'x'.repeat(80)}` })).toMatch(/^Line one line x+…$/)
    expect(toolRowArgument('generate_image', { prompt: 'Line one' })?.length).toBeLessThanOrEqual(60)
  })

  it('falls back to the first string value', () => {
    expect(toolRowArgument('generate_image', { aspectRatio: '1:1', prompt: '   ' })).toBe('1:1')
    expect(toolRowArgument('generate_image', null)).toBeNull()
    expect(toolRowArgument('web_fetch', { depth: 2, url: 'https://nuxt.com' })).toBe('https://nuxt.com')
    expect(toolRowArgument('mcp__img__generate_image', { size: 'big', prompt: 'x' })).toBe('big')
  })
})
