// ShareToolRow (docs/UI.md 7.15): the tool row of a shared chat, static without tool details, expandable with them.
import type { ShareToolPart } from './share-view'
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { backgroundLaunchOutput, skillOutput, taskInput, taskOutput, taskStep, todoItem } from '~/utils/testing/fixtures'
import ShareToolRow from './ShareToolRow.vue'
import { allByTestId, byTestId, settle } from './testing'

// Markdown (the plan and the sub-agent report) reads the color mode.
vi.mock('~/components/chat/nuxt-imports', () => ({ useColorMode: () => ({ value: 'dark' }) }))

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

describe('shareToolRow: workspace tools (Phase 7)', () => {
  const diff = {
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-mock agent', '+workspace agent', '+second line'] }],
    added: 2,
    removed: 1,
    truncated: false,
  }

  it('renders the diff through the same registry, with the raw blocks behind the toggle', async () => {
    mountRow({
      type: 'tool',
      toolName: 'edit_file',
      status: 'done',
      input: { path: 'mock-workspace.txt', old_string: 'mock agent', new_string: 'workspace agent\nsecond line' },
      output: { path: 'mock-workspace.txt', replacements: 1, diff },
    })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.querySelector('svg.lucide-file-pen-line')).not.toBeNull()
    expect(row.textContent).toContain('"mock-workspace.txt"')
    const summary = byTestId(testIds.toolRowSummary, row)!
    expect([summary.textContent, summary.dataset.tone]).toEqual(['+2 −1', 'success'])

    row.querySelector('button')!.click()
    await settle()
    const body = byTestId(testIds.shareToolRowOutput)!
    const view = byTestId(testIds.diffView, body)!
    expect(view.dataset.path).toBe('mock-workspace.txt')
    expect(Array.from(view.querySelectorAll<HTMLElement>(`[data-testid="${testIds.diffLine}"]`)).map(line => line.dataset.kind)).toEqual(['del', 'add', 'add'])
    expect(body.querySelector('[data-slot="tool-value"]')).toBeNull()

    byTestId(testIds.toolRawToggle, body)!.click()
    await settle()
    expect(Array.from(body.querySelectorAll<HTMLElement>('[data-slot="tool-value"]')).map(block => block.dataset.label)).toEqual(['input', 'output'])
  })

  it('shows a shared shell run as its terminal output', async () => {
    mountRow({
      type: 'tool',
      toolName: 'shell',
      status: 'done',
      input: { command: 'cat mock-workspace.txt' },
      output: {
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
      },
    })
    const row = byTestId(testIds.shareToolRow)!
    expect(byTestId(testIds.toolRowSummary, row)!.textContent).toBe('exit 0')
    row.querySelector('button')!.click()
    await settle()
    const terminal = byTestId(testIds.terminalOutput)!
    expect(terminal.dataset.status).toBe('ok')
    expect(byTestId(testIds.terminalStdout, terminal)!.textContent).toBe('Hello from the workspace agent.')
  })

  it('falls back to the generic blocks for a value cut at the share limit', async () => {
    mountRow({
      type: 'tool',
      toolName: 'write_file',
      status: 'done',
      input: '{"path": "big.txt", "content": "aaaa\n[truncated]',
      output: '{"path": "big.txt", "created": true, "diff": {"hunks": [\n[truncated]',
    })
    const row = byTestId(testIds.shareToolRow)!
    // The input is cut too: the generic first string, no summary.
    expect(byTestId(testIds.toolRowSummary, row)).toBeNull()
    row.querySelector('button')!.click()
    await settle()
    const body = byTestId(testIds.shareToolRowOutput)!
    expect(byTestId(testIds.diffView, body)).toBeNull()
    expect(byTestId(testIds.toolRawToggle, body)).toBeNull()
    const blocks = Array.from(body.querySelectorAll<HTMLElement>('[data-slot="tool-value"]'))
    expect(blocks.map(block => [block.dataset.label, block.querySelector('[data-slot="server-truncated"]') !== null])).toEqual([
      ['input', true],
      ['output', true],
    ])
  })

  it('stays a static row without tool details, with the workspace icon', () => {
    mountRow({ type: 'tool', toolName: 'shell', status: 'denied' })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.querySelector('button')).toBeNull()
    expect(row.querySelector('svg.lucide-square-terminal')).not.toBeNull()
    expect(byTestId(testIds.toolRowSummary, row)).toBeNull()
    expect(byTestId(testIds.shareToolRowOutput)).toBeNull()
  })

  it('keeps the error block of a failed workspace call', async () => {
    mountRow({ type: 'tool', toolName: 'edit_file', status: 'error', input: { path: 'a.txt', old_string: 'x', new_string: 'y' }, errorText: 'old_string was not found in a.txt.' })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('"a.txt"')
    row.querySelector('button')!.click()
    await settle()
    const body = byTestId(testIds.shareToolRowOutput)!
    expect(byTestId(testIds.diffView, body)).toBeNull()
    expect(Array.from(body.querySelectorAll<HTMLElement>('[data-slot="tool-value"]')).map(block => block.dataset.label)).toEqual(['input', 'error'])
  })
})

