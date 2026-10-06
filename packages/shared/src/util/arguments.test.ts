/* eslint-disable no-template-curly-in-string -- literal `${CLAUDE_…}` placeholders are test data */
import { describe, expect, it } from 'vitest'
import { argumentBase, expandArguments, splitArguments } from './arguments.ts'

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

// =====================================================================================================================
// Phase 12 (ADR-058, C42): argument base, `$ARGUMENTS[N]`, `$name`, `\$`, `${CLAUDE_…}`

/** Command bodies of the Phase 10 / Phase 11 docs, examples and probes (they must keep their meaning). */
const PHASE_10_BODIES = [
  'Review PR #$1 with priority $2 and assign to $3.',
  'Fix $ARGUMENTS and run the suite.',
  '# Fix the failing test\n\nFix $ARGUMENTS and run the suite.',
  'Review $1 for bugs and risky changes. Focus on: $ARGUMENTS.',
  'Say hello to $ARGUMENTS.',
  'Deploy to $ARGUMENTS.',
  'Translate: {{input}}',
  'PR #$1 priority $2',
  '[$1] [$2] [$3]',
  '$10 and $1',
  '$0 and $1x',
  'Summarize the file.',
  '!git status\nRead @src/index.ts and $ARGUMENTS',
  'Costs $5 and $9.99 total for $1',
]

describe('argumentBase', () => {
  it.each([
    ['Review PR #$1 with priority $2.', undefined, 1],
    ['Fix $ARGUMENTS.', undefined, 1],
    ['{{input}}', [], 1],
    ['First: $0, second: $1', undefined, 0],
    ['All of $ARGUMENTS[0] and $ARGUMENTS[1]', undefined, 0],
    ['Escaped \\$0 stays text, $1 is first', undefined, 1],
    ['Escaped \\$ARGUMENTS[0] too', undefined, 1],
    ['$01 and $09 are no placeholders', undefined, 1],
    ['Named $issue', ['issue'], 0],
    ['Nothing', ['a'], 0],
    [42 as unknown as string, undefined, 1],
  ] as const)('%j with %j → %d', (body, names, base) => {
    expect(argumentBase(body, names)).toBe(base)
  })

  it('keeps every Phase 10 body 1-based except the one that already used $0 as text', () => {
    for (const body of PHASE_10_BODIES)
      expect(argumentBase(body), body).toBe(body.includes('$0') ? 0 : 1)
  })
})

