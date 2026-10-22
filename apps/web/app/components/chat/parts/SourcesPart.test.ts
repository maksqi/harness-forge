// SourcesPart (Phase 14, ADR-062; docs/UI.md 7.1, 7.35, 14; W14.9): the trigger's accessible name ("{n} sources: {a},
// {b} and {m} more"), up to three domain chips (two below `sm`, each width with its own "+{m}"), and the expanded sources
// (`source-item`, `data-domain`) with their letter avatars instead of favicons. The C54 chip tests stay in parts.test.ts.
import { flushPromises, mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import SourcesPart from './SourcesPart.vue'
import { sourceAvatar } from './web-search'

type SourcesProps = InstanceType<typeof SourcesPart>['$props']

function mountSources(parts: SourcesProps['parts']) {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(SourcesPart, { parts }) }) }, { attachTo: document.body })
}

function urlParts(urls: string[]): SourcesProps['parts'] {
  return urls.map((url, index) => ({ type: 'source-url' as const, sourceId: `s${index}`, url, title: `Title ${index + 1}` }))
}

beforeEach(() => {
  // Store-free (also on share pages).
  setActivePinia(undefined)
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('sourcesPart: the trigger (W14.9)', () => {
  it('is named "{n} sources: {a}, {b}, {c} and {m} more"; two chips and their own "+{m}" below sm', () => {
    const wrapper = mountSources(urlParts(['https://github.com/a', 'https://modelcontextprotocol.io/b', 'https://vercel.com/c', 'https://example.org/d', 'https://example.net/e']))
    const trigger = wrapper.get(`[data-testid="${testIds.sourcesRow}"]`)
    expect(trigger.attributes('aria-label')).toBe('5 sources: github.com, modelcontextprotocol.io, vercel.com and 2 more')
    const chips = trigger.findAll(`[data-testid="${testIds.sourcesChip}"]`)
    expect(chips.map(chip => chip.attributes('data-domain'))).toEqual(['github.com', 'modelcontextprotocol.io', 'vercel.com'])
    // The third chip hides below sm, where "+3" replaces "+2".
    expect(chips[2]!.classes()).toContain('max-sm:hidden')
    expect(chips[0]!.classes()).not.toContain('max-sm:hidden')
    expect(trigger.get('[data-slot="sources-more"]').text()).toBe('+2')
    expect(trigger.get('[data-slot="sources-more"]').classes()).toContain('max-sm:hidden')
    expect(trigger.get('[data-slot="sources-more-narrow"]').text()).toBe('+3')
    expect(trigger.get('[data-slot="sources-more-narrow"]').classes()).toContain('sm:hidden')
  })

  it('names one source without "and more", and only the count without http(s) sources', () => {
    expect(mountSources(urlParts(['https://www.nuxt.com/docs'])).get(`[data-testid="${testIds.sourcesRow}"]`).attributes('aria-label')).toBe('1 source: nuxt.com')
    const documents = mountSources([{ type: 'source-document', sourceId: 'd1', mediaType: 'application/pdf', title: 'Spec', filename: 'spec.pdf' }])
    expect(documents.get(`[data-testid="${testIds.sourcesRow}"]`).attributes('aria-label')).toBe('1 source')
  })
})

describe('sourcesPart: the expanded list (W14.9)', () => {
  it('shows a letter avatar, the title link and the domain per source; documents keep their icon', async () => {
    const wrapper = mountSources([
      ...urlParts(['https://www.github.com/x', 'https://modelcontextprotocol.io/spec']),
      { type: 'source-url', sourceId: 'bad', url: 'javascript:alert(1)', title: 'Evil' },
      { type: 'source-document', sourceId: 'd1', mediaType: 'application/pdf', title: 'Spec', filename: 'spec.pdf' },
    ])
    await wrapper.get(`[data-testid="${testIds.sourcesRow}"]`).trigger('click')
    await flushPromises()
    const items = wrapper.findAll(`[data-testid="${testIds.sourceItem}"]`)
    expect(items).toHaveLength(4)
    expect(items.map(item => item.attributes('data-domain') ?? null)).toEqual(['github.com', 'modelcontextprotocol.io', null, null])
    const first = items[0]!
    expect(first.element.tagName).toBe('A')
    expect(first.attributes()).toMatchObject({ href: 'https://www.github.com/x', target: '_blank', rel: 'noopener noreferrer' })
    expect(first.text()).toContain('Title 1')
    expect(first.text()).toContain('github.com')
    const avatar = first.get('[data-slot="avatar"]')
    expect(avatar.attributes('aria-hidden')).toBe('true')
    expect(avatar.text()).toBe('G')
    expect(avatar.get('[data-slot="avatar-fallback"]').classes()).toContain(`bg-${sourceAvatar('github.com').token}/15`)
    // No external image anywhere (the CSP blocks favicons).
    expect(wrapper.find('img').exists()).toBe(false)
    // A non-http(s) source is not a link; a document keeps its file name.
    expect(items[2]!.element.tagName).toBe('SPAN')
    expect(items[2]!.text()).toContain('Evil')
    expect(items[3]!.text()).toContain('spec.pdf')
    expect(items[3]!.find('[data-slot="avatar"]').exists()).toBe(false)
  })
})
