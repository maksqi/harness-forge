import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isAllowedMarkdownLink } from '~/components/chat/parts/markdown/markdown-options'
import Markdown from './Markdown.vue'

vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark', preference: 'dark' }),
  useRoute: () => ({ path: '/', fullPath: '/', params: {}, query: {} }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  navigateTo: vi.fn(),
}))

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function render(content: string, final = true) {
  const wrapper = mount({
    render: () => h(TooltipProvider, null, { default: () => h(Markdown, { content, final }) }),
  }, { attachTo: document.body })
  await settle()
  return wrapper
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('markdown: text is verbatim', () => {
  it('keeps straight quotes, dashes and ellipses (no typographer)', async () => {
    const wrapper = await render('Tool result: {"echoed":"it\'s"} -- (c) 1...2\n\nInline `"x" -- y` too.')
    expect(wrapper.text()).toContain('{"echoed":"it\'s"} -- (c) 1...2')
    expect(wrapper.text()).toContain('"x" -- y')
    expect(wrapper.text()).not.toMatch(/[\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A9]/)
    wrapper.unmount()
  })
})

describe('markdown: raw HTML is inert', () => {
  it('renders <script> as text', async () => {
    const wrapper = await render('Hello <script>alert(1)</script> world')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('<script>alert(1)</script>')
    wrapper.unmount()
  })

  it('renders <img onerror> and inline handlers as text', async () => {
    const wrapper = await render('<img src=x onerror="alert(2)">\n\n<div onclick="alert(3)">block</div>')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[onerror]').exists()).toBe(false)
    expect(wrapper.find('[onclick]').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror="alert(2)">')
    expect(wrapper.text()).toContain('<div onclick="alert(3)">')
    wrapper.unmount()
  })

  it('renders raw HTML anchors as their literal text', async () => {
    const wrapper = await render('<a href="javascript:alert(4)">x</a> <a href="/api/chats">y</a> <A HREF="https://evil.example">z</A>')
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).toContain('<a href="javascript:alert(4)">x</a>')
    expect(wrapper.text()).toContain('<a href="/api/chats">y</a>')
    wrapper.unmount()
  })

  it('renders iframes, styles and svg as text', async () => {
    const wrapper = await render('<iframe src="https://evil.example"></iframe>\n\n<style>body{display:none}</style>\n\n<svg onload="alert(5)"></svg>')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.find('style').exists()).toBe(false)
    expect(wrapper.find('svg[onload]').exists()).toBe(false)
    expect(wrapper.text()).toContain('<style>body{display:none}</style>')
    wrapper.unmount()
  })
})

describe('markdown: links', () => {
  it('keeps javascript:, data:, relative and other targets as plain text', async () => {
    const wrapper = await render('[one](javascript:alert) [two](data:text/html,x) [three](/api/files/x) [four](ftp://host/x)')
    expect(wrapper.findAll('a')).toHaveLength(0)
    expect(wrapper.text()).toContain('one')
    expect(wrapper.text()).toContain('three')
    expect(wrapper.text()).toContain('four')
    wrapper.unmount()
  })

  it('opens http(s) links in a new tab without opener or referrer', async () => {
    const wrapper = await render('See [the docs](https://nuxt.com/docs) or <https://example.com/a>.')
    const links = wrapper.findAll('a')
    expect(links.map(link => link.attributes('href'))).toEqual(['https://nuxt.com/docs', 'https://example.com/a'])
    for (const link of links) {
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')?.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']))
    }
    wrapper.unmount()
  })

  it('keeps links inside lists and tables under the same policy', async () => {
    const wrapper = await render('- [ok](https://ok.example) and [no](/x)\n\n| a |\n|---|\n| [bad](javascript:x) [good](https://g.example) |')
    expect(wrapper.findAll('a').map(link => link.attributes('href'))).toEqual(['https://ok.example', 'https://g.example'])
    wrapper.unmount()
  })

  it('allows mailto links', async () => {
    const wrapper = await render('[mail me](mailto:someone@example.com)')
    expect(wrapper.get('a').attributes('href')).toBe('mailto:someone@example.com')
    wrapper.unmount()
  })

  it('validates link schemes', () => {
    expect(isAllowedMarkdownLink('https://example.com')).toBe(true)
    expect(isAllowedMarkdownLink('HTTP://example.com')).toBe(true)
    expect(isAllowedMarkdownLink('mailto:a@b.c')).toBe(true)
    expect(isAllowedMarkdownLink('javascript:alert(1)')).toBe(false)
    expect(isAllowedMarkdownLink(' javascript:alert(1)')).toBe(false)
    expect(isAllowedMarkdownLink('java\nscript:alert(1)')).toBe(false)
    expect(isAllowedMarkdownLink('/relative')).toBe(false)
    expect(isAllowedMarkdownLink('//evil.example')).toBe(false)
    expect(isAllowedMarkdownLink('https://exa mple.com')).toBe(false)
    expect(isAllowedMarkdownLink(undefined)).toBe(false)
  })
})

describe('markdown: images', () => {
  it('renders http(s) images lazily without a referrer and drops unsafe sources', async () => {
    const wrapper = await render('![chart](https://example.com/chart.png)\n\n![evil](javascript:alert(5))')
    const images = wrapper.findAll('img')
    expect(images).toHaveLength(1)
    expect(images[0]!.attributes('src')).toBe('https://example.com/chart.png')
    expect(images[0]!.attributes('loading')).toBe('lazy')
    expect(images[0]!.attributes('referrerpolicy')).toBe('no-referrer')
    wrapper.unmount()
  })
})

describe('markdown: code blocks', () => {
  it('renders fences as text with a language label and a copy button', async () => {
    const wrapper = await render('```ts\nconst html = "<b>x</b>"\n```')
    const block = wrapper.get('[data-slot="markdown-code"]')
    expect(block.attributes('data-language')).toBe('ts')
    expect(block.text()).toContain('const html = "<b>x</b>"')
    expect(block.find('b').exists()).toBe(false)
    expect(block.find('button[aria-label="Copy code"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('highlights complete fences with dual-theme CSS variables', async () => {
    const wrapper = await render('```json\n{ "a": 1 }\n```')
    const block = () => wrapper.get('[data-slot="markdown-code"]')
    for (let i = 0; i < 100 && block().attributes('data-highlighted') !== 'true'; i++)
      await settle(1)
    expect(block().attributes('data-highlighted')).toBe('true')
    const styled = block().findAll('.hf-code-token').find(token => token.attributes('style')?.includes('--shiki-dark'))
    expect(styled?.attributes('style')).toContain('--shiki-light')
    expect(block().text()).toContain('{ "a": 1 }')
    wrapper.unmount()
  }, 20_000)

  it('does not highlight a fence that is still streaming', async () => {
    const wrapper = await render('```json\n{ "a": ', false)
    const block = wrapper.find('[data-slot="markdown-code"]')
    if (block.exists())
      expect(block.attributes('data-highlighted')).toBe('false')
    expect(wrapper.text()).toContain('{ "a":')
    wrapper.unmount()
  })
})

describe('markdown: no v-html', () => {
  it('no chat or markdown component renders HTML strings', () => {
    const sources = import.meta.glob(['../chat/**/*.vue', './Markdown.vue'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const entries = Object.entries(sources)
    expect(entries.length).toBeGreaterThan(1)
    for (const [file, source] of entries)
      expect(source, file).not.toMatch(/\bv-html\b|\binnerHTML\b/)
  })
})