describe('shareToolRow: sticky folder, shell rules and spoken summaries (Phase 8)', () => {
  const shell = (overrides: Record<string, unknown> = {}) => ({
    command: 'pnpm test',
    cwd: 'packages/web',
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 12,
    stdout: 'ok\n',
    stderr: '',
    stdoutBytes: 3,
    stderrBytes: 0,
    endCwd: '.',
    cwdNote: 'The command ended outside the project folder; the next call starts in the project folder.',
    allowedBy: ['pnpm test'],
    ...overrides,
  })

  it('renders the rule badge before the spoken summary of a shell call allowed by rules', () => {
    mountRow({ type: 'tool', toolName: 'shell', status: 'done', input: { command: 'pnpm test' }, output: shell() })
    const row = byTestId(testIds.shareToolRow)!
    const badge = byTestId(testIds.toolRowRule, row)!
    expect(badge.dataset.value).toBe('pnpm test')
    expect(badge.querySelector('.sr-only')!.textContent).toBe(', allowed by rule pnpm test')
    const summary = byTestId(testIds.toolRowSummary, row)!
    expect(badge.nextElementSibling).toBe(summary)
    expect([summary.textContent, summary.getAttribute('aria-hidden')]).toEqual(['exit 1', 'true'])
    expect(summary.nextElementSibling!.classList.contains('sr-only')).toBe(true)
    expect(summary.nextElementSibling!.textContent).toBe('Exit code 1')
  })

  it('shows the folder prompt, "Now in …", the note and the rule line in the shared terminal', async () => {
    mountRow({ type: 'tool', toolName: 'shell', status: 'done', input: { command: 'pnpm test' }, output: shell() })
    const row = byTestId(testIds.shareToolRow)!
    row.querySelector('button')!.click()
    await settle()
    const terminal = byTestId(testIds.terminalOutput)!
    expect(byTestId(testIds.terminalCwd, terminal)!.dataset.value).toBe('packages/web')
    expect(byTestId(testIds.terminalCommand, terminal)!.textContent).toBe('packages/web $ pnpm test')
    const change = byTestId(testIds.terminalCwdChange, terminal)!
    expect([change.textContent, change.dataset.value]).toEqual(['Now in the project folder', '.'])
    expect(terminal.querySelector('[data-slot="terminal-cwd-note"]')!.textContent!.trim()).toContain('next call starts in the project folder')
    expect(terminal.querySelector('[data-slot="terminal-rule"]')!.textContent!.trim()).toBe('Allowed by rule: pnpm test')
  })

  it('shows no badge for an approved call, an old output or a share without tool details', () => {
    const approved = shell()
    delete (approved as Record<string, unknown>).allowedBy
    const first = mountRow({ type: 'tool', toolName: 'shell', status: 'done', input: { command: 'pnpm test' }, output: approved })
    expect(byTestId(testIds.toolRowRule)).toBeNull()
    expect(byTestId(testIds.toolRowSummary)).not.toBeNull()
    first.unmount()
    const bare = mountRow({ type: 'tool', toolName: 'shell', status: 'done' })
    expect(byTestId(testIds.toolRowRule)).toBeNull()
    bare.unmount()
    // A value cut at the share limit fails the schema: no badge, no summary.
    mountRow({ type: 'tool', toolName: 'shell', status: 'done', input: { command: 'pnpm test' }, output: '{"command": "pnpm test", "allowedBy": [\n[truncated]' })
    expect(byTestId(testIds.toolRowRule)).toBeNull()
  })

  it('reads a diff summary as words', () => {
    mountRow({
      type: 'tool',
      toolName: 'edit_file',
      status: 'done',
      input: { path: 'a.txt', old_string: 'x', new_string: 'y' },
      output: { path: 'a.txt', replacements: 1, diff: { hunks: [], added: 1, removed: 1, truncated: false } },
    })
    const summary = byTestId(testIds.toolRowSummary)!
    expect(summary.textContent).toBe('+1 −1')
    expect(summary.nextElementSibling!.textContent).toBe('1 line added, 1 removed')
  })
})

