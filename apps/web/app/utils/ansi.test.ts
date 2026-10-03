// stripAnsi and carriage return handling (docs/UI.md 7.19, 11.4; W7.11): what TerminalOutput renders.
import { describe, expect, it } from 'vitest'
import { collapseCarriageReturns, stripAnsi, terminalText } from './ansi'

const ESC = '\u001B'

describe('stripAnsi', () => {
  it('keeps text without escape sequences', () => {
    expect(stripAnsi('')).toBe('')
    expect(stripAnsi('PASS src/app.test.ts\n2 passed\n')).toBe('PASS src/app.test.ts\n2 passed\n')
  })

  it('removes CSI colors, cursor moves and erase sequences', () => {
    expect(stripAnsi(`${ESC}[32mPASS${ESC}[39m src/app.test.ts`)).toBe('PASS src/app.test.ts')
    expect(stripAnsi(`${ESC}[1;31mFAIL${ESC}[0m`)).toBe('FAIL')
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gdone`)).toBe('done')
    expect(stripAnsi(`${ESC}[?25lhidden cursor${ESC}[?25h`)).toBe('hidden cursor')
    expect(stripAnsi('\u009B31mred')).toBe('red')
  })

  it('removes OSC sequences (titles, hyperlinks) and two-byte escapes', () => {
    expect(stripAnsi(`${ESC}]0;title\u0007after`)).toBe('after')
    expect(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link')
    expect(stripAnsi(`${ESC}]0;unterminated`)).toBe('')
    expect(stripAnsi(`a${ESC}Mb`)).toBe('ab')
  })
})

describe('collapseCarriageReturns', () => {
  it('turns CRLF into LF and keeps the last segment of a progress line', () => {
    expect(collapseCarriageReturns('a\r\nb\r\n')).toBe('a\nb\n')
    expect(collapseCarriageReturns('10%\r50%\r100%\ndone')).toBe('100%\ndone')
    expect(collapseCarriageReturns('working\r')).toBe('working')
    expect(collapseCarriageReturns('no carriage returns')).toBe('no carriage returns')
  })

  it('combines both in terminalText', () => {
    expect(terminalText(`${ESC}[32m10%${ESC}[0m\r${ESC}[32m100%${ESC}[0m\r\n`)).toBe('100%\n')
  })
})
