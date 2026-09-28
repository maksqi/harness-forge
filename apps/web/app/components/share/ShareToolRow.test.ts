// ShareToolRow (docs/UI.md 7.15): the tool row of a shared chat, static without tool details, expandable with them.
import type { ShareToolPart } from './share-view'
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import ShareToolRow from './ShareToolRow.vue'
import { byTestId, settle } from './testing'

function mountRow(part: ShareToolPart) {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(ShareToolRow, { part }) }) }, { attachTo: document.body })
}

beforeEach(() => {
  // Store-free: no Pinia at all.
  setActivePinia(undefined)
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('shareToolRow', () => {
  it('is a static row without tool details: name, outcome, no button and no body', () => {
    mountRow({ type: 'tool', toolName: 'web_fetch', status: 'done' })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.dataset.toolName).toBe('web_fetch')
    expect(row.dataset.status).toBe('done')
    expect(row.querySelector('button')).toBeNull()
    expect(row.querySelector('[aria-expanded]')).toBeNull()
    expect(row.textContent).toContain('web_fetch')
    expect(row.querySelector('.text-success')).not.toBeNull()
    expect(row.textContent).toContain('Done')
    expect(byTestId(testIds.shareToolRowOutput)).toBeNull()
  })

  it('shows every outcome: error, denied, stopped', () => {
    const labels = (['error', 'denied', 'stopped'] as const).map((status) => {
      const wrapper = mountRow({ type: 'tool', toolName: 'run', status })
      const row = byTestId(testIds.shareToolRow)!
      const cell = row.querySelector('.ml-auto')!
      const result = [status, row.dataset.status, cell.textContent?.trim(), cell.querySelector('.text-destructive') !== null]
      wrapper.unmount()
      return result
    })
    expect(labels).toEqual([
      ['error', 'error', 'Failed', true],
      ['denied', 'denied', 'Denied', false],
      ['stopped', 'stopped', 'Stopped', false],
    ])
  })

  it('names MCP tools by their tool name with a server badge', () => {
    mountRow({ type: 'tool', toolName: 'mcp__docs__search', status: 'done' })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.dataset.toolName).toBe('mcp__docs__search')
    expect(row.querySelector('.font-mono')?.textContent).toBe('search')
    expect(row.querySelector('[data-slot="badge"]')?.textContent?.trim()).toBe('docs')
  })

  it('expands Input, Output and the error with tool details, and shows the first argument', async () => {
    mountRow({
      type: 'tool',
      toolName: 'web_fetch',
      status: 'error',
      input: { url: 'https://nuxt.com/docs', depth: 2 },
      output: { status: 500 },
      errorText: 'Upstream failed.',
    })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('"https://nuxt.com/docs"')
    const button = row.querySelector('button')!
    expect(button.getAttribute('aria-expanded')).toBe('false')

    button.click()
    await settle()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const body = byTestId(testIds.shareToolRowOutput)!
    const blocks = Array.from(body.querySelectorAll<HTMLElement>('[data-slot="tool-value"]'))
    expect(blocks.map(block => block.dataset.label)).toEqual(['input', 'output', 'error'])
    expect(blocks[0]!.querySelector('pre')?.textContent).toContain('"url": "https://nuxt.com/docs"')
    expect(blocks[1]!.querySelector('pre')?.textContent).toContain('"status": 500')
    expect(blocks[2]!.querySelector('pre')?.textContent).toBe('Upstream failed.')
    expect(blocks[2]!.querySelector('pre')?.className).toContain('text-destructive')
  })

  it('notes values the server cut at the share limit', async () => {
    mountRow({ type: 'tool', toolName: 'read', status: 'done', input: { path: 'a.txt' }, output: '{"text": "aaaa\n[truncated]' })
    byTestId(testIds.shareToolRow)!.querySelector('button')!.click()
    await settle()
    const blocks = Array.from(byTestId(testIds.shareToolRowOutput)!.querySelectorAll<HTMLElement>('[data-slot="tool-value"]'))
    expect(blocks.map(block => block.querySelector('[data-slot="server-truncated"]') !== null)).toEqual([false, true])
  })

  it('shows the prompt of generate_image as its first argument', () => {
    mountRow({
      type: 'tool',
      toolName: 'generate_image',
      status: 'done',
      input: { aspectRatio: '16:9', n: 2, prompt: 'A red fox in the snow' },
      output: { modelRef: 'mock:image', images: [{ fileId: 'file_AAAAAAAAAAAAAAAA', url: '/api/files/file_AAAAAAAAAAAAAAAA', mediaType: 'image/png', name: 'image-1.png' }] },
    })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('"A red fox in the snow"')
    expect(row.textContent).not.toContain('16:9')
  })

  it('shows "{}" for an empty shared input and a string output as is', async () => {
    mountRow({ type: 'tool', toolName: 'now', status: 'done', input: {}, output: '12:00' })
    const row = byTestId(testIds.shareToolRow)!
    row.querySelector('button')!.click()
    await settle()
    const blocks = Array.from(byTestId(testIds.shareToolRowOutput)!.querySelectorAll('pre')).map(pre => pre.textContent)
    expect(blocks).toEqual(['{}', '12:00'])
  })
})
