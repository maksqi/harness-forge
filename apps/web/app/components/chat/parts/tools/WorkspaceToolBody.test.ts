// WorkspaceToolBody skeleton (docs/UI.md 7.19, 10.4; C15, P7-0b): one renderer per view kind. W7.11 adds the raw
// input and output toggle.
import type { WorkspaceToolView } from './workspace-tools'
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import TerminalOutput from './TerminalOutput.vue'
import WorkspaceToolBody from './WorkspaceToolBody.vue'

const views: Array<[WorkspaceToolView, string]> = [
  [{ kind: 'diff', path: 'a.txt', created: true, additions: 1, deletions: 0, hunks: [], truncated: false }, testIds.diffView],
  [{ kind: 'terminal', command: 'ls', output: null }, testIds.terminalOutput],
  [{ kind: 'file', path: 'a.txt', content: 'a\n', startLine: 1, endLine: 1, totalLines: 1, truncated: false }, testIds.fileContent],
  [{ kind: 'list', items: [{ path: 'a.txt', type: 'file' }], noun: 'entries', truncated: false }, testIds.fileList],
]

beforeEach(() => {
  setActivePinia(undefined)
})

describe('workspaceToolBody', () => {
  it.each(views.map(([view, rootId]) => [view.kind, view, rootId] as const))('renders the %s view with its renderer', (_kind, view, rootId) => {
    const wrapper = mount(WorkspaceToolBody, { props: { view } })
    expect(wrapper.attributes('data-kind')).toBe(view.kind)
    const roots = [testIds.diffView, testIds.terminalOutput, testIds.fileContent, testIds.fileList]
      .filter(id => wrapper.find(`[data-testid="${id}"]`).exists())
    expect(roots).toEqual([rootId])
    expect(wrapper.props()).toEqual({ view, running: false })
    wrapper.unmount()
  })

  it('passes running to the terminal', () => {
    const wrapper = mount(WorkspaceToolBody, { props: { view: { kind: 'terminal', command: 'sleep 1', output: null }, running: true } })
    expect(wrapper.getComponent(TerminalOutput).props('running')).toBe(true)
    wrapper.unmount()
  })
})
