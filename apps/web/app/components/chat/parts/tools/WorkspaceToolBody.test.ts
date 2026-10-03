// WorkspaceToolBody (docs/UI.md 7.19, 10.4; W7.11): one renderer per view kind, the server's diff totals in the diff
// header, the noun of an empty list, and the "Raw input and output" toggle around the caller's raw slot.
import type { WorkspaceToolView } from './workspace-tools'
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import TerminalOutput from './TerminalOutput.vue'
import WorkspaceToolBody from './WorkspaceToolBody.vue'

const views: Array<[WorkspaceToolView, string]> = [
  [{ kind: 'diff', path: 'a.txt', created: true, additions: 1, deletions: 0, hunks: [], truncated: false }, testIds.diffView],
  [{ kind: 'terminal', command: 'ls', output: null }, testIds.terminalOutput],
  [{ kind: 'file', path: 'a.txt', content: 'a\n', startLine: 1, endLine: 1, totalLines: 1, truncated: false }, testIds.fileContent],
  [{ kind: 'list', items: [{ path: 'a.txt', type: 'file' }], noun: 'entries', truncated: false }, testIds.fileList],
]

function mountBody(props: { view: WorkspaceToolView, running?: boolean }, slots: Record<string, () => unknown> = {}) {
  const wrapper = mount({
    render: () => h(TooltipProvider, null, { default: () => h(WorkspaceToolBody, props, slots) }),
  }, { attachTo: document.body })
  return { wrapper, body: wrapper.getComponent(WorkspaceToolBody) }
}

beforeEach(() => {
  setActivePinia(undefined)
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('workspaceToolBody', () => {
  it.each(views.map(([view, rootId]) => [view.kind, view, rootId] as const))('renders the %s view with its renderer', (_kind, view, rootId) => {
    const { wrapper, body } = mountBody({ view })
    expect(body.attributes('data-kind')).toBe(view.kind)
    const roots = [testIds.diffView, testIds.terminalOutput, testIds.fileContent, testIds.fileList]
      .filter(id => body.find(`[data-testid="${id}"]`).exists())
    expect(roots).toEqual([rootId])
    expect(body.props()).toEqual({ view, running: false })
    // No raw slot from the caller: no toggle.
    expect(body.find(`[data-testid="${testIds.toolRawToggle}"]`).exists()).toBe(false)
    wrapper.unmount()
  })

  it('passes running to the terminal', () => {
    const { wrapper, body } = mountBody({ view: { kind: 'terminal', command: 'sleep 1', output: null }, running: true })
    expect(body.getComponent(TerminalOutput).props('running')).toBe(true)
    wrapper.unmount()
  })

  it('shows the server totals in the diff header (they count cut hunks too)', () => {
    const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
    const { wrapper, body } = mountBody({ view: { kind: 'diff', path: 'a.txt', created: false, additions: 120, deletions: 40, hunks, truncated: true } })
    const diff = body.get(`[data-testid="${testIds.diffView}"]`)
    expect(diff.text()).toContain('+120')
    expect(diff.text()).toContain('−40')
    expect(diff.text()).toContain('Diff truncated by server')
    wrapper.unmount()
  })

  it.each([
    ['entries', 'The folder is empty.'],
    ['files', 'No files match.'],
    ['matches', 'No matches.'],
  ] as const)('names an empty list of %s', (noun, text) => {
    const { wrapper, body } = mountBody({ view: { kind: 'list', items: [], noun, truncated: false } })
    expect(body.get(`[data-testid="${testIds.fileList}"]`).text()).toBe(text)
    wrapper.unmount()
  })

  it('toggles the raw input and output of the caller', async () => {
    const { wrapper, body } = mountBody(
      { view: { kind: 'terminal', command: 'ls', output: null } },
      { raw: () => h('pre', { 'data-slot': 'raw-blocks' }, '{"command": "ls"}') },
    )
    const toggle = body.get(`[data-testid="${testIds.toolRawToggle}"]`)
    expect(toggle.text()).toBe('Raw input and output')
    expect(toggle.attributes('data-state')).toBe('closed')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(body.find('[data-slot="raw-blocks"]').exists()).toBe(false)

    await toggle.trigger('click')
    expect(toggle.attributes('data-state')).toBe('open')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const raw = body.get('[data-slot="raw-blocks"]')
    expect(raw.text()).toBe('{"command": "ls"}')
    expect(toggle.attributes('aria-controls')).toBe(body.get('[data-slot="tool-raw"]').attributes('id'))

    await toggle.trigger('click')
    expect(body.find('[data-slot="raw-blocks"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
