import type { CommandTemplatePlan, FileBlock, ShellSpanResult } from './command-template.ts'
import { describe, expect, it } from 'vitest'
import { expandArguments } from './arguments.ts'
import { COMMAND_TEMPLATE_LIMITS, formatShellSpanOutput, planCommandExpansion, renderCommandExpansion } from './command-template.ts'

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function ok(output: string): ShellSpanResult {
  return { exitCode: 0, timedOut: false, output, truncated: false }
}

function file(path: string, content: string): FileBlock {
  return { path, content, truncated: false }
}

/** The body text again (spans and references as written). */
function joined(plan: CommandTemplatePlan): string {
  return plan.parts.map(part => part.kind === 'text' ? part.text : part.kind === 'shell' ? `!\`${part.command}\`` : part.raw).join('')
}

describe('planCommandExpansion', () => {
  it('finds spans and references of a Claude Code command file', () => {
    const body = [
      '## Context',
      '- Current git status: !`git status --short`',
      '- Current branch: !`git branch --show-current`',
      '- Read @README.md and @"docs/user guide.md" (ask me@example.com).',
      '',
      'Review the changes for $ARGUMENTS.',
    ].join('\n')
    const plan = planCommandExpansion(body)
    expect(plan.shellCommands).toEqual(['git status --short', 'git branch --show-current'])
    expect(plan.filePaths).toEqual(['README.md', 'docs/user guide.md'])
    expect(plan.diagnostics).toEqual([])
    expect(plan.parts).toEqual([
      { kind: 'text', text: '## Context\n- Current git status: ' },
      { kind: 'shell', command: 'git status --short', index: 0 },
      { kind: 'text', text: '\n- Current branch: ' },
      { kind: 'shell', command: 'git branch --show-current', index: 1 },
      { kind: 'text', text: '\n- Read ' },
      { kind: 'file', path: 'README.md', raw: '@README.md', index: 0 },
      { kind: 'text', text: ' and ' },
      { kind: 'file', path: 'docs/user guide.md', raw: '@"docs/user guide.md"', index: 1 },
      { kind: 'text', text: ' (ask me@example.com).\n\nReview the changes for $ARGUMENTS.' },
    ])
    expect(joined(plan)).toBe(body)
  })

  it('keeps spans on one line, non-empty and without backticks', () => {
    expect(planCommandExpansion('a !`echo one\ntwo` b').shellCommands).toEqual([])
    expect(planCommandExpansion('!`  ls -la  `').shellCommands).toEqual(['ls -la'])
    const empty = planCommandExpansion('x !`` y !`   ` z')
    expect(empty.shellCommands).toEqual([])
    expect(empty.diagnostics.map(entry => entry.code)).toEqual(['empty-span'])
    expect(planCommandExpansion('!`a``b`').shellCommands).toEqual(['a'])
    expect(planCommandExpansion('!`unclosed').shellCommands).toEqual([])
    expect(planCommandExpansion('not a span: `ls` or ! `ls`').shellCommands).toEqual([])
    expect(planCommandExpansion('status:!`git status`.').shellCommands).toEqual(['git status'])
  })

  it('treats fenced code blocks as text', () => {
    const body = ['Run:', '```sh', '!`rm -rf build`', 'cat @src/a.ts', '```', 'then !`ls` and @b.md', '~~~~', '!`x` @c.md', '~~~', 'still fenced !`y`', '~~~~', 'after !`z`'].join('\n')
    const plan = planCommandExpansion(body)
    expect(plan.shellCommands).toEqual(['ls', 'z'])
    expect(plan.filePaths).toEqual(['b.md'])
    expect(joined(plan)).toBe(body)
    expect(planCommandExpansion('```\n!`never` @a.md').shellCommands).toEqual([])
    expect(planCommandExpansion('``` a`b\n!`runs`\n```').shellCommands).toEqual(['runs'])
    expect(planCommandExpansion('    ```\n!`indented four is no fence`').shellCommands).toEqual(['indented four is no fence'])
  })

  it('recognizes references only where a mention may start and with a dot or a slash', () => {
    const plan = planCommandExpansion('@a.md x@b.md mail@example.com @here @src/ @./c//d.ts @c/d.ts (@e.md) "@f.md"')
    expect(plan.filePaths).toEqual(['a.md', 'src/', 'c/d.ts'])
    expect(plan.parts.filter(part => part.kind === 'file').map(part => part.kind === 'file' ? [part.raw, part.index] : null)).toEqual([['@a.md', 0], ['@src/', 1], ['@./c//d.ts', 2], ['@c/d.ts', 2]])
  })

  it('never takes a reference inside a span', () => {
    const plan = planCommandExpansion('!`cat @secret.txt` and !`grep x @a.md`@b.md @c.md!`ls`')
    expect(plan.shellCommands).toEqual(['cat @secret.txt', 'grep x @a.md', 'ls'])
    expect(plan.filePaths).toEqual([])
  })

  it('refuses paths outside the project', () => {
    const plan = planCommandExpansion('@../outside.md @/etc/passwd @~/x.md @a/../../b.md @C:/x.md @\\\\host\\share.md @ok.md')
    expect(plan.filePaths).toEqual(['ok.md'])
    expect(plan.diagnostics).toEqual([{ level: 'warning', code: 'invalid-path', message: expect.stringContaining('6 file references') as unknown as string }])
  })

  it('caps spans and files', () => {
    const spans = Array.from({ length: 12 }, (_, index) => `!\`echo ${index}\``).join(' ')
    const plan = planCommandExpansion(spans)
    expect(plan.shellCommands).toHaveLength(COMMAND_TEMPLATE_LIMITS.shellSpansMax)
    expect(plan.parts.filter(part => part.kind === 'shell')).toHaveLength(10)
    expect(joined(plan)).toBe(spans)
    expect(plan.diagnostics.map(entry => entry.code)).toEqual(['too-many-spans'])
    const refs = Array.from({ length: 12 }, (_, index) => `@f${index}.md`).join(' ')
    const files = planCommandExpansion(`${refs} @f0.md`)
    expect(files.filePaths).toEqual(Array.from({ length: COMMAND_TEMPLATE_LIMITS.fileRefsMax }, (_, index) => `f${index}.md`))
    expect(files.parts.filter(part => part.kind === 'file')).toHaveLength(11)
    expect(files.diagnostics.map(entry => entry.code)).toEqual(['too-many-files'])
  })

  it('returns plain text for bodies without extras and survives bad input', () => {
    expect(planCommandExpansion('Review $1 carefully.')).toEqual({ parts: [{ kind: 'text', text: 'Review $1 carefully.' }], shellCommands: [], filePaths: [], diagnostics: [] })
    expect(planCommandExpansion('')).toEqual({ parts: [], shellCommands: [], filePaths: [], diagnostics: [] })
    expect(planCommandExpansion(null as unknown as string)).toEqual({ parts: [], shellCommands: [], filePaths: [], diagnostics: [] })
  })
})

