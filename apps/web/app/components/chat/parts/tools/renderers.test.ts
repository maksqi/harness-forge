// Workspace tool renderers (docs/UI.md 7.19, 10.4; W7.11): DiffView, TerminalOutput, FileContent and FileList render
// their root test ids with the documented data attributes, fold and cap long content, and note what the server cut.
// Store-free (the share page renders them too).
import type { DiffHunk, ShellOutput } from '@harness-forge/shared'
import type { Component } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import DiffView from './DiffView.vue'
import FileContent from './FileContent.vue'
import FileList from './FileList.vue'
import TerminalOutput from './TerminalOutput.vue'

const ESC = '\u001B'
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

/** Mounts a renderer inside a TooltipProvider (CopyButton needs one, like the app shell provides). */
function mountIn<C extends Component>(component: C, props: Record<string, unknown>, slots: Record<string, () => unknown> = {}) {
  const wrapper = mount({
    render: () => h(TooltipProvider, null, { default: () => h(component as Component, props, slots) }),
  }, { attachTo: document.body })
  return { wrapper, inner: wrapper.getComponent(component as Component) }
}

function by(id: string, root: ParentNode = document.body): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
}

function lines(count: number, prefix: string, start = 1): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}line ${start + index}`)
}

beforeEach(() => {
  setActivePinia(undefined)
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('diffView', () => {
  it('renders a region for the path with data-state modified, or created for a new file', async () => {
    const wrapper = mount(DiffView, {
      props: { hunks: [hunk], path: 'src/app.ts' },
      global: { stubs: { CopyButton: true } },
    })
    const root = wrapper.get(`[data-testid="${testIds.diffView}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-path')).toBe('src/app.ts')
    expect(root.attributes('data-state')).toBe('modified')
    expect(root.attributes('role')).toBe('region')
    expect(root.attributes('aria-label')).toBe('Changes to src/app.ts')
    expect(root.attributes('data-numbers')).toBe('on')
    expect(wrapper.props()).toEqual({ hunks: [hunk], path: 'src/app.ts', created: false, truncated: false, maxLines: 200, stats: null, lineNumbers: true })

    await wrapper.setProps({ created: true, truncated: true, maxLines: 20 })
    expect(root.attributes('data-state')).toBe('created')
    expect(root.text()).toContain('New file')
    wrapper.unmount()
  })

  it('numbers the lines, colors added and removed lines and labels them for screen readers', () => {
    const diff: DiffHunk = {
      oldStart: 12,
      oldLines: 3,
      newStart: 12,
      newLines: 4,
      lines: [' const tokens = lex(input)', '-if (!tokens) return null', '+if (tokens.length === 0)', '+  return null', ' return parse(tokens)'],
    }
    const { wrapper } = mountIn(DiffView, { hunks: [diff], path: 'src/parser.ts' })
    const root = by(testIds.diffView)[0]!
    expect(root.querySelector('[data-slot="diff-hunk"]')?.textContent).toBe('@@ −12,3 +12,4 @@')
    const rows = by(testIds.diffLine)
    expect(rows.map(row => row.dataset.kind)).toEqual(['context', 'del', 'add', 'add', 'context'])
    expect(rows[1]!.className).toContain('bg-destructive/10')
    expect(rows[2]!.className).toContain('bg-success/10')
    expect(rows[1]!.querySelector('.sr-only')?.textContent).toBe('Removed: ')
    expect(rows[2]!.querySelector('.sr-only')?.textContent).toBe('Added: ')
    expect(rows[0]!.querySelector('.sr-only')).toBeNull()
    // old | new numbers (the second column shows the old number below sm for removed lines)
    const numbers = (row: HTMLElement) => Array.from(row.querySelectorAll('[aria-hidden="true"]')).slice(0, 2).map(cell => cell.textContent)
    expect(numbers(rows[0]!)).toEqual(['12', '1212'])
    expect(numbers(rows[1]!)).toEqual(['13', '13'])
    expect(numbers(rows[4]!)).toEqual(['14', '1515'])
    expect(rows[3]!.textContent).toContain('  return null')
    // Header: +a −d from the hunks.
    expect(root.textContent).toContain('+2')
    expect(root.textContent).toContain('−1')
    wrapper.unmount()
  })

  it('folds runs of more than 8 unchanged lines and unfolds them on click', async () => {
    const diff: DiffHunk = {
      oldStart: 1,
      oldLines: 22,
      newStart: 1,
      newLines: 22,
      lines: ['-a', '+A', ...lines(20, ' '), '-b', '+B'],
    }
    const { wrapper } = mountIn(DiffView, { hunks: [diff], path: 'a.txt' })
    const expand = by(testIds.diffExpand)
    expect(expand).toHaveLength(1)
    expect(expand[0]!.dataset.action).toBe('unfold')
    expect(expand[0]!.textContent?.trim()).toBe('⋯ 14 unchanged lines')
    expect(by(testIds.diffLine).filter(row => row.dataset.kind === 'context')).toHaveLength(6)

    expand[0]!.click()
    await wrapper.vm.$nextTick()
    expect(by(testIds.diffExpand)).toHaveLength(0)
    expect(by(testIds.diffLine).filter(row => row.dataset.kind === 'context')).toHaveLength(20)
    wrapper.unmount()
  })

  it('keeps context at the edges of a hunk: only the lines next to the change stay', () => {
    const diff: DiffHunk = { oldStart: 1, oldLines: 11, newStart: 1, newLines: 11, lines: [...lines(10, ' '), '-x', '+y'] }
    const { wrapper } = mountIn(DiffView, { hunks: [diff], path: 'a.txt' })
    expect(by(testIds.diffExpand)[0]!.textContent?.trim()).toBe('⋯ 7 unchanged lines')
    expect(by(testIds.diffLine).filter(row => row.dataset.kind === 'context').map(row => row.textContent)).toEqual([
      expect.stringContaining('line 8'),
      expect.stringContaining('line 9'),
      expect.stringContaining('line 10'),
    ])
    wrapper.unmount()
  })

  it('shows maxLines lines, then "Show N more lines"', async () => {
    const diff: DiffHunk = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 30, lines: lines(30, '+') }
    const { wrapper } = mountIn(DiffView, { hunks: [diff], path: 'new.txt', created: true, maxLines: 20 })
    expect(by(testIds.diffLine)).toHaveLength(20)
    const more = by(testIds.diffExpand)[0]!
    expect(more.dataset.action).toBe('show-all')
    expect(more.textContent?.trim()).toBe('Show 10 more lines')
    more.click()
    await wrapper.vm.$nextTick()
    expect(by(testIds.diffLine)).toHaveLength(30)
    expect(by(testIds.diffExpand)).toHaveLength(0)
    wrapper.unmount()
  })

  it('notes a truncated diff, an empty one, and a diff too large to show', async () => {
    const first = mountIn(DiffView, { hunks: [hunk], path: 'a.txt', truncated: true })
    expect(by(testIds.diffView)[0]!.textContent).toContain('Diff truncated by server')
    first.wrapper.unmount()

    const tooLarge = mountIn(DiffView, { hunks: [], path: 'a.txt', truncated: true })
    expect(by(testIds.diffView)[0]!.textContent).toContain('The diff is too large to show.')
    expect(by(testIds.diffView)[0]!.textContent).not.toContain('Diff truncated by server')
    tooLarge.wrapper.unmount()

    const empty = mountIn(DiffView, { hunks: [], path: 'a.txt' })
    expect(by(testIds.diffView)[0]!.textContent).toContain('No changes.')
    empty.wrapper.unmount()

    const created = mountIn(DiffView, { hunks: [], path: 'a.txt', created: true })
    expect(by(testIds.diffView)[0]!.textContent).toContain('Empty file.')
    created.wrapper.unmount()
  })

  it('shows "No newline at end of file" markers as notes, not lines', () => {
    const diff: DiffHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+a'] }
    const { wrapper } = mountIn(DiffView, { hunks: [diff], path: 'a.txt' })
    expect(by(testIds.diffLine)).toHaveLength(2)
    expect(document.querySelector('[data-slot="diff-note"]')?.textContent).toBe('No newline at end of file')
    wrapper.unmount()
  })

  it('takes the header totals from the stats prop, aria-hidden with a spoken label (Phase 8)', () => {
    const { wrapper } = mountIn(DiffView, { hunks: [hunk], path: 'a.txt', stats: { additions: 120, deletions: 40 } })
    const root = by(testIds.diffView)[0]!
    const totals = root.querySelector<HTMLElement>('[data-slot="diff-stats"]')!
    expect(Array.from(totals.children, child => child.textContent)).toEqual(['+120', '−40'])
    expect(totals.getAttribute('aria-hidden')).toBe('true')
    expect(totals.nextElementSibling?.className).toContain('sr-only')
    expect(totals.nextElementSibling?.textContent).toBe('120 lines added, 40 removed')
    wrapper.unmount()
  })

  it('counts the totals from the hunks without stats and hides them when nothing changed', () => {
    const counted = mountIn(DiffView, { hunks: [hunk], path: 'a.txt', stats: null })
    expect(by(testIds.diffView)[0]!.querySelector('[data-slot="diff-stats"]')?.textContent).toBe('+1−1')
    counted.wrapper.unmount()

    const context: DiffHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' same'] }
    const unchanged = mountIn(DiffView, { hunks: [context], path: 'a.txt' })
    expect(by(testIds.diffView)[0]!.querySelector('[data-slot="diff-stats"]')).toBeNull()
    unchanged.wrapper.unmount()

    const zero = mountIn(DiffView, { hunks: [hunk], path: 'a.txt', stats: { additions: 0, deletions: 0 } })
    expect(by(testIds.diffView)[0]!.querySelector('[data-slot="diff-stats"]')).toBeNull()
    zero.wrapper.unmount()
  })

  it('hides the line numbers and hunk headers with lineNumbers false and says so in data-numbers (Phase 8)', () => {
    const second: DiffHunk = { oldStart: 40, oldLines: 1, newStart: 40, newLines: 1, lines: ['-c', '+d'] }
    const { wrapper } = mountIn(DiffView, { hunks: [hunk, second], path: 'a.txt', lineNumbers: false })
    const root = by(testIds.diffView)[0]!
    expect(root.dataset.numbers).toBe('off')
    expect(by(testIds.diffLine)[0]!.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
    // No "@@" headers: the first hunk has none, later ones a plain separator.
    expect(Array.from(root.querySelectorAll('[data-slot="diff-hunk"]')).map(row => row.textContent)).toEqual(['⋯'])
    wrapper.unmount()
  })

  it('scrolls long lines inside the block', () => {
    const { wrapper } = mountIn(DiffView, { hunks: [{ ...hunk, lines: [`+${'x'.repeat(400)}`] }], path: 'a.txt' })
    const row = by(testIds.diffLine)[0]!
    expect(row.className).toContain('whitespace-pre')
    expect(row.closest('.overflow-x-auto')).not.toBeNull()
    expect(by(testIds.diffView)[0]!.className).toContain('min-w-0')
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
    expect(root.text()).toContain('Running…')
    expect(wrapper.get(`[data-testid="${testIds.terminalCommand}"]`).text()).toBe('$ npm test')

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

  it('shows stdout, the exit code badge and the duration', () => {
    const wrapper = mount(TerminalOutput, { props: { command: 'cat a.txt', output: shell({ durationMs: 3200 }) } })
    expect(wrapper.get(`[data-testid="${testIds.terminalStdout}"]`).text()).toBe('Hello from the workspace agent.')
    const exit = wrapper.get(`[data-testid="${testIds.terminalExit}"]`)
    expect(exit.text()).toBe('Exit code 0')
    expect(exit.attributes('data-value')).toBe('0')
    expect(wrapper.get('[data-slot="terminal-duration"]').text()).toBe('3s')
    expect(wrapper.find(`[data-testid="${testIds.terminalStderr}"]`).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Running…')
    wrapper.unmount()
  })

  it('shows stderr under its label, red only when the exit code is not 0', async () => {
    const wrapper = mount(TerminalOutput, { props: { command: 'npm test', output: shell({ stderr: 'warning: deprecated\n', stderrBytes: 20 }) } })
    const stderr = () => wrapper.get(`[data-testid="${testIds.terminalStderr}"]`)
    expect(stderr().text()).toBe('warning: deprecated')
    expect(stderr().classes()).not.toContain('text-destructive')
    expect(wrapper.text()).toContain('stderr')
    await wrapper.setProps({ output: shell({ exitCode: 2, stderr: 'Error: failed\n', stderrBytes: 14 }) })
    expect(stderr().classes()).toContain('text-destructive')
    expect(wrapper.get(`[data-testid="${testIds.terminalExit}"]`).text()).toBe('Exit code 2')
    wrapper.unmount()
  })

  it('strips ANSI codes and collapses progress lines', () => {
    const stdout = `${ESC}[32mPASS${ESC}[39m src/app.test.ts\n10%\r100%\n`
    const wrapper = mount(TerminalOutput, { props: { command: 'npm test', output: shell({ stdout, stdoutBytes: stdout.length }) } })
    expect(wrapper.get(`[data-testid="${testIds.terminalStdout}"]`).text()).toBe('PASS src/app.test.ts\n100%')
    wrapper.unmount()
  })

  it('shows the last 40 lines, then "Show all N lines"', async () => {
    const stdout = `${Array.from({ length: 100 }, (_, index) => `out ${index + 1}`).join('\n')}\n`
    const wrapper = mount(TerminalOutput, { props: { command: 'seq 100', output: shell({ stdout, stdoutBytes: stdout.length }) } })
    const shown = () => wrapper.get(`[data-testid="${testIds.terminalStdout}"]`).text().split('\n')
    expect(shown()).toHaveLength(40)
    expect(shown()[0]).toBe('out 61')
    expect(shown().at(-1)).toBe('out 100')
    const button = wrapper.get('[data-action="show-all"]')
    expect(button.text()).toBe('Show all 100 lines')
    await button.trigger('click')
    expect(shown()).toHaveLength(100)
    expect(wrapper.find('[data-action="show-all"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows Timed out, the signal and no exit badge when a timeout killed the process', () => {
    const wrapper = mount(TerminalOutput, {
      props: { command: 'sleep 999', output: shell({ exitCode: null, signal: 'SIGTERM', timedOut: true, stdout: '', stdoutBytes: 0, durationMs: 120_000 }) },
    })
    expect(wrapper.find(`[data-testid="${testIds.terminalExit}"]`).exists()).toBe(false)
    expect(wrapper.get('[data-slot="terminal-timeout"]').text()).toBe('Timed out')
    expect(wrapper.get('[data-slot="terminal-signal"]').text()).toBe('SIGTERM')
    expect(wrapper.get('[data-slot="terminal-duration"]').text()).toBe('2m 0s')
    expect(wrapper.text()).toContain('No output')
    wrapper.unmount()
  })

  it('notes output the server cut (byte counts past the kept head and tail)', async () => {
    const kept = 'start\n[… 80000 bytes omitted …]\nend\n'
    const wrapper = mount(TerminalOutput, { props: { command: 'yes | head -c 100000', output: shell({ stdout: kept, stdoutBytes: 100_000 }) } })
    expect(wrapper.get('[data-slot="server-truncated"]').text()).toBe('Output truncated by server')
    // Raw bytes over the kept text (ANSI stripped by the server) but under the head + tail budget: nothing was cut.
    await wrapper.setProps({ output: shell({ stdout: 'ok\n', stdoutBytes: 400 }) })
    expect(wrapper.find('[data-slot="server-truncated"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('names a multi-line command by its first line', () => {
    const wrapper = mount(TerminalOutput, { props: { command: '\nnpm ci\nnpm test', output: null } })
    expect(wrapper.attributes('aria-label')).toBe('Output of npm ci')
    expect(wrapper.get(`[data-testid="${testIds.terminalCommand}"]`).text()).toBe('$ \nnpm ci\nnpm test'.trim())
    wrapper.unmount()
  })
})

describe('fileContent', () => {
  it('renders its root with the path and accepts the line props', () => {
    const { wrapper, inner } = mountIn(FileContent, { path: 'README.md', content: '# Title\n' })
    const root = by(testIds.fileContent)[0]!
    expect(root).toBe(inner.element)
    expect(root.dataset.path).toBe('README.md')
    expect(inner.props()).toEqual({ path: 'README.md', content: '# Title\n', startLine: 1, totalLines: null, truncated: false })
    wrapper.unmount()
  })

  it('numbers lines from startLine, shows 20, then Show all', async () => {
    const content = `${lines(30, '').join('\n')}\n`
    const { wrapper } = mountIn(FileContent, { path: 'src/app.ts', content, startLine: 101, totalLines: 340, truncated: true })
    const root = by(testIds.fileContent)[0]!
    const rows = () => Array.from(root.querySelectorAll('[data-slot="file-line"]'))
    expect(rows()).toHaveLength(20)
    expect(rows()[0]!.textContent).toBe('101line 1')
    expect(root.querySelector('[data-slot="file-range"]')?.textContent).toBe('Showing lines 101–130 of 340')
    expect(root.querySelector('[data-slot="server-truncated"]')?.textContent).toBe('Truncated by server')
    root.querySelector<HTMLButtonElement>('[data-action="show-all"]')!.click()
    await wrapper.vm.$nextTick()
    expect(rows()).toHaveLength(30)
    expect(root.querySelector('[data-action="show-all"]')).toBeNull()
    wrapper.unmount()
  })

  it('shows no range for a whole file and "Empty file." without content', () => {
    const whole = mountIn(FileContent, { path: 'a.txt', content: 'a\nb\n', startLine: 1, totalLines: 2 })
    expect(by(testIds.fileContent)[0]!.querySelector('[data-slot="file-range"]')).toBeNull()
    whole.wrapper.unmount()
    const empty = mountIn(FileContent, { path: 'a.txt', content: '', totalLines: 0 })
    expect(by(testIds.fileContent)[0]!.textContent).toContain('Empty file.')
    empty.wrapper.unmount()
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

  it('shows directory entries by name, folders with a trailing slash', () => {
    const wrapper = mount(FileList, {
      props: { items: [{ path: 'src/lib', type: 'dir' }, { path: 'src/main.ts', type: 'file' }, { path: 'src/link', type: 'symlink' }] },
    })
    const items = wrapper.findAll(`[data-testid="${testIds.fileListItem}"]`)
    expect(items.map(item => item.attributes('data-path'))).toEqual(['src/lib', 'src/main.ts', 'src/link'])
    expect(items.map(item => item.text())).toEqual(['lib/', 'main.ts', 'link'])
    wrapper.unmount()
  })

  it('shows up to maxItems, then "Show N more", and notes a truncated result', async () => {
    const items = Array.from({ length: 60 }, (_, index) => ({ path: `src/file-${index}.ts` }))
    const wrapper = mount(FileList, { props: { items, truncated: true } })
    expect(wrapper.findAll(`[data-testid="${testIds.fileListItem}"]`)).toHaveLength(50)
    expect(wrapper.text()).toContain('More results were cut by the server')
    const more = wrapper.get('[data-action="show-all"]')
    expect(more.text()).toBe('Show 10 more')
    await more.trigger('click')
    expect(wrapper.findAll(`[data-testid="${testIds.fileListItem}"]`)).toHaveLength(60)
    wrapper.unmount()
  })

  it('groups search matches by path with line prefixes', () => {
    const wrapper = mount(FileList, {
      props: {
        items: [
          { path: 'src/a.ts', line: 3, text: 'const token = 1' },
          { path: 'src/b.ts', line: 9, text: 'token()' },
          { path: 'src/a.ts', line: 12, text: 'return token' },
        ],
      },
    })
    const groups = wrapper.findAll('[data-slot="file-list-group"]')
    expect(groups).toHaveLength(2)
    expect(groups[0]!.find('p').text()).toBe('src/a.ts')
    const matches = groups[0]!.findAll(`[data-testid="${testIds.fileListItem}"]`)
    expect(matches.map(match => [match.attributes('data-path'), match.attributes('data-line'), match.text()])).toEqual([
      ['src/a.ts', '3', '3:const token = 1'],
      ['src/a.ts', '12', '12:return token'],
    ])
    wrapper.unmount()
  })

  it('shows the empty slot or a default text without items', () => {
    const plain = mount(FileList, { props: { items: [] } })
    expect(plain.text()).toBe('No results.')
    plain.unmount()
    const named = mount(FileList, { props: { items: [] }, slots: { empty: () => 'No matches.' } })
    expect(named.text()).toBe('No matches.')
    named.unmount()
  })
})
