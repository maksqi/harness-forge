import type { ToolPartLike } from '../chat-format'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { shellOutput, toolSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { TOOL_BODY_PREVIEW_CHARS } from '../chat-format'
import { TOOL_APPROVAL_CONTEXT } from './tool-approval-context'
import ToolApprovalCard from './ToolApprovalCard.vue'
import ToolPart from './ToolPart.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark' }),
  useRoute: () => ({ path: '/', fullPath: '/', params: {}, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), currentRoute: { value: { path: '/' } } }),
  navigateTo: vi.fn(),
}))

function part(overrides: Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>): ToolPartLike {
  return { type: 'tool-web_fetch', toolCallId: 'call_1', input: { url: 'https://nuxt.com/docs' }, ...overrides } as ToolPartLike
}

function mountPart(toolPart: ToolPartLike, streaming = true) {
  return mount({
    render: () => h(TooltipProvider, null, { default: () => h(ToolPart, { part: toolPart, streaming }) }),
  }, { attachTo: document.body })
}

function row(wrapper: ReturnType<typeof mountPart>) {
  return wrapper.get(`[data-testid="${testIds.toolRow}"]`)
}

beforeEach(() => {
  mock.api = createMockApi()
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('toolPart: row states', () => {
  it('shows name, first argument and a spinner while running', () => {
    const wrapper = mountPart(part({ state: 'input-available' }))
    expect(row(wrapper).attributes()).toMatchObject({ 'data-tool-name': 'web_fetch', 'data-state': 'input-available', 'data-status': 'running' })
    expect(row(wrapper).text()).toContain('web_fetch')
    expect(row(wrapper).text()).toContain('"https://nuxt.com/docs"')
    expect(row(wrapper).find('[role="status"]').exists()).toBe(true)
  })

  it('stops spinning when the message is no longer streaming', () => {
    const wrapper = mountPart(part({ state: 'input-available' }), false)
    expect(row(wrapper).attributes('data-status')).toBe('stopped')
    expect(row(wrapper).text()).toContain('Stopped')
  })

  it('marks success, errors and denials', () => {
    expect(row(mountPart(part({ state: 'output-available', output: { ok: true } }))).attributes('data-status')).toBe('done')
    expect(row(mountPart(part({ state: 'output-error', errorText: 'boom' }))).attributes('data-status')).toBe('error')
    const denied = mountPart(part({ state: 'output-denied', approval: { id: 'a1', approved: false } }))
    expect(row(denied).attributes('data-status')).toBe('denied')
    expect(row(denied).text()).toContain('Denied')
  })

  it('shows MCP tools by tool name with a server badge', () => {
    const wrapper = mountPart({ type: 'dynamic-tool', toolName: 'mcp__docs__search', toolCallId: 'c', state: 'output-available', input: { q: 'x' }, output: 'y' })
    expect(row(wrapper).attributes('data-tool-name')).toBe('mcp__docs__search')
    expect(row(wrapper).text()).toContain('search')
    expect(row(wrapper).text()).toContain('docs')
    expect(row(wrapper).text()).not.toContain('mcp__')
  })

  it('loads the MCP servers once to name the server of a reloaded transcript', async () => {
    const api = mock.api as ReturnType<typeof createMockApi>
    api.mcp.list.mockResolvedValue({ items: [{
      id: 'e2e-echo',
      name: 'E2E Echo',
      pluginId: 'core-mcp',
      editable: true,
      transport: { type: 'stdio', command: 'node', args: [], env: {} },
      policy: 'ask',
      enabled: true,
      status: 'connected',
      error: null,
      tools: ['mcp__e2e-echo__echo'],
      connectedAt: 1,
    }] })
    const tool = { type: 'dynamic-tool', toolName: 'mcp__e2e-echo__echo', toolCallId: 'c', state: 'output-available', input: { text: 'x' }, output: 'y' } as ToolPartLike
    const first = mountPart(tool)
    const second = mountPart({ ...tool, toolCallId: 'd' } as ToolPartLike)
    await flushPromises()
    expect(api.mcp.list).toHaveBeenCalledTimes(1)
    expect(row(first).text()).toContain('E2E Echo')
    expect(row(second).text()).not.toContain('e2e-echo')
    mountPart({ ...tool, toolCallId: 'e' } as ToolPartLike)
    await flushPromises()
    expect(api.mcp.list).toHaveBeenCalledTimes(1)
    // Plain tools never ask for the MCP list.
    mountPart(part({ state: 'output-available', output: 'ok' }))
    await flushPromises()
    expect(api.mcp.list).toHaveBeenCalledTimes(1)
  })

  it('never opens by itself; a click shows input and output', async () => {
    const wrapper = mountPart(part({ state: 'output-available', output: { title: 'Nuxt' } }))
    const closed = wrapper.get(`[data-testid="${testIds.toolRowOutput}"]`)
    expect(closed.attributes('hidden')).toBeDefined()
    expect(closed.text()).toBe('')
    await row(wrapper).get('button').trigger('click')
    await flushPromises()
    const body = wrapper.get(`[data-testid="${testIds.toolRowOutput}"]`)
    expect(body.attributes('hidden')).toBeUndefined()
    expect(body.text()).toContain('"url": "https://nuxt.com/docs"')
    expect(body.text()).toContain('"title": "Nuxt"')
  })
})

describe('toolPart: 4 KB previews', () => {
  it('caps the output at 4 KB with "Show all" and notes server truncation', async () => {
    const output = `${'x'.repeat(TOOL_BODY_PREVIEW_CHARS * 2)}…[truncated]`
    const wrapper = mountPart(part({ state: 'output-available', output }))
    await row(wrapper).get('button').trigger('click')
    await flushPromises()
    const block = wrapper.get('[data-slot="tool-value"][data-label="output"]')
    expect(block.get('pre').text()).toHaveLength(TOOL_BODY_PREVIEW_CHARS)
    expect(block.text()).toContain('Truncated by server')
    await block.get('[data-action="show-all"]').trigger('click')
    expect(block.get('pre').text()).toBe(output)
    expect(block.find('[data-action="show-all"]').exists()).toBe(false)
  })
})

describe('toolPart: generate_image', () => {
  const output = {
    modelRef: 'mock:image',
    images: [
      { fileId: 'file_AAAAAAAAAAAAAAAA', url: '/api/files/file_AAAAAAAAAAAAAAAA', mediaType: 'image/png', name: 'image-1.png' },
      { fileId: 'file_BBBBBBBBBBBBBBBB', url: '/api/files/file_BBBBBBBBBBBBBBBB', mediaType: 'image/png', name: 'image-2.png' },
    ],
    revisedPrompt: 'Mock: a red fox in the snow',
  }
  const imagePart = (overrides: Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>) => part({
    type: 'tool-generate_image',
    toolCallId: 'call_img',
    input: { aspectRatio: '16:9', n: 2, prompt: 'A red fox in the snow' },
    ...overrides,
  } as Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>)

  it('is a normal row whose first argument is the prompt, even when other keys come first', () => {
    const wrapper = mountPart(imagePart({ state: 'input-available' }))
    expect(row(wrapper).attributes()).toMatchObject({ 'data-tool-name': 'generate_image', 'data-status': 'running' })
    expect(row(wrapper).text()).toContain('generate_image')
    expect(row(wrapper).text()).toContain('"A red fox in the snow"')
    expect(row(wrapper).text()).not.toContain('16:9')
  })

  it('asks for approval like any tool with policy ask', () => {
    const wrapper = mountPart(imagePart({ state: 'approval-requested', approval: { id: 'appr_img' } }))
    expect(row(wrapper).text()).toContain('Needs approval')
    expect(wrapper.get(`[data-testid="${testIds.toolApproval}"]`).text()).toContain('Allow generate_image?')
  })

  it('keeps the JSON output (file references) in the expanded body', async () => {
    const wrapper = mountPart(imagePart({ state: 'output-available', output }))
    expect(row(wrapper).attributes('data-status')).toBe('done')
    await row(wrapper).get('button').trigger('click')
    await flushPromises()
    const outputBlock = wrapper.get('[data-slot="tool-value"][data-label="output"]')
    expect(outputBlock.get('pre').text()).toBe(JSON.stringify(output, null, 2))
    expect(wrapper.find(`[data-testid="${testIds.imageGallery}"]`).exists()).toBe(false)
  })

  it('ends in an error without an image model', async () => {
    const wrapper = mountPart(imagePart({ state: 'output-error', errorText: 'Choose an image model in Settings → Media.' }))
    expect(row(wrapper).attributes('data-status')).toBe('error')
    await row(wrapper).get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-slot="tool-value"][data-label="error"]').text()).toContain('Choose an image model in Settings → Media.')
  })
})

describe('toolPart: approval card', () => {
  const requested = () => part({ state: 'approval-requested', approval: { id: 'appr_1' } })

  it('renders under the row with the source plugin and the arguments', () => {
    usePluginsStore().tools = [toolSummary({ name: 'web_fetch', pluginId: 'core-tools' })]
    const wrapper = mountPart(requested())
    expect(row(wrapper).text()).toContain('Needs approval')
    const card = wrapper.get(`[data-testid="${testIds.toolApproval}"]`)
    expect(card.attributes('data-tool-name')).toBe('web_fetch')
    expect(card.attributes('role')).toBe('group')
    expect(card.text()).toContain('Allow web_fetch?')
    expect(card.text()).toContain('from core-tools')
    expect(card.text()).toContain('"url": "https://nuxt.com/docs"')
  })

  it('allow + "Always allow" emits one decision with alwaysAllow', async () => {
    const wrapper = mount(ToolPart, {
      props: { part: requested(), streaming: false },
      global: { stubs: { Tooltip: { template: '<div><slot /></div>' } } },
      attachTo: document.body,
    })
    await wrapper.get(`[data-testid="${testIds.toolApprovalAlways}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.toolApprovalAllow}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.toolApprovalAllow}"]`).trigger('click')
    expect(wrapper.emitted('approval')).toEqual([[{ id: 'appr_1', approved: true, toolName: 'web_fetch', alwaysAllow: true }]])
  })

  it('deny ignores "Always allow"', async () => {
    const wrapper = mount(ToolPart, { props: { part: requested(), streaming: false }, attachTo: document.body })
    await wrapper.get(`[data-testid="${testIds.toolApprovalAlways}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.toolApprovalDeny}"]`).trigger('click')
    expect(wrapper.emitted('approval')).toEqual([[{ id: 'appr_1', approved: false, toolName: 'web_fetch', alwaysAllow: false }]])
  })

  it('shows a request left in an older message as superseded, without a card', () => {
    const wrapper = mount({
      render: () => h(TooltipProvider, null, { default: () => h(ToolPart, { part: requested(), streaming: false, superseded: true }) }),
    }, { attachTo: document.body })
    expect(wrapper.find(`[data-testid="${testIds.toolApproval}"]`).exists()).toBe(false)
    expect(row(wrapper).attributes('data-status')).toBe('denied')
    expect(row(wrapper).text()).toContain('Denied')
  })

  it('collapses into the row status once decided', () => {
    const wrapper = mountPart(part({ state: 'approval-responded', approval: { id: 'appr_1', approved: true } }))
    expect(wrapper.find(`[data-testid="${testIds.toolApproval}"]`).exists()).toBe(false)
    expect(row(wrapper).attributes('data-status')).toBe('running')
  })
})

describe('toolPart: workspace tools (Phase 7)', () => {
  const editInput = { path: 'src/parser.ts', old_string: 'if (!tokens) return null', new_string: 'if (tokens.length === 0)\n  return null' }
  const editOutput = {
    path: 'src/parser.ts',
    replacements: 1,
    diff: {
      hunks: [{ oldStart: 12, oldLines: 3, newStart: 12, newLines: 4, lines: [' a', '-if (!tokens) return null', '+if (tokens.length === 0)', '+  return null', ' b'] }],
      added: 2,
      removed: 1,
      truncated: false,
    },
  }
  const shellOutput = {
    command: 'pnpm test',
    cwd: '.',
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 3200,
    stdout: '41 passed, 1 failed\n',
    stderr: 'FAIL src/parser.test.ts\n',
    stdoutBytes: 20,
    stderrBytes: 24,
  }
  const workspacePart = (toolName: string, overrides: Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>) =>
    part({ type: `tool-${toolName}`, toolCallId: `call_${toolName}`, ...overrides } as Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>)

  async function open(wrapper: ReturnType<typeof mountPart>) {
    await row(wrapper).get('button').trigger('click')
    await flushPromises()
    return wrapper.get(`[data-testid="${testIds.toolRowOutput}"]`)
  }

  it('shows the icon, the path and the +a −d summary from the registry', () => {
    const wrapper = mountPart(workspacePart('edit_file', { state: 'output-available', input: editInput, output: editOutput }))
    expect(row(wrapper).find('svg.lucide-file-pen-line').exists()).toBe(true)
    expect(row(wrapper).find('svg.lucide-wrench').exists()).toBe(false)
    expect(row(wrapper).text()).toContain('"src/parser.ts"')
    const summary = row(wrapper).get(`[data-testid="${testIds.toolRowSummary}"]`)
    expect(summary.text()).toBe('+2 −1')
    expect(summary.attributes('data-tone')).toBe('success')
    expect(summary.get('.text-success').text()).toBe('+2')
    expect(summary.get('.text-destructive').text()).toBe('−1')
    expect(row(wrapper).attributes('data-status')).toBe('done')
  })

  it('expands to the diff, with the generic blocks behind "Raw input and output"', async () => {
    const wrapper = mountPart(workspacePart('edit_file', { state: 'output-available', input: editInput, output: editOutput }))
    const body = await open(wrapper)
    const diff = body.get(`[data-testid="${testIds.diffView}"]`)
    expect(diff.attributes('data-path')).toBe('src/parser.ts')
    expect(diff.findAll(`[data-testid="${testIds.diffLine}"]`)).toHaveLength(5)
    expect(body.find('[data-slot="tool-value"]').exists()).toBe(false)

    const toggle = body.get(`[data-testid="${testIds.toolRawToggle}"]`)
    await toggle.trigger('click')
    expect(toggle.attributes('data-state')).toBe('open')
    const blocks = body.findAll('[data-slot="tool-value"]').map(block => block.attributes('data-label'))
    expect(blocks).toEqual(['input', 'output'])
    expect(body.text()).toContain('"old_string": "if (!tokens) return null"')
  })

  it('keeps the generic blocks when the output does not parse', async () => {
    const wrapper = mountPart(workspacePart('edit_file', { state: 'output-available', input: editInput, output: 'Edited the file.' }))
    expect(row(wrapper).find(`[data-testid="${testIds.toolRowSummary}"]`).exists()).toBe(false)
    const body = await open(wrapper)
    expect(body.find(`[data-testid="${testIds.diffView}"]`).exists()).toBe(false)
    expect(body.find(`[data-testid="${testIds.toolRawToggle}"]`).exists()).toBe(false)
    expect(body.findAll('[data-slot="tool-value"]').map(block => block.attributes('data-label'))).toEqual(['input', 'output'])
  })

  it('shows a finished shell call as its exit summary and terminal output', async () => {
    const wrapper = mountPart(workspacePart('shell', { state: 'output-available', input: { command: 'pnpm test' }, output: shellOutput }))
    expect(row(wrapper).find('svg.lucide-square-terminal').exists()).toBe(true)
    expect(row(wrapper).text()).toContain('"pnpm test"')
    const summary = row(wrapper).get(`[data-testid="${testIds.toolRowSummary}"]`)
    expect([summary.text(), summary.attributes('data-tone')]).toEqual(['exit 1', 'destructive'])
    const body = await open(wrapper)
    const terminal = body.get(`[data-testid="${testIds.terminalOutput}"]`)
    expect(terminal.attributes('data-status')).toBe('error')
    expect(terminal.get(`[data-testid="${testIds.terminalExit}"]`).attributes('data-value')).toBe('1')
    expect(terminal.get(`[data-testid="${testIds.terminalStderr}"]`).text()).toBe('FAIL src/parser.test.ts')
  })

  it('shows "Running…" in the terminal of a running shell call; other states keep the generic blocks', async () => {
    const running = mountPart(workspacePart('shell', { state: 'input-available', input: { command: 'sleep 5' } }))
    expect(row(running).attributes('data-status')).toBe('running')
    expect(row(running).find(`[data-testid="${testIds.toolRowSummary}"]`).exists()).toBe(false)
    const body = await open(running)
    expect(body.get(`[data-testid="${testIds.terminalOutput}"]`).attributes('data-status')).toBe('running')
    expect(body.text()).toContain('Running…')

    const failed = mountPart(workspacePart('shell', { state: 'output-error', input: { command: 'sleep 5' }, errorText: 'The shell is disabled.' }))
    const failedBody = await open(failed)
    expect(failedBody.find(`[data-testid="${testIds.terminalOutput}"]`).exists()).toBe(false)
    expect(failedBody.get('[data-slot="tool-value"][data-label="error"]').text()).toContain('The shell is disabled.')

    const stopped = mountPart(workspacePart('shell', { state: 'input-available', input: { command: 'sleep 5' } }), false)
    expect((await open(stopped)).find(`[data-testid="${testIds.terminalOutput}"]`).exists()).toBe(false)
  })

  it('lists directory entries and summarizes read_file ranges', async () => {
    const list = mountPart(workspacePart('list_directory', {
      state: 'output-available',
      input: {},
      output: { path: '.', entries: [{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file' }], truncated: false },
    }))
    expect(row(list).text()).toContain('"."')
    expect(row(list).get(`[data-testid="${testIds.toolRowSummary}"]`).text()).toBe('2 entries')
    const items = (await open(list)).findAll(`[data-testid="${testIds.fileListItem}"]`)
    expect(items.map(item => item.text())).toEqual(['src/', 'README.md'])

    const read = mountPart(workspacePart('read_file', {
      state: 'output-available',
      input: { path: 'README.md' },
      output: { path: 'README.md', content: '# Title\n', startLine: 1, endLine: 1, totalLines: 340, truncated: true },
    }))
    expect(row(read).get(`[data-testid="${testIds.toolRowSummary}"]`).text()).toBe('lines 1–1 of 340')
    expect((await open(read)).get(`[data-testid="${testIds.fileContent}"]`).attributes('data-path')).toBe('README.md')
  })
})

describe('toolPart: workspace approvals (Phase 7)', () => {
  function mountRequest(toolName: string, input: unknown, options: { toolMode?: 'ask' | 'edits', projectName?: string } = {}) {
    const toolPart = part({ type: `tool-${toolName}`, toolCallId: `call_${toolName}`, state: 'approval-requested', approval: { id: `appr_${toolName}` }, input } as Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>)
    const context = options.toolMode
      ? { [TOOL_APPROVAL_CONTEXT as symbol]: { toolMode: () => options.toolMode!, projectName: () => options.projectName ?? null, projectId: () => null, shellCwd: () => null } }
      : {}
    return mount(ToolPart, {
      props: { part: toolPart, streaming: false },
      global: { stubs: { Tooltip: { template: '<div><slot /></div>' }, CopyButton: true }, provide: context },
      attachTo: document.body,
    })
  }
  const card = (wrapper: ReturnType<typeof mountRequest>) => wrapper.get(`[data-testid="${testIds.toolApproval}"]`)

  it('asks "Run this command?" for a shell call: the command preview, Deny / Run and no "Always allow"', async () => {
    usePluginsStore().tools = [toolSummary({ name: 'shell', pluginId: 'core-workspace', policy: 'ask', workspace: 'execute' })]
    const wrapper = mountRequest('shell', { command: 'pnpm test --filter parser', description: 'Run the parser tests' })
    expect(card(wrapper).text()).toContain('Run this command?')
    expect(card(wrapper).text()).toContain('from core-workspace')
    expect(card(wrapper).attributes('aria-label')).toBe('Approval needed: run pnpm test --filter parser')
    expect(card(wrapper).get(`[data-testid="${testIds.toolApprovalPreview}"]`).attributes('data-kind')).toBe('command')
    expect(card(wrapper).find('pre.max-h-48').exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAlways}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAcceptEdits}"]`).exists()).toBe(false)
    const run = wrapper.get(`[data-testid="${testIds.toolApprovalAllow}"]`)
    expect(run.text()).toBe('Run')
    await run.trigger('click')
    expect(wrapper.emitted('approval')).toEqual([[{ id: 'appr_shell', approved: true, toolName: 'shell', alwaysAllow: false }]])
  })

  it('hides "Always allow" for a shell call before the tool list has loaded', () => {
    const wrapper = mountRequest('shell', { command: 'ls' })
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAlways}"]`).exists()).toBe(false)
  })

  it('keeps "Always allow" for a plugin tool that only shares the name', () => {
    usePluginsStore().tools = [toolSummary({ name: 'shell', pluginId: 'my-shell', policy: 'ask', workspace: null })]
    const wrapper = mountRequest('shell', { command: 'ls' })
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAlways}"]`).exists()).toBe(true)
  })

  it('offers "Accept all edits in this chat" for a write tool; Allow with it emits acceptEdits', async () => {
    usePluginsStore().tools = [toolSummary({ name: 'edit_file', pluginId: 'core-workspace', policy: 'ask', workspace: 'write' })]
    const wrapper = mountRequest('edit_file', { path: 'src/parser.ts', old_string: 'a', new_string: 'b' })
    expect(card(wrapper).text()).toContain('Allow edit_file?')
    expect(card(wrapper).get(`[data-testid="${testIds.toolApprovalPreview}"]`).attributes('data-kind')).toBe('diff')
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAlways}"]`).exists()).toBe(false)
    const accept = wrapper.get(`[data-testid="${testIds.toolApprovalAcceptEdits}"]`)
    expect(card(wrapper).text()).toContain('Accept all edits in this chat')
    await accept.trigger('click')
    expect(accept.attributes('data-state')).toBe('checked')
    await wrapper.get(`[data-testid="${testIds.toolApprovalAllow}"]`).trigger('click')
    expect(wrapper.emitted('approval')).toEqual([[{ id: 'appr_edit_file', approved: true, toolName: 'edit_file', alwaysAllow: false, acceptEdits: true }]])
  })

  it('sends acceptEdits false on Deny and without the checkbox', async () => {
    usePluginsStore().tools = [toolSummary({ name: 'write_file', pluginId: 'core-workspace', policy: 'ask', workspace: 'write' })]
    const denied = mountRequest('write_file', { path: 'a.md', content: 'x\n' })
    await denied.get(`[data-testid="${testIds.toolApprovalAcceptEdits}"]`).trigger('click')
    await denied.get(`[data-testid="${testIds.toolApprovalDeny}"]`).trigger('click')
    expect(denied.emitted('approval')).toEqual([[{ id: 'appr_write_file', approved: false, toolName: 'write_file', alwaysAllow: false, acceptEdits: false }]])
    denied.unmount()

    const plain = mountRequest('write_file', { path: 'a.md', content: 'x\n' })
    expect(card(plain).get(`[data-testid="${testIds.toolApprovalPreview}"]`).attributes('data-kind')).toBe('content')
    await plain.get(`[data-testid="${testIds.toolApprovalAllow}"]`).trigger('click')
    expect(plain.emitted('approval')).toEqual([[{ id: 'appr_write_file', approved: true, toolName: 'write_file', alwaysAllow: false, acceptEdits: false }]])
  })

  it('shows neither checkbox for a write tool in a chat that already accepts edits', () => {
    usePluginsStore().tools = [toolSummary({ name: 'write_file', pluginId: 'core-workspace', policy: 'ask', workspace: 'write' })]
    const wrapper = mountRequest('write_file', { path: '.env', content: 'A=1\n' }, { toolMode: 'edits' })
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAcceptEdits}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAlways}"]`).exists()).toBe(false)
    const asking = mountRequest('write_file', { path: 'a.md', content: 'x' }, { toolMode: 'ask' })
    expect(asking.find(`[data-testid="${testIds.toolApprovalAcceptEdits}"]`).exists()).toBe(true)
  })

  it('keeps the JSON block for a workspace read that asks (a secret-looking path)', () => {
    usePluginsStore().tools = [toolSummary({ name: 'read_file', pluginId: 'core-workspace', policy: 'safe', workspace: 'read' })]
    const wrapper = mountRequest('read_file', { path: '.env' })
    expect(card(wrapper).find(`[data-testid="${testIds.toolApprovalPreview}"]`).exists()).toBe(false)
    expect(card(wrapper).text()).toContain('"path": ".env"')
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAlways}"]`).exists()).toBe(true)
  })
})