describe('formatShellSpanOutput', () => {
  it('formats the output and its notes', () => {
    expect(formatShellSpanOutput(ok(' M a.ts\n?? b.ts\n'))).toBe(' M a.ts\n?? b.ts')
    expect(formatShellSpanOutput(ok(''))).toBe('')
    expect(formatShellSpanOutput({ exitCode: 1, timedOut: false, output: 'fatal: not a git repository\n', truncated: false })).toBe('fatal: not a git repository\n[exit code 1]')
    expect(formatShellSpanOutput({ exitCode: null, timedOut: true, output: 'partial', truncated: true })).toBe('partial\n[output truncated]\n[timed out]')
    expect(formatShellSpanOutput({ exitCode: null, timedOut: false, output: '', truncated: false })).toBe('[did not finish]')
    expect(formatShellSpanOutput({ exitCode: null, timedOut: false, output: '', truncated: false, skipped: 'time-limit' })).toBe('[skipped: time limit]')
    expect(formatShellSpanOutput(null as unknown as ShellSpanResult)).toBe('[skipped]')
  })

  it('cuts the output to 16 KiB of UTF-8', () => {
    const text = formatShellSpanOutput(ok('é'.repeat(10_000)))
    expect(text.endsWith('\n[output truncated]')).toBe(true)
    expect(new TextEncoder().encode(text.replace('\n[output truncated]', '')).length).toBeLessThanOrEqual(COMMAND_TEMPLATE_LIMITS.shellOutputBytes)
    expect(formatShellSpanOutput(ok('😀'.repeat(5000))).includes('\uFFFD')).toBe(false)
  })
})

