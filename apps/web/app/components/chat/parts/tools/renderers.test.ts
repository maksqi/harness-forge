// Workspace tool renderer skeletons (docs/UI.md 7.19, 10.4; C15, P7-0b): DiffView, TerminalOutput, FileContent and
// FileList render their root test ids with the documented data attributes and accept their final props; store-free
// (the share page renders them too). W7.11 adds the content.
import type { ShellOutput } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import DiffView from './DiffView.vue'
import FileContent from './FileContent.vue'
import FileList from './FileList.vue'
import TerminalOutput from './TerminalOutput.vue'

const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-mock agent', '+workspace agent'] }

function shell(overrides: Partial<ShellOutput> = {}): ShellOutput {
  return {
    command: 'cat mock-workspace.txt',
    cwd: '.',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 12,
    stdout: 'Hello from the workspace agent.\n',
    stderr: '',
    stdoutBytes: 32,
    stderrBytes: 0,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(undefined)
})

describe('diffView', () => {
  it('renders a region for the path with data-state modified, or created for a new file', async () => {
    const wrapper = mount(DiffView, { props: { hunks: [hunk], path: 'src/app.ts' } })
    const root = wrapper.get(`[data-testid="${testIds.diffView}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-path')).toBe('src/app.ts')
    expect(root.attributes('data-state')).toBe('modified')
    expect(root.attributes('role')).toBe('region')
    expect(root.attributes('aria-label')).toBe('Changes to src/app.ts')
    expect(wrapper.props()).toEqual({ hunks: [hunk], path: 'src/app.ts', created: false, truncated: false, maxLines: 200 })

    await wrapper.setProps({ created: true, truncated: true, maxLines: 20 })
    expect(root.attributes('data-state')).toBe('created')
    wrapper.unmount()
  })
})

describe('terminalOutput', () => {
  it('labels the block with the command and reports the run status', async () => {
    const wrapper = mount(TerminalOutput, { props: { command: 'npm test', output: null } })
    const root = wrapper.get(`[data-testid="${testIds.terminalOutput}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('aria-label')).toBe('Output of npm test')
    expect(root.attributes('data-status')).toBe('running')

    await wrapper.setProps({ output: shell() })
    expect(root.attributes('data-status')).toBe('ok')
    await wrapper.setProps({ output: shell({ exitCode: 1 }) })
    expect(root.attributes('data-status')).toBe('error')
    await wrapper.setProps({ output: shell({ exitCode: null, signal: 'SIGKILL' }) })
    expect(root.attributes('data-status')).toBe('killed')
    await wrapper.setProps({ output: shell({ exitCode: null, signal: 'SIGTERM', timedOut: true }) })
    expect(root.attributes('data-status')).toBe('timeout')
    await wrapper.setProps({ running: true })
    expect(root.attributes('data-status')).toBe('running')
    wrapper.unmount()
  })
})

describe('fileContent', () => {
  it('renders its root with the path and accepts the line props', () => {
    const wrapper = mount(FileContent, { props: { path: 'README.md', content: '# Title\n' } })
    const root = wrapper.get(`[data-testid="${testIds.fileContent}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-path')).toBe('README.md')
    expect(wrapper.props()).toEqual({ path: 'README.md', content: '# Title\n', startLine: 1, totalLines: null, truncated: false })
    wrapper.unmount()
  })
})

describe('fileList', () => {
  it('renders its root and accepts entries, paths and search matches', () => {
    const items = [{ path: 'src', type: 'dir' as const }, { path: 'src/app.ts', line: 3, text: 'export {}' }]
    const wrapper = mount(FileList, { props: { items } })
    const root = wrapper.get(`[data-testid="${testIds.fileList}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(wrapper.props()).toEqual({ items, truncated: false, maxItems: 50 })
    wrapper.unmount()
  })
})