describe('toolPart: shell rules (Phase 8)', () => {
  function shellPart(output: Record<string, unknown>): ToolPartLike {
    return part({ type: 'tool-shell', toolCallId: 'call_shell', state: 'output-available', input: { command: 'pnpm test' }, output } as Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>)
  }

  it('shows the rule badge before the summary of a shell call allowed by rules', () => {
    const wrapper = mountPart(shellPart(shellOutput({ command: 'pnpm test', allowedBy: ['pnpm test', 'git status'] })), false)
    const badge = row(wrapper).get(`[data-testid="${testIds.toolRowRule}"]`)
    expect(badge.attributes('data-value')).toBe('pnpm test, git status')
    expect(badge.text()).toBe(', allowed by rule pnpm test, git status')
    expect(badge.element.nextElementSibling?.getAttribute('data-testid')).toBe(testIds.toolRowSummary)
  })

  it('shows no badge without allowedBy (an approved call, an output saved before v1.4)', () => {
    const wrapper = mountPart(shellPart(shellOutput({ command: 'pnpm test' })), false)
    expect(row(wrapper).find(`[data-testid="${testIds.toolRowRule}"]`).exists()).toBe(false)
    expect(row(wrapper).find(`[data-testid="${testIds.toolRowSummary}"]`).exists()).toBe(true)
  })

  it('passes the card\'s allowRules on with the approval', () => {
    const toolPart = part({ type: 'tool-shell', toolCallId: 'call_shell', state: 'approval-requested', approval: { id: 'appr_shell' }, input: { command: 'pnpm test' } } as Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>)
    const wrapper = mount(ToolPart, {
      props: { part: toolPart, streaming: false },
      global: { stubs: { Tooltip: { template: '<div><slot /></div>' }, CopyButton: true } },
      attachTo: document.body,
    })
    const allowRules = { prefixes: ['pnpm test'], scope: 'project' as const }
    wrapper.getComponent(ToolApprovalCard).vm.$emit('decide', { approved: true, alwaysAllow: false, allowRules })
    expect(wrapper.emitted('approval')).toEqual([[{ id: 'appr_shell', approved: true, toolName: 'shell', alwaysAllow: false, allowRules }]])
  })
})
