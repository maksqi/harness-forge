import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { hashHue, monogramLetters, resolveProviderIcon } from './provider-icon'
import ProviderIcon from './ProviderIcon.vue'

const MONO = '/api/icons/lobe/anthropic'
const COLOR = '/api/icons/lobe/anthropic-color'

describe('providerIcon', () => {
  it('renders the mono icon as a CSS mask over the text color', () => {
    const wrapper = mount(ProviderIcon, { props: { name: 'Anthropic', icon: { mono: MONO, color: COLOR } } })
    const root = wrapper.get('[data-slot="provider-icon"]')
    expect(root.attributes('data-kind')).toBe('mono')
    expect(root.attributes('role')).toBe('img')
    expect(root.attributes('aria-label')).toBe('Anthropic')
    const glyph = root.get('span.hf-icon-mask')
    expect(glyph.attributes('style')).toContain(`--hf-icon: url("${MONO}")`)
    expect(glyph.attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('svg').exists()).toBe(false)
  })

  it('renders the color icon as an <img> on a muted tile', () => {
    const wrapper = mount(ProviderIcon, {
      props: { name: 'OpenAI', icon: { mono: MONO, color: COLOR }, variant: 'color', size: 'lg' },
    })
    const root = wrapper.get('[data-slot="provider-icon"]')
    expect(root.attributes('data-kind')).toBe('color')
    expect(root.classes()).toContain('bg-muted')
    const img = wrapper.get('img')
    expect(img.attributes('src')).toBe(COLOR)
    expect(img.attributes('alt')).toBe('')
    expect(img.attributes('loading')).toBe('lazy')
  })

  it('falls back from auto to color when there is no mono icon', () => {
    const wrapper = mount(ProviderIcon, { props: { name: 'Groq', icon: { color: COLOR } } })
    expect(wrapper.get('[data-slot="provider-icon"]').attributes('data-kind')).toBe('color')
  })

  it('falls back to a monogram with a hashed hue', () => {
    const wrapper = mount(ProviderIcon, { props: { name: 'Together AI', id: 'together-ai', icon: null } })
    const root = wrapper.get('[data-slot="provider-icon"]')
    expect(root.attributes('data-kind')).toBe('monogram')
    expect(root.classes()).toContain('hf-monogram')
    expect(root.text()).toBe('TA')
    expect(root.attributes('style')).toContain(`--hf-hue: ${hashHue('together-ai')}`)
  })

  it('uses one letter for the small monogram', () => {
    const wrapper = mount(ProviderIcon, { props: { name: 'Together AI', size: 'sm' } })
    expect(wrapper.text()).toBe('T')
  })

  it('never renders raw HTML from the name or the URLs', () => {
    const name = '<img src=x onerror="alert(1)">'
    const wrapper = mount(ProviderIcon, { props: { name, icon: { mono: 'javascript:alert(1)' } } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-slot="provider-icon"]').attributes('data-kind')).toBe('monogram')
    expect(wrapper.get('[data-slot="provider-icon"]').attributes('aria-label')).toBe(name)
    expect(wrapper.html()).not.toContain('onerror="alert(1)"')
    expect(wrapper.html()).not.toContain('javascript:')
  })

  it('escapes quotes so a URL cannot break out of url("...")', () => {
    const wrapper = mount(ProviderIcon, { props: { name: 'X', icon: { mono: '/api/icons/lobe/x");background:red;("' } } })
    const style = wrapper.get('span.hf-icon-mask').attributes('style') ?? ''
    expect(style).not.toContain('");background')
  })
})

describe('provider icon helpers', () => {
  it('orders renderings by variant', () => {
    const icon = { mono: MONO, color: COLOR }
    expect(resolveProviderIcon(icon, 'auto')).toEqual({ kind: 'mono', url: MONO })
    expect(resolveProviderIcon(icon, 'color')).toEqual({ kind: 'color', url: COLOR })
    expect(resolveProviderIcon({ color: COLOR }, 'mono')).toEqual({ kind: 'monogram' })
    expect(resolveProviderIcon(icon, 'auto', new Set([MONO]))).toEqual({ kind: 'color', url: COLOR })
  })

  it('rejects unsafe URLs', () => {
    expect(resolveProviderIcon({ mono: '//evil.example/x.svg' }, 'auto')).toEqual({ kind: 'monogram' })
    expect(resolveProviderIcon({ mono: '/\\evil.example/x.svg' }, 'auto')).toEqual({ kind: 'monogram' })
    expect(resolveProviderIcon({ color: 'data:text/html,hi' }, 'color')).toEqual({ kind: 'monogram' })
  })

  it('builds monogram letters and stable hues', () => {
    expect(monogramLetters('anthropic')).toBe('A')
    expect(monogramLetters('lm-studio')).toBe('LS')
    expect(monogramLetters('  ')).toBe('?')
    expect(hashHue('openai')).toBe(hashHue('openai'))
    expect(hashHue('openai')).toBeGreaterThanOrEqual(0)
    expect(hashHue('openai')).toBeLessThan(360)
  })
})
