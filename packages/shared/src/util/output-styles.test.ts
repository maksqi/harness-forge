import { describe, expect, it } from 'vitest'
import { AGENT_NAME_PATTERN } from '../ids.ts'
import { parseDefinition } from './definitions.ts'
import {
  BUILTIN_OUTPUT_STYLE_NAMES,
  BUILTIN_OUTPUT_STYLES,
  DEFAULT_OUTPUT_STYLE,
  effectiveStyleName,
  isBuiltinOutputStyle,
  OUTPUT_STYLE_HEADER,
  outputStyleBlock,
} from './output-styles.ts'

describe('builtin output styles', () => {
  it('lists default, explanatory and learning in menu order', () => {
    expect(BUILTIN_OUTPUT_STYLES.map(style => style.name)).toEqual([...BUILTIN_OUTPUT_STYLE_NAMES])
    expect(BUILTIN_OUTPUT_STYLES.map(style => style.label)).toEqual(['Default', 'Explanatory', 'Learning'])
    expect(DEFAULT_OUTPUT_STYLE).toBe('default')
    for (const style of BUILTIN_OUTPUT_STYLES) {
      expect(AGENT_NAME_PATTERN.test(style.name)).toBe(true)
      expect(style.keepCodingInstructions).toBe(true)
      expect(style.description.length).toBeGreaterThan(0)
      expect(style.description.length).toBeLessThanOrEqual(1024)
    }
  })

  it('has an empty default and short teaching texts', () => {
    const [plain, explanatory, learning] = BUILTIN_OUTPUT_STYLES
    expect(plain?.content).toBe('')
    expect(explanatory?.content).toContain('Insight:')
    expect(learning?.content).toContain('TODO(human)')
    expect(learning?.content).toContain('Learn by doing:')
    for (const style of [explanatory, learning]) {
      expect(style?.content.length).toBeGreaterThan(300)
      expect(style?.content.length).toBeLessThan(2500)
      expect(style?.content).toBe(style?.content.trim())
    }
  })

  it('reserves the builtin names', () => {
    expect(BUILTIN_OUTPUT_STYLE_NAMES.map(isBuiltinOutputStyle)).toEqual([true, true, true])
    expect(['Default', 'terse', '', 'default ', 5].map(name => isBuiltinOutputStyle(name as string))).toEqual([false, false, false, false, false])
    for (const name of BUILTIN_OUTPUT_STYLE_NAMES) {
      const result = parseDefinition('style', `---\nname: ${name}\ndescription: d\n---\nBody`)
      expect(result.definition).toBeNull()
      expect(result.diagnostics.map(entry => entry.code)).toEqual(['reserved-name'])
    }
  })
})

describe('effectiveStyleName', () => {
  it.each([
    ['learning', 'explanatory', 'terse', 'learning'],
    [null, 'explanatory', 'terse', 'explanatory'],
    [undefined, null, 'terse', 'terse'],
    ['', '  ', '', 'default'],
    [null, undefined, null, 'default'],
    [' terse ', null, null, 'terse'],
  ])('chat %j, project %j, global %j → %j', (chat, project, global, expected) => {
    expect(effectiveStyleName(chat, project, global)).toBe(expected)
  })

  it('ignores non-text values', () => {
    expect(effectiveStyleName(5 as unknown as string, {} as unknown as string, 'x')).toBe('x')
  })
})

describe('outputStyleBlock', () => {
  it('starts with the header and the label', () => {
    expect(outputStyleBlock({ label: 'Terse', content: '\n\nAnswer in one line.\n' })).toBe(`${OUTPUT_STYLE_HEADER}Terse\n\nAnswer in one line.`)
    expect(outputStyleBlock({ label: '  My \n Style ', content: 'x' })).toBe('Output style: My Style\n\nx')
    expect(outputStyleBlock({ label: '', content: 'x' })).toBe('Output style: Custom\n\nx')
    const explanatory = BUILTIN_OUTPUT_STYLES[1]!
    expect(outputStyleBlock(explanatory)?.startsWith('Output style: Explanatory\n\nBesides doing the task')).toBe(true)
  })

  it('is null for an empty body', () => {
    expect(outputStyleBlock(BUILTIN_OUTPUT_STYLES[0]!)).toBeNull()
    expect(outputStyleBlock({ label: 'x', content: '  \n ' })).toBeNull()
    expect(outputStyleBlock(null as unknown as { label: string, content: string })).toBeNull()
    expect(outputStyleBlock({ label: 'x', content: 3 } as unknown as { label: string, content: string })).toBeNull()
  })
})