describe('shareToolRow: agent tools (Phase 9)', () => {
  const todos = [
    todoItem({ id: 'a', content: 'Read the parser', status: 'completed' }),
    todoItem({ id: 'b', content: 'Run the parser tests', status: 'in_progress', activeForm: 'Running the parser tests' }),
    todoItem({ id: 'c', content: 'Fix the empty-input branch' }),
  ]
  const counts = { pending: 1, inProgress: 1, completed: 1, total: 3 }
  const plan = '## Move auth to server sessions\n1. Add createSession() in src/auth/session.ts'

  it('reads "Sub-agent", "Updated tasks" and "Plan" without tool details, as static rows', () => {
    const labels = (['task', 'todo_write', 'exit_plan_mode'] as const).map((toolName) => {
      const wrapper = mountRow({ type: 'tool', toolName, status: 'done' })
      const row = byTestId(testIds.shareToolRow)!
      const result = [
        row.dataset.toolName,
        row.querySelector('[data-slot="agent-tool-label"]')?.textContent,
        row.textContent?.includes(toolName),
        row.querySelector('button') === null,
      ]
      wrapper.unmount()
      return result
    })
    expect(labels).toEqual([
      ['task', 'Sub-agent', false, true],
      ['todo_write', 'Updated tasks', false, true],
      ['exit_plan_mode', 'Plan', false, true],
    ])
  })

  it('renders TaskBody for a shared sub-agent with tool details', async () => {
    const output = taskOutput({ steps: [taskStep(), taskStep({ toolCallId: 'child_2', toolName: 'shell', summary: 'pnpm test', state: 'denied' })] })
    mountRow({ type: 'tool', toolName: 'task', status: 'done', input: taskInput(), output })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('Explore')
    expect(row.textContent).toContain('Find the session code')
    expect(row.querySelector('.lucide-telescope')).not.toBeNull()
    row.querySelector('button')!.click()
    await settle()
    const body = byTestId(testIds.shareToolRowOutput)!
    expect(body.querySelector('[data-slot="task-body"]')).not.toBeNull()
    expect(allByTestId(testIds.taskStep, body).map(step => step.dataset.state)).toEqual(['done', 'denied'])
    expect(byTestId(testIds.taskReport, body)?.textContent).toContain('src/auth/session.ts')
    expect(body.textContent).toContain('Skipped')
  })

  it('renders TodoList for shared tasks, with the summary and the raw blocks behind the toggle', async () => {
    mountRow({ type: 'tool', toolName: 'todo_write', status: 'done', input: { todos }, output: { todos, counts } })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('todo_write')
    expect(row.textContent).toContain('"Running the parser tests"')
    expect(byTestId(testIds.toolRowSummary, row)?.textContent).toBe('1/3')
    expect(row.querySelector('.lucide-list-todo')).not.toBeNull()
    row.querySelector('button')!.click()
    await settle()
    const body = byTestId(testIds.shareToolRowOutput)!
    expect(allByTestId(testIds.todoItem, body).map(item => item.dataset.status)).toEqual(['completed', 'in_progress', 'pending'])
    expect(body.querySelector('[data-slot="tool-value"]')).toBeNull()
    byTestId(testIds.toolRawToggle, body)!.click()
    await settle()
    expect(Array.from(body.querySelectorAll<HTMLElement>('[data-slot="tool-value"]')).map(block => block.dataset.label)).toEqual(['input', 'output'])
  })

  it('renders PlanBody for a shared plan; the outcome reads "Approved · …" or "Kept planning"', async () => {
    const approved = mountRow({ type: 'tool', toolName: 'exit_plan_mode', status: 'done', input: { plan }, output: { approved: true, mode: 'edits' } })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('"Move auth to server sessions"')
    expect(row.textContent).toContain('Approved · Accept edits')
    row.querySelector('button')!.click()
    await settle()
    const body = byTestId(testIds.shareToolRowOutput)!
    expect(body.querySelector('[data-slot="plan-body"]')?.textContent).toContain('Add createSession() in src/auth/session.ts')
    approved.unmount()

    mountRow({ type: 'tool', toolName: 'exit_plan_mode', status: 'denied', input: { plan } })
    const kept = byTestId(testIds.shareToolRow)!
    expect(kept.textContent).toContain('Kept planning')
    expect(kept.textContent).not.toContain('Denied')
  })

  it('keeps the generic row for a value the share cut or that fails its schema', async () => {
    const cut = mountRow({ type: 'tool', toolName: 'task', status: 'done', input: taskInput(), output: '{"status": "completed", "steps": [\n[truncated]' })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('task')
    row.querySelector('button')!.click()
    await settle()
    expect(byTestId(testIds.shareToolRowOutput)!.querySelector('[data-slot="task-body"]')).toBeNull()
    expect(Array.from(byTestId(testIds.shareToolRowOutput)!.querySelectorAll<HTMLElement>('[data-slot="tool-value"]')).map(block => block.dataset.label)).toEqual(['input', 'output'])
    cut.unmount()

    mountRow({ type: 'tool', toolName: 'todo_write', status: 'error', input: { todos: [todos[0], todos[0]] }, errorText: 'Todo ids must be unique.' })
    const failed = byTestId(testIds.shareToolRow)!
    expect(byTestId(testIds.toolRowSummary, failed)).toBeNull()
    failed.querySelector('button')!.click()
    await settle()
    expect(byTestId(testIds.todoList, byTestId(testIds.shareToolRowOutput)!)).toBeNull()
  })
})

