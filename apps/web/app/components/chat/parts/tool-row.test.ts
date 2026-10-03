import { describe, expect, it } from 'vitest'
import { toolApprovalLabel, toolRowArgument } from './tool-row'

describe('toolRowArgument', () => {
  it('reads the prompt of generate_image, whatever the key order', () => {
    expect(toolRowArgument('generate_image', { aspectRatio: '16:9', n: 2, prompt: 'A red fox' })).toBe('A red fox')
    expect(toolRowArgument('generate_image', { prompt: `Line one\n  line ${'x'.repeat(80)}` })).toMatch(/^Line one line x+…$/)
    expect(toolRowArgument('generate_image', { prompt: 'Line one' })?.length).toBeLessThanOrEqual(60)
  })

  it('falls back to the first string value', () => {
    expect(toolRowArgument('generate_image', { aspectRatio: '1:1', prompt: '   ' })).toBe('1:1')
    expect(toolRowArgument('generate_image', null)).toBeNull()
    expect(toolRowArgument('web_fetch', { depth: 2, url: 'https://nuxt.com' })).toBe('https://nuxt.com')
    expect(toolRowArgument('mcp__img__generate_image', { size: 'big', prompt: 'x' })).toBe('big')
  })
})

describe('toolRowArgument: workspace tools (Phase 7)', () => {
  it('asks the workspace registry first', () => {
    expect(toolRowArgument('edit_file', { old_string: 'a', new_string: 'b', path: 'src/app.ts' })).toBe('src/app.ts')
    expect(toolRowArgument('list_directory', {})).toBe('.')
    expect(toolRowArgument('search_files', { glob: '*.ts', pattern: 'TODO' })).toBe('TODO')
    expect(toolRowArgument('shell', { description: 'Run tests', command: 'pnpm test\npnpm lint' })).toBe('pnpm test')
  })

  it('falls back to the first string value when the registry has no argument', () => {
    expect(toolRowArgument('read_file', { file: 'a.txt' })).toBe('a.txt')
    expect(toolRowArgument('shell', { cmd: 'ls' })).toBe('ls')
  })
})

describe('toolApprovalLabel', () => {
  it('announces a shell command by its first line, other tools by name', () => {
    expect(toolApprovalLabel('shell', { command: 'pnpm test --filter parser' })).toBe('Approval needed: run pnpm test --filter parser')
    expect(toolApprovalLabel('shell', { command: `\necho ${'x'.repeat(80)}\nls` })).toMatch(/^Approval needed: run echo x+…$/)
    expect(toolApprovalLabel('shell', { cmd: 'ls' })).toBe('Approval needed: shell')
    expect(toolApprovalLabel('web_fetch', { url: 'https://nuxt.com' })).toBe('Approval needed: web_fetch')
  })
})

describe('toolRowArgument / toolApprovalLabel: agent tools (Phase 9)', () => {
  const todos = [
    { id: 'a', content: 'Read the parser', status: 'completed' },
    { id: 'b', content: 'Run the parser tests', status: 'in_progress', activeForm: 'Running the parser tests' },
  ]

  it('names the current todo, else nothing; an invalid list keeps the generic argument', () => {
    expect(toolRowArgument('todo_write', { todos })).toBe('Running the parser tests')
    expect(toolRowArgument('todo_write', { todos: [{ id: 'b', content: 'Run the tests', status: 'in_progress' }] })).toBe('Run the tests')
    expect(toolRowArgument('todo_write', { todos: [todos[0]] })).toBeNull()
    expect(toolRowArgument('todo_write', { todos: [] })).toBeNull()
    expect(toolRowArgument('todo_write', { todos: [todos[0], todos[0]] })).toBe('a')
  })

  it('names a plan by its first heading, else its first line', () => {
    expect(toolRowArgument('exit_plan_mode', { plan: 'Intro\n## Move auth to server sessions\n1. Add it' })).toBe('Move auth to server sessions')
    expect(toolRowArgument('exit_plan_mode', { plan: '1. Add createSession()\n2. Test it' })).toBe('Add createSession()')
    expect(toolRowArgument('exit_plan_mode', { plan: '' })).toBeNull()
  })

  it('names a sub-agent by its description', () => {
    expect(toolRowArgument('task', { description: 'Find the session code', prompt: 'List the files.', type: 'explore' })).toBe('Find the session code')
    expect(toolRowArgument('task', { prompt: 'List the files.' })).toBe('List the files.')
  })

  it('announces a plan approval as "Plan ready for review"', () => {
    expect(toolApprovalLabel('exit_plan_mode', { plan: '# Plan' })).toBe('Plan ready for review')
    expect(toolApprovalLabel('exit_plan_mode', { nope: true })).toBe('Approval needed: exit_plan_mode')
    expect(toolApprovalLabel('task', { description: 'Find it', prompt: 'x', type: 'explore' })).toBe('Approval needed: task')
  })
})
