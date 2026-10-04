import { describe, expect, it } from 'vitest'
import { expandArguments, splitArguments } from './arguments.ts'

/** The `expandTemplate` rule of `apps/server/src/chat/commands.ts` (plugin templates; input already trimmed there). */
function expandTemplate(template: string, input: string): string {
  if (template.includes('{{input}}'))
    return template.split('{{input}}').join(input)
  return input === '' ? template : `${template}\n\n${input}`
}

describe('splitArguments', () => {
  it.each([
    ['', []],
    ['   \n\t ', []],
    ['a', ['a']],
    ['a b', ['a', 'b']],
    ['  a  b\tc\nd  ', ['a', 'b', 'c', 'd']],
    ['"a b" c', ['a b', 'c']],
    ['\'a b\' c', ['a b', 'c']],
    ['a"b c"d e', ['ab cd', 'e']],
    ['"it\'s" ok', ['it\'s', 'ok']],
    ['\'say "hi"\'', ['say "hi"']],
    ['""', ['']],
    ['"" x \'\'', ['', 'x', '']],
    ['"a b', ['a b']],
    ['x \'rest of  it', ['x', 'rest of  it']],
    ['don\'t stop', ['dont stop']],
    ['42 é 😀', ['42', 'é', '😀']],
    ['a\u00A0b\u2003c', ['a', 'b', 'c']],
  ])('splits %j', (input, words) => {
    expect(splitArguments(input)).toEqual(words)
  })

  it('never throws on malformed input', () => {
    expect(splitArguments(undefined as unknown as string)).toEqual([])
    expect(splitArguments(42 as unknown as string)).toEqual([])
  })
})

describe('expandArguments', () => {
  it.each([
    ['Review $ARGUMENTS now', '  PR 12  ', 'Review PR 12 now'],
    ['Review {{input}} now', 'PR 12', 'Review PR 12 now'],
    ['$ARGUMENTS / $ARGUMENTS', 'x', 'x / x'],
    ['PR #$1 priority $2', '12 high', 'PR #12 priority high'],
    ['PR #$1 priority $2', '"12 b" high', 'PR #12 b priority high'],
    ['[$1] [$2] [$3]', 'one', '[one] [] []'],
    ['$9', '1 2 3 4 5 6 7 8 9 10', '9'],
    ['$10 and $1', 'a b', '$10 and a'],
    ['$0 and $1x', 'a', '$0 and ax'],
    ['all: $ARGUMENTS, first: $1', 'a b', 'all: a b, first: a'],
    ['Empty: [$ARGUMENTS] [$1]', '', 'Empty: [] []'],
  ])('expands %j with %j', (body, input, text) => {
    expect(expandArguments(body, input)).toEqual({ text, usedPlaceholder: true })
  })

  it('appends the trimmed input after a blank line without a placeholder', () => {
    expect(expandArguments('Summarize the file.', '  src/a.ts  ')).toEqual({ text: 'Summarize the file.\n\nsrc/a.ts', usedPlaceholder: false })
    expect(expandArguments('Summarize the file.', '   ')).toEqual({ text: 'Summarize the file.', usedPlaceholder: false })
    expect(expandArguments('$ ARGUMENTS {{ input }} $', 'x')).toEqual({ text: '$ ARGUMENTS {{ input }} $\n\nx', usedPlaceholder: false })
  })

  it('matches expandTemplate for {{input}} templates and templates without a placeholder', () => {
    const cases: Array<[string, string]> = [
      ['Translate: {{input}}', 'hello world'],
      ['{{input}}{{input}}', 'ab'],
      ['No placeholder.', 'tail'],
      ['No placeholder.', ''],
      ['Line one\nLine two', 'x y'],
    ]
    for (const [template, input] of cases)
      expect(expandArguments(template, input).text).toBe(expandTemplate(template, input))
  })

  it('expands in one pass: arguments that contain placeholders or replacement patterns stay as typed', () => {
    expect(expandArguments('A: $ARGUMENTS | 1: $1', '$1 $ARGUMENTS {{input}}').text).toBe('A: $1 $ARGUMENTS {{input}} | 1: $1')
    expect(expandArguments('[$ARGUMENTS] [$1]', '$& $\' $` $$').text).toBe('[$& $\' $` $$] [$&]')
  })

  it('leaves ! lines and @file references as text', () => {
    const body = '!git status\nRead @src/index.ts and $ARGUMENTS\n!`rm -rf /`'
    expect(expandArguments(body, 'focus').text).toBe('!git status\nRead @src/index.ts and focus\n!`rm -rf /`')
  })

  it('never throws on malformed input', () => {
    expect(expandArguments(undefined as unknown as string, 'x')).toEqual({ text: '\n\nx', usedPlaceholder: false })
    expect(expandArguments('$1', null as unknown as string)).toEqual({ text: '', usedPlaceholder: true })
  })
})