describe('renderCommandExpansion', () => {
  it('renders exactly like expandArguments without extras', () => {
    for (const [body, input] of [['Review $1 and $2.', 'a.ts "b c"'], ['Fix it.', '  the bug  '], ['Fix it.', ''], ['{{input}} / $ARGUMENTS', 'x'], ['$10 $1', 'one']]) {
      const plan = planCommandExpansion(body as string)
      expect(renderCommandExpansion(plan, { shell: [], files: [] }, input as string)).toEqual(expandArguments(body as string, input as string))
    }
  })

  it('puts span outputs in place and never substitutes arguments into spans', () => {
    const body = 'Status: !`git status --short $1` for $1 ($ARGUMENTS)'
    const plan = planCommandExpansion(body)
    expect(plan.shellCommands).toEqual(['git status --short $1'])
    const rendered = renderCommandExpansion(plan, { shell: [ok('M $ARGUMENTS.ts\n')], files: [] }, 'x; touch pwned')
    expect(rendered).toEqual({ text: 'Status: M $ARGUMENTS.ts for x; ($ARGUMENTS)'.replace('($ARGUMENTS)', '(x; touch pwned)'), usedPlaceholder: true })
  })

  it('computes one argument base for the whole body when options are given (Phase 12)', () => {
    // `$0` sits before the span, `$1` after it: with options both parts count from 0 (Claude Code's indexing).
    const plan = planCommandExpansion('First $0 !`echo hi` second $1')
    const rendered = renderCommandExpansion(plan, { shell: [ok('hi')], files: [] }, 'alpha beta', {})
    expect(rendered).toEqual({ text: 'First alpha hi second beta', usedPlaceholder: true })
    // Without options the Phase 10 meaning stays: `$1` is the first word.
    expect(renderCommandExpansion(planCommandExpansion('Only $1 !`echo hi`'), { shell: [ok('hi')], files: [] }, 'alpha beta'))
      .toEqual({ text: 'Only alpha hi', usedPlaceholder: true })
    // Named arguments make the body 0-based too; an explicit base wins.
    const named = planCommandExpansion('Deploy $env !`echo ok` as $1')
    expect(renderCommandExpansion(named, { shell: [ok('ok')], files: [] }, 'prod web', { names: ['env'] }).text).toBe('Deploy prod ok as web')
    expect(renderCommandExpansion(named, { shell: [ok('ok')], files: [] }, 'prod web', { names: ['env'], base: 1 }).text).toBe('Deploy prod ok as prod')
  })

  it('applies variables and escapes in parts without placeholders when options are given (Phase 12)', () => {
    // eslint-disable-next-line no-template-curly-in-string -- a literal plugin variable reference
    const plan = planCommandExpansion('Root ${CLAUDE_PLUGIN_ROOT} costs \\$5 !`echo hi` then $ARGUMENTS')
    const rendered = renderCommandExpansion(plan, { shell: [ok('hi')], files: [] }, 'go', { vars: { CLAUDE_PLUGIN_ROOT: '/p' } })
    expect(rendered).toEqual({ text: 'Root /p costs $5 hi then go', usedPlaceholder: true })
    // eslint-disable-next-line no-template-curly-in-string -- a literal plugin variable reference
    const noPlaceholder = renderCommandExpansion(planCommandExpansion('At ${CLAUDE_PLUGIN_ROOT} !`echo hi`'), { shell: [ok('hi')], files: [] }, 'x', { vars: { CLAUDE_PLUGIN_ROOT: '/p' } })
    expect(noPlaceholder).toEqual({ text: 'At /p hi\n\nx', usedPlaceholder: false })
  })

  it('appends the input when no text part used a placeholder', () => {
    const plan = planCommandExpansion('Branch: !`git branch --show-current $ARGUMENTS`')
    expect(renderCommandExpansion(plan, { shell: [ok('main')], files: [] }, ' release ')).toEqual({ text: 'Branch: main\n\nrelease', usedPlaceholder: false })
    expect(renderCommandExpansion(plan, { shell: [], files: [] }, '')).toEqual({ text: 'Branch: [skipped]', usedPlaceholder: false })
  })

  it('appends file blocks for the files that were read', () => {
    const plan = planCommandExpansion('Compare @a.md with @"b c.md" and @missing.md, then @a.md again. $ARGUMENTS')
    const rendered = renderCommandExpansion(plan, {
      shell: [],
      files: [file('a.md', '# A\n'), { path: 'b c.md', content: 'x'.repeat(40_000), truncated: false }, null],
    }, 'quickly')
    const blocks = rendered.text.split('\n\n<file')
    expect(blocks[0]).toBe('Compare @a.md with @"b c.md" and @missing.md, then @a.md again. quickly')
    expect(rendered.text).toContain('\n\n<file path="a.md">\n# A\n</file>')
    expect(rendered.text).toContain('<file path="b c.md" truncated="true">\n')
    expect(rendered.text).not.toContain('missing.md">')
    expect(rendered.usedPlaceholder).toBe(true)
    const binary = renderCommandExpansion(planCommandExpansion('See @logo.png'), { shell: [], files: [{ path: 'logo.png', content: '', truncated: false, binary: true }] }, '')
    expect(binary.text).toBe('See @logo.png\n\n<file path="logo.png" binary="true">\n[binary file not inlined]\n</file>')
    const escaped = renderCommandExpansion(planCommandExpansion('@"a&\\"<.md"'), { shell: [], files: [file('x', 'y')] }, '')
    expect(escaped.text).toBe('@"a&\\"<.md"')
    const odd = renderCommandExpansion(planCommandExpansion('@a<b>&.md'), { shell: [], files: [file('a<b>&.md', 'y')] }, 'in')
    expect(odd.text).toBe('@a<b>&.md\n\nin\n\n<file path="a&lt;b>&amp;.md">\ny\n</file>')
  })

  it('survives malformed plans and results', () => {
    expect(renderCommandExpansion(null as unknown as CommandTemplatePlan, null as unknown as { shell: [], files: [] }, 'x')).toEqual({ text: '\n\nx', usedPlaceholder: false })
    const plan = planCommandExpansion('!`a` @b.md')
    expect(renderCommandExpansion(plan, { shell: [null as unknown as ShellSpanResult], files: ['x' as unknown as FileBlock] }, '').text).toBe('[skipped] @b.md')
  })
})

