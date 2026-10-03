// ToolApprovalPreview (docs/UI.md 2.14, 7.3, 7.19, 10.4; W7.11): nothing without an approval view (the card keeps its
// JSON block); edit_file -> a diff of old_string -> new_string; write_file -> the content preview; shell -> the command
// card with its warning.
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { TOOL_APPROVAL_CONTEXT } from '../tool-approval-context'
import ToolApprovalPreview from './ToolApprovalPreview.vue'

const root = `[data-testid="${testIds.toolApprovalPreview}"]`

function mountPreview(toolName: string, input: unknown, projectName: string | null = null) {
  return mount({
    render: () => h(TooltipProvider, null, { default: () => h(ToolApprovalPreview, { toolName, input }) }),
  }, {
    attachTo: document.body,
    global: projectName === null ? {} : { provide: { [TOOL_APPROVAL_CONTEXT as symbol]: { toolMode: () => 'ask', projectName: () => projectName } } },
  })
}

beforeEach(() => {
  setActivePinia(undefined)
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('toolApprovalPreview', () => {
  it('renders nothing when there is no approval view', () => {
    const input = { name: 'Ada' }
    const wrapper = mountPreview('get_weather', input)
    expect(wrapper.find(root).exists()).toBe(false)
    expect(wrapper.getComponent(ToolApprovalPreview).props()).toEqual({ toolName: 'get_weather', input })
    // read tools have no preview either; a malformed input neither.
    expect(mountPreview('read_file', { path: '.env' }).find(root).exists()).toBe(false)
    expect(mountPreview('edit_file', { path: 'a.txt' }).find(root).exists()).toBe(false)
  })

  it('previews an edit as the diff of old_string -> new_string, without file line numbers', () => {
    const wrapper = mountPreview('edit_file', {
      path: 'src/parser.ts',
      old_string: '  if (!tokens) return null\n',
      new_string: '  if (tokens.length === 0)\n    return null\n',
    })
    const preview = wrapper.get(root)
    expect(preview.attributes('data-kind')).toBe('diff')
    const diff = preview.get(`[data-testid="${testIds.diffView}"]`)
    expect(diff.attributes('data-path')).toBe('src/parser.ts')
    expect(diff.attributes('data-numbers')).toBe('off')
    expect(diff.findAll(`[data-testid="${testIds.diffLine}"]`).map(line => line.attributes('data-kind'))).toEqual(['del', 'add', 'add'])
    expect(diff.text()).toContain('+2')
    expect(diff.text()).toContain('−1')
    expect(diff.find('[data-slot="diff-hunk"]').exists()).toBe(false)
    expect(preview.find('[data-slot="replace-all"]').exists()).toBe(false)
  })

  it('marks replace_all with an "All occurrences" badge', () => {
    const wrapper = mountPreview('edit_file', { path: 'a.ts', old_string: 'foo', new_string: 'bar', replace_all: true })
    expect(wrapper.get('[data-slot="replace-all"]').text()).toBe('All occurrences')
  })

  it('previews a write as "Create or overwrite {path} · N lines" and 20 lines of content', () => {
    const content = `${Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
    const wrapper = mountPreview('write_file', { path: 'notes/todo.md', content })
    const preview = wrapper.get(root)
    expect(preview.attributes('data-kind')).toBe('content')
    expect(preview.text()).toContain('Create or overwrite notes/todo.md · 40 lines')
    const file = preview.get(`[data-testid="${testIds.fileContent}"]`)
    expect(file.attributes('data-path')).toBe('notes/todo.md')
    expect(file.findAll('[data-slot="file-line"]')).toHaveLength(20)
    expect(file.find('[data-action="show-all"]').exists()).toBe(true)
  })

  it('previews a shell command with its description, timeout and the server warning', () => {
    const wrapper = mountPreview('shell', {
      command: 'pnpm test --filter parser',
      description: 'Run the parser tests',
      timeout_ms: 120_000,
      cwd: 'packages/parser',
    })
    const preview = wrapper.get(root)
    expect(preview.attributes('data-kind')).toBe('command')
    expect(preview.get('[data-slot="command-description"]').text()).toBe('Run the parser tests')
    expect(preview.get('[data-slot="command"]').text()).toBe('pnpm test --filter parser')
    expect(preview.get('[data-slot="command-meta"]').text()).toBe('In packages/parser · timeout 120s')
    expect(preview.get('[data-slot="command-warning"]').text()).toBe('Runs on the server with the server user\'s permissions.')
    expect(preview.find('.text-warning').exists()).toBe(true)
  })

  it('names the project of the chat when the chat view provides it', () => {
    const wrapper = mountPreview('shell', { command: 'ls' }, 'harness-forge')
    expect(wrapper.get('[data-slot="command-meta"]').text()).toBe('In harness-forge')
    expect(wrapper.find('[data-slot="command-description"]').exists()).toBe(false)
    const nested = mountPreview('shell', { command: 'ls', cwd: './src', timeout_ms: 5000 }, 'harness-forge')
    expect(nested.get('[data-slot="command-meta"]').text()).toBe('In harness-forge/src · timeout 5s')
  })
})