describe('expandArguments with options', () => {
  it('expands every Phase 10 body exactly like the Phase 10 rules (default base)', () => {
    const inputs = ['', 'one', '12 high ada', '"a b" c \'d e\'', '$1 $ARGUMENTS {{input}} $name ${CLAUDE_SKILL_DIR}']
    for (const body of PHASE_10_BODIES.filter(entry => !entry.includes('$0'))) {
      for (const input of inputs)
        expect(expandArguments(body, input, {}), `${body} / ${input}`).toEqual(expandArguments(body, input))
    }
  })

  it.each([
    ['First $0, second $1, third $2', 'a "b c" d', 'First a, second b c, third d'],
    ['$ARGUMENTS[0] / $ARGUMENTS[2] / $ARGUMENTS[9]', 'x y z', 'x / z / '],
    ['$ARGUMENTS[1] then $ARGUMENTS', 'p q', 'q then p q'],
    ['Legacy $1 and $2', 'a b', 'Legacy a and b'],
    ['$1 is second here: $0', 'a b', 'b is second here: a'],
    ['Price \\$1 for $ARGUMENTS', 'it', 'Price $1 for it'],
    ['Keep \\$ARGUMENTS and \\${CLAUDE_SKILL_DIR}', 'it', 'Keep $ARGUMENTS and ${CLAUDE_SKILL_DIR}\n\nit'],
    ['{{input}} works', 'x', 'x works'],
  ])('expands %j with %j', (body, input, text) => {
    expect(expandArguments(body, input, {}).text).toBe(text)
  })

  it('reads named arguments by position', () => {
    const names = ['issue', 'branch', 'issue_id']
    expect(expandArguments('Fix $issue on $branch ($issue_id; $issued; $other)', '42 main 7', { names }).text).toBe('Fix 42 on main (7; $issued; $other)')
    expect(expandArguments('$issue $0 $1', 'a b', { names }).text).toBe('a a b')
    expect(expandArguments('$branch', 'only', { names })).toEqual({ text: '', usedPlaceholder: true })
    // An undeclared name is text, so the input is appended.
    expect(expandArguments('Use $issue', 'x', { names: [] })).toEqual({ text: 'Use $issue\n\nx', usedPlaceholder: false })
  })

  it('substitutes known variables and keeps unknown ones; variables are no placeholders', () => {
    const vars = { CLAUDE_SKILL_DIR: '/data/skills/deploy', CLAUDE_PROJECT_DIR: '/work/app', CLAUDE_SESSION_ID: 'chat-1', CLAUDE_PLUGIN_ROOT: '/p/root' }
    expect(expandArguments('Run ${CLAUDE_SKILL_DIR}/scripts/go.sh in ${CLAUDE_PROJECT_DIR} for $ARGUMENTS (${CLAUDE_SESSION_ID})', 'prod', { vars }).text)
      .toBe('Run /data/skills/deploy/scripts/go.sh in /work/app for prod (chat-1)')
    expect(expandArguments('Root ${CLAUDE_PLUGIN_ROOT}, data ${CLAUDE_PLUGIN_DATA}, home ${HOME}', '', { vars }).text).toBe('Root /p/root, data ${CLAUDE_PLUGIN_DATA}, home ${HOME}')
    expect(expandArguments('Look in ${CLAUDE_SKILL_DIR}.', 'x', { vars })).toEqual({ text: 'Look in /data/skills/deploy.\n\nx', usedPlaceholder: false })
    expect(expandArguments('${__proto__} ${constructor}', '', { vars }).text).toBe('${__proto__} ${constructor}')
    // A value is inserted as is (no replacement patterns, no second pass).
    expect(expandArguments('${CLAUDE_SKILL_DIR} $1', 'a', { vars: { CLAUDE_SKILL_DIR: '$& $1 ${CLAUDE_PROJECT_DIR}' }, base: 1 }).text).toBe('$& $1 ${CLAUDE_PROJECT_DIR} a')
  })

  it('honors an explicit base', () => {
    expect(expandArguments('$0 $1 $ARGUMENTS[0] $ARGUMENTS[1]', 'a b', { base: 1 }).text).toBe('$0 a $ARGUMENTS[0] a')
    expect(expandArguments('$1 $9', '1 2 3 4 5 6 7 8 9 10', { base: 0 }).text).toBe('2 10')
    expect(expandArguments('$0', 'a', { base: 7 as unknown as 0 }).text).toBe('a')
  })

  it('expands in one pass and never throws', () => {
    expect(expandArguments('[$0] [$ARGUMENTS[1]] [$name]', '$1 ${X} $name', { names: ['name'], vars: { X: 'no' } }).text).toBe('[$1] [${X}] [$1]')
    expect(expandArguments(undefined as unknown as string, 'x', {})).toEqual({ text: '\n\nx', usedPlaceholder: false })
    expect(expandArguments('$0', null as unknown as string, { names: null as unknown as string[], vars: null as unknown as Record<string, string> })).toEqual({ text: '', usedPlaceholder: true })
  })

  it('stays bounded on random bodies', () => {
    let state = 0xA4C
    const random = (): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      return state / 2_147_483_648
    }
    const units = ['$', '0', '1', '9', 'ARGUMENTS', '[', ']', '\\', '{', '}', '{{input}}', 'name', '_x', ' ', '\n', '${CLAUDE_SKILL_DIR}', '$ARGUMENTS[12]', 'é']
    const started = Date.now()
    for (let iteration = 0; iteration < 3000; iteration++) {
      const body = Array.from({ length: Math.floor(random() * 30) }, () => units[Math.floor(random() * units.length)]).join('')
      const result = expandArguments(body, 'one two', { names: ['name', '_x'], vars: { CLAUDE_SKILL_DIR: '/s' } })
      expect(typeof result.text).toBe('string')
      expect([0, 1]).toContain(argumentBase(body))
    }
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