describe('shareToolRow: custom agents, background calls and skills (Phase 10)', () => {
  it('reads a custom agent type as its name, with its icon', () => {
    mountRow({ type: 'tool', toolName: 'task', status: 'done', input: taskInput({ type: 'reviewer', description: 'Review the diff' }), output: taskOutput({ type: 'reviewer' }) })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('reviewer')
    expect(row.textContent).toContain('Review the diff')
    expect(row.textContent).not.toContain('Agent')
    expect(row.querySelector('.lucide-bot-message-square')).not.toBeNull()
    expect(row.querySelector('[data-slot="share-task-background"]')).toBeNull()
  })

  it('cuts a long custom name and adds "· in the background" for a background call', async () => {
    const name = 'a-very-long-custom-agent-name-indeed'
    mountRow({
      type: 'tool',
      toolName: 'task',
      status: 'done',
      input: taskInput({ type: name, description: 'Find flaky tests', background: true }),
      output: backgroundLaunchOutput({ type: name, description: 'Find flaky tests' }),
    })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain(`${name.slice(0, 23)}…`)
    expect(row.querySelector('[data-slot="share-task-background"]')?.textContent).toBe('· in the background')
    row.querySelector('button')!.click()
    await settle()
    expect(byTestId(testIds.shareToolRowOutput)!.querySelector('[data-slot="task-body"]')).not.toBeNull()
  })

  it('reads "Loaded skill" without tool details, as a static row', () => {
    mountRow({ type: 'tool', toolName: 'skill', status: 'done' })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.querySelector('[data-slot="agent-tool-label"]')?.textContent).toBe('Loaded skill')
    expect(row.querySelector('.lucide-book-open')).not.toBeNull()
    expect(row.querySelector('button')).toBeNull()
  })

  it('reads "Loaded skill {name}" with tool details and shows SkillToolBody behind the raw toggle', async () => {
    mountRow({ type: 'tool', toolName: 'skill', status: 'done', input: { name: 'release-notes' }, output: skillOutput() })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('Loaded skill')
    expect(row.textContent).toContain('release-notes')
    row.querySelector('button')!.click()
    await settle()
    const body = byTestId(testIds.shareToolRowOutput)!
    expect(body.querySelector('[data-slot="skill-body"]')?.textContent).toContain('How to write the release notes')
    expect(body.querySelector('[data-slot="tool-value"]')).toBeNull()
    byTestId(testIds.toolRawToggle, body)!.click()
    await settle()
    expect(Array.from(body.querySelectorAll<HTMLElement>('[data-slot="tool-value"]')).map(block => block.dataset.label)).toEqual(['input', 'output'])
  })

  it('keeps the generic row for a failed skill call or a cut skill output', async () => {
    const failed = mountRow({ type: 'tool', toolName: 'skill', status: 'error', input: { name: 'pdf' }, errorText: 'Unknown skill "pdf".' })
    const row = byTestId(testIds.shareToolRow)!
    expect(row.textContent).toContain('skill')
    expect(row.textContent).toContain('"pdf"')
    failed.unmount()

    mountRow({ type: 'tool', toolName: 'skill', status: 'done', input: { name: 'pdf' }, output: '{"name": "pdf", "content": "\n[truncated]' })
    const cut = byTestId(testIds.shareToolRow)!
    cut.querySelector('button')!.click()
    await settle()
    expect(byTestId(testIds.shareToolRowOutput)!.querySelector('[data-slot="skill-body"]')).toBeNull()
  })
})
