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
