// ToolApprovalPreview skeleton (docs/UI.md 7.3, 7.19, 10.4; C15, P7-0b): nothing without an approval view (the card
// keeps its JSON block), else the root with data-kind diff | content | command. W7.11 adds the content.
import type { WorkspaceToolView } from './workspace-tools'
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import ToolApprovalPreview from './ToolApprovalPreview.vue'

const registry = vi.hoisted(() => ({ view: vi.fn((): WorkspaceToolView | null => null) }))
vi.mock('./workspace-tools', () => ({ workspaceApprovalView: registry.view }))

const root = `[data-testid="${testIds.toolApprovalPreview}"]`

beforeEach(() => {
  setActivePinia(undefined)
  registry.view.mockReset()
  registry.view.mockReturnValue(null)
})

describe('toolApprovalPreview', () => {
  it('renders nothing when there is no approval view', () => {
    const input = { name: 'Ada' }
    const wrapper = mount(ToolApprovalPreview, { props: { toolName: 'get_weather', input } })
    expect(wrapper.find(root).exists()).toBe(false)
    expect(registry.view).toHaveBeenCalledWith('get_weather', input)
    expect(wrapper.props()).toEqual({ toolName: 'get_weather', input })
    wrapper.unmount()
  })

  it.each([
    ['diff', { kind: 'diff', path: 'a.txt', created: false, additions: 1, deletions: 1, hunks: [], truncated: false }],
    ['content', { kind: 'file', path: 'a.txt', content: 'a\n', startLine: 1, endLine: 1, totalLines: 1, truncated: false }],
    ['command', { kind: 'terminal', command: 'ls', output: null }],
  ] satisfies Array<[string, WorkspaceToolView]>)('renders its root with data-kind %s', (kind, view) => {
    registry.view.mockReturnValue(view)
    const wrapper = mount(ToolApprovalPreview, { props: { toolName: 'edit_file', input: {} } })
    const preview = wrapper.get(root)
    expect(preview.element).toBe(wrapper.element)
    expect(preview.attributes('data-kind')).toBe(kind)
    wrapper.unmount()
  })
})