describe('fuzzing', () => {
  it('never throws, keeps the text and stays linear', () => {
    const random = prng(0xC35C)
    const units = ['!`', '`', '!', '@', '@"', '"', ' ', '\n', '```\n', '~~~\n', 'a', '.md', '/', '..', '$1', '$ARGUMENTS', '{{input}}', 'ls', '\t', 'é', '😀', '\0']
    const started = Date.now()
    for (let iteration = 0; iteration < 3000; iteration++) {
      const body = Array.from({ length: Math.floor(random() * 60) }, () => units[Math.floor(random() * units.length)]).join('')
      const plan = planCommandExpansion(body)
      // Span commands are trimmed; everything else is kept as written.
      expect(joined(plan).replace(/\s/g, '')).toBe(body.replace(/\s/g, ''))
      expect(plan.shellCommands.length).toBeLessThanOrEqual(COMMAND_TEMPLATE_LIMITS.shellSpansMax)
      expect(plan.filePaths.length).toBeLessThanOrEqual(COMMAND_TEMPLATE_LIMITS.fileRefsMax)
      for (const command of plan.shellCommands) {
        expect(command).not.toContain('`')
        expect(command).not.toContain('\n')
        expect(command.trim()).toBe(command)
        expect(command).not.toBe('')
      }
      for (const path of plan.filePaths)
        expect(path.split('/')).not.toContain('..')
      const rendered = renderCommandExpansion(plan, { shell: plan.shellCommands.map(() => ok('OUT')), files: plan.filePaths.map(path => file(path, 'C')) }, 'arg')
      expect(typeof rendered.text).toBe('string')
    }
    const large = `${'!`ls` @a.md x '.repeat(20_000)}${'!`'.repeat(50_000)}${'`'.repeat(10)}`
    expect(() => planCommandExpansion(large)).not.toThrow()
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
