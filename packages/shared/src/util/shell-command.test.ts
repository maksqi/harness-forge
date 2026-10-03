import type { ShellAskReason, ShellOperator, ShellRuleRejectReason } from './shell-command.ts'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../limits.ts'
import { WORKSPACE_LIMITS } from '../schemas/workspace.ts'
import { matchShellRules, parseShellCommand, parseShellRule, suggestShellRules } from './shell-command.ts'

function words(command: string): string[][] {
  const result = parseShellCommand(command)
  if (!result.ok)
    throw new Error(`expected ${JSON.stringify(command)} to parse, got ${result.reason}: ${result.detail}`)
  return result.segments.map(segment => segment.words)
}

function reasonOf(command: string): ShellAskReason | null {
  const result = parseShellCommand(command)
  return result.ok ? null : result.reason
}

describe('parseShellCommand: commands that always ask', () => {
  const rows: Array<[string, ShellAskReason]> = [
    // empty, length, control characters
    ['', 'empty'],
    ['   \t \n  ', 'empty'],
    ['x'.repeat(WORKSPACE_LIMITS.commandMaxBytes + 1), 'too-long'],
    [`echo ${'é'.repeat(WORKSPACE_LIMITS.commandMaxBytes / 2)}`, 'too-long'],
    ['ls\r', 'control-character'],
    ['ls\r\npwd', 'control-character'],
    ['ls \0', 'control-character'],
    ['ls \x1B[31m', 'control-character'],
    ['ls \x7F', 'control-character'],
    ['ls \x85', 'control-character'],
    ['ls \v', 'control-character'],
    ['ls \u202Eabc', 'control-character'],
    ['ls \u2066x', 'control-character'],
    // quotes
    ['echo \'abc', 'unterminated-quote'],
    ['echo "abc', 'unterminated-quote'],
    ['echo \'a\'\'', 'unterminated-quote'],
    // expansions and substitutions
    ['echo $HOME', 'expansion'],
    ['echo "$HOME"', 'expansion'],
    ['echo $' + '{HOME}', 'expansion'],
    ['echo $', 'expansion'],
    ['echo a$b', 'expansion'],
    ['echo $\'\\n\'', 'expansion'],
    ['echo $"x"', 'expansion'],
    ['echo $(id)', 'substitution'],
    ['echo $((1 + 2))', 'substitution'],
    ['echo `id`', 'substitution'],
    ['echo "`id`"', 'substitution'],
    ['echo "a $(id)"', 'substitution'],
    ['diff <(ls a) b', 'substitution'],
    ['ls | tee >(cat)', 'substitution'],
    ['ls 2>(cat)', 'substitution'],
    // redirections (other than the accepted ones) and near misses
    ['ls > out.txt', 'redirection'],
    ['ls >out.txt', 'redirection'],
    ['ls >> log.txt', 'redirection'],
    ['cat < in.txt', 'redirection'],
    ['ls 2>err.txt', 'redirection'],
    ['ls >&-', 'redirection'],
    ['ls 2>&-', 'redirection'],
    ['ls 2>&1x', 'redirection'],
    ['ls >&3', 'redirection'],
    ['ls 2>&10', 'redirection'],
    ['ls >& 1', 'redirection'],
    ['ls >/dev/nullx', 'redirection'],
    ['ls > /dev/null2', 'redirection'],
    ['ls >/dev/null/x', 'redirection'],
    ['ls >/dev/nul', 'redirection'],
    ['ls >\'/dev/null\'', 'redirection'],
    ['ls >/dev/null\'\'', 'redirection'],
    ['ls 2>>/dev/null', 'redirection'],
    ['ls &>/dev/null', 'redirection'],
    ['ls &> /dev/null', 'redirection'],
    ['echo 2&>/dev/null', 'redirection'],
    ['ls &>>/dev/null', 'redirection'],
    ['ls >|/dev/null', 'redirection'],
    ['ls |& cat', 'redirection'],
    ['cat <&0', 'redirection'],
    ['cat <> file', 'redirection'],
    ['ls >', 'redirection'],
    ['>/dev/null', 'redirection'],
    ['2>&1 && ls', 'redirection'],
    // here-documents
    ['cat <<EOF', 'heredoc'],
    ['cat <<-EOF', 'heredoc'],
    ['cat <<<word', 'heredoc'],
    // subshells and functions
    ['(ls)', 'subshell'],
    ['ls)', 'subshell'],
    ['echo a(b', 'subshell'],
    ['f() { ls; }', 'subshell'],
    // background
    ['ls &', 'background'],
    ['ls & pwd', 'background'],
    ['ls ;& pwd', 'background'],
    // globs and braces
    ['ls *.ts', 'glob'],
    ['ls file?.txt', 'glob'],
    ['ls [ab].txt', 'glob'],
    ['[ -f x ]', 'glob'],
    ['[[ -f x ]]', 'glob'],
    ['cp a{,.bak}', 'glob'],
    ['{ ls; }', 'glob'],
    ['echo a}', 'glob'],
    ['git stash show stash@{0}', 'glob'],
    // tilde, comments
    ['cat ~/x', 'tilde'],
    ['cd ~', 'tilde'],
    ['ls ~user', 'tilde'],
    ['make DIR=~/x', 'tilde'],
    ['ls a:~/b', 'tilde'],
    ['ls #x', 'comment'],
    ['# just a comment', 'comment'],
    ['ls;#x', 'comment'],
    // keywords (compared after unquoting) and assignments
    ['if true; then ls; fi', 'keyword'],
    ['! ls', 'keyword'],
    ['time ls', 'keyword'],
    ['while x; do y; done', 'keyword'],
    ['until x', 'keyword'],
    ['for x in a b', 'keyword'],
    ['case x in', 'keyword'],
    ['function f', 'keyword'],
    ['select x', 'keyword'],
    ['coproc ls', 'keyword'],
    ['ls; done', 'keyword'],
    [']]', 'keyword'],
    ['\'if\' x', 'keyword'],
    ['\\{ ls', 'keyword'],
    ['\'((\' x', 'keyword'],
    ['>/dev/null then', 'keyword'],
    ['FOO=1 ls', 'assignment'],
    ['FOO+=1 ls', 'assignment'],
    ['FOO=1', 'assignment'],
    ['_x9=a ls', 'assignment'],
    ['\'FOO=1\' ls', 'assignment'],
    ['ls && A= pwd', 'assignment'],
    // empty segments and dangling operators
    ['ls ;; x', 'syntax'],
    ['&& ls', 'syntax'],
    ['; ls', 'syntax'],
    ['| ls', 'syntax'],
    ['ls |', 'syntax'],
    ['ls &&', 'syntax'],
    ['ls ||', 'syntax'],
    ['ls ;', 'syntax'],
    ['ls;\n', 'syntax'],
    ['ls && || pwd', 'syntax'],
    ['ls ||| pwd', 'syntax'],
    ['ls\n&& pwd', 'syntax'],
    ['ls &&\n\n', 'syntax'],
    // backslashes
    ['echo a\\', 'escape'],
    ['echo a \\\nb', 'escape'],
    ['echo "a\\"b"', 'escape'],
    ['echo "\\n"', 'escape'],
    // segment count
    [Array.from({ length: LIMITS.shellCommandSegmentsMax + 1 }).fill('ls').join(' && '), 'too-many-segments'],
  ]

  it.each(rows)('%j asks (%s)', (command, reason) => {
    const result = parseShellCommand(command)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe(reason)
      expect(result.detail.length).toBeGreaterThan(0)
    }
  })
})

describe('parseShellCommand: accepted commands', () => {
  const rows: Array<[string, string[][]]> = [
    ['git status', [['git', 'status']]],
    ['  ls   -la  ', [['ls', '-la']]],
    ['echo \'a b\' "c d" e\\ f', [['echo', 'a b', 'c d', 'e f']]],
    ['echo \'it\'\\\'\'s\'', [['echo', 'it\'s']]],
    ['echo "it\'s"', [['echo', 'it\'s']]],
    ['echo \'\' ""', [['echo', '', '']]],
    ['echo a\'b\'"c"d', [['echo', 'abcd']]],
    ['echo \'$HOME\' \'`id`\' \'*\' \'~\' \'#\' \'(\'', [['echo', '$HOME', '`id`', '*', '~', '#', '(']]],
    ['echo "a;b|c&d>e<f(g)*?[~#{}"', [['echo', 'a;b|c&d>e<f(g)*?[~#{}']]],
    ['echo a\\;b \\$HOME \\* \\~ \\# \\( \\> \\\\', [['echo', 'a;b', '$HOME', '*', '~', '#', '(', '>', '\\']]],
    ['echo \'multi\nline\'', [['echo', 'multi\nline']]],
    ['git log HEAD~1 a~b', [['git', 'log', 'HEAD~1', 'a~b']]],
    ['echo a#b a=b ] ^ ! a! -- %', [['echo', 'a#b', 'a=b', ']', '^', '!', 'a!', '--', '%']]],
    ['echo \'\'~ \'\'#', [['echo', '~', '#']]],
    ['make CC=gcc test', [['make', 'CC=gcc', 'test']]],
    ['=x a', [['=x', 'a']]],
    ['9x=1 a', [['9x=1', 'a']]],
    ['echo héllo 日本 \u00A0x', [['echo', 'héllo', '日本', '\u00A0x']]],
    ['ls\tla', [['ls', 'la']]],
    // operators
    ['ls && pwd || echo no; date | wc -l', [['ls'], ['pwd'], ['echo', 'no'], ['date'], ['wc', '-l']]],
    ['ls&&pwd||x;y|z', [['ls'], ['pwd'], ['x'], ['y'], ['z']]],
    ['ls\npwd', [['ls'], ['pwd']]],
    ['\n\nls\n\n  pwd\n\n', [['ls'], ['pwd']]],
    ['pnpm install &&\n  pnpm test', [['pnpm', 'install'], ['pnpm', 'test']]],
    ['ls |\n  wc -l', [['ls'], ['wc', '-l']]],
    ['ls;\npwd', [['ls'], ['pwd']]],
    // accepted redirections (removed from the words)
    ['pnpm test 2>&1', [['pnpm', 'test']]],
    ['ls >/dev/null', [['ls']]],
    ['ls > /dev/null', [['ls']]],
    ['ls >\t/dev/null', [['ls']]],
    ['ls 2>/dev/null', [['ls']]],
    ['ls 2> /dev/null', [['ls']]],
    ['ls 10>/dev/null', [['ls']]],
    ['ls >>/dev/null', [['ls']]],
    ['ls >> /dev/null', [['ls']]],
    ['ls >&2', [['ls']]],
    ['ls 1>&2', [['ls']]],
    ['ls 0>&1', [['ls']]],
    ['ls >/dev/null 2>&1', [['ls']]],
    ['ls 2>&1>/dev/null', [['ls']]],
    ['2>/dev/null ls -la', [['ls', '-la']]],
    ['pnpm 2>&1 test', [['pnpm', 'test']]],
    ['ls 2>&1 | tail -n 5', [['ls'], ['tail', '-n', '5']]],
    ['ls >/dev/null;pwd', [['ls'], ['pwd']]],
    ['ls 2>&1&&pwd', [['ls'], ['pwd']]],
    // a descriptor number only when unquoted digits touch the operator
    ['echo 2 >/dev/null', [['echo', '2']]],
    ['echo a2>/dev/null', [['echo', 'a2']]],
    ['echo \'2\'>/dev/null', [['echo', '2']]],
    ['echo \\2>/dev/null', [['echo', '2']]],
    // keyword-like words outside the command position
    ['echo if then done ! time', [['echo', 'if', 'then', 'done', '!', 'time']]],
    ['!x', [['!x']]],
  ]

  it.each(rows)('%j', (command, expected) => {
    expect(words(command)).toEqual(expected)
  })

  it('reports the raw text and the operator of each segment', () => {
    const result = parseShellCommand('  git  add -A &&git commit -m "a && b"|| echo \'x;y\' ;  ls 2>&1 |\n wc\n pwd  ')
    expect(result).toEqual({
      ok: true,
      segments: [
        { words: ['git', 'add', '-A'], raw: 'git  add -A', operator: '&&' },
        { words: ['git', 'commit', '-m', 'a && b'], raw: 'git commit -m "a && b"', operator: '||' },
        { words: ['echo', 'x;y'], raw: 'echo \'x;y\'', operator: ';' },
        { words: ['ls'], raw: 'ls 2>&1', operator: '|' },
        { words: ['wc'], raw: 'wc', operator: '\n' },
        { words: ['pwd'], raw: 'pwd', operator: null },
      ],
    })
  })

  it('keeps redirections and escaped blanks in the raw text', () => {
    const result = parseShellCommand('2>/dev/null ls a\\  ;pwd')
    expect(result.ok && result.segments.map(segment => segment.raw)).toEqual(['2>/dev/null ls a\\ ', 'pwd'])
  })

  it('drops a trailing newline: the last segment has no operator', () => {
    const result = parseShellCommand('ls && pwd\n')
    expect(result.ok && result.segments.map(segment => segment.operator)).toEqual<Array<ShellOperator | null>>(['&&', null])
  })

  it('accepts the limits exactly', () => {
    expect(words(`echo ${'é'.repeat((WORKSPACE_LIMITS.commandMaxBytes - 6) / 2)}`)).toHaveLength(1)
    expect(words('x'.repeat(WORKSPACE_LIMITS.commandMaxBytes))).toHaveLength(1)
    expect(words(Array.from({ length: LIMITS.shellCommandSegmentsMax }).fill('ls').join(' | '))).toHaveLength(LIMITS.shellCommandSegmentsMax)
    expect(reasonOf('ls\tx\ny')).toBeNull()
  })
})

describe('parseShellRule', () => {
  const accepted: Array<[string, string[], string]> = [
    ['pnpm test', ['pnpm', 'test'], 'pnpm test'],
    ['  pnpm   test  ', ['pnpm', 'test'], 'pnpm test'],
    ['pnpm \'test\'', ['pnpm', 'test'], 'pnpm test'],
    ['git commit -m \'fix bug\'', ['git', 'commit', '-m', 'fix bug'], 'git commit -m \'fix bug\''],
    ['echo "it\'s"', ['echo', 'it\'s'], 'echo \'it\'\\\'\'s\''],
    ['echo \'\'', ['echo', ''], 'echo \'\''],
    ['echo \'~x\' \'#\' \'$HOME\' \'a b\'', ['echo', '~x', '#', '$HOME', 'a b'], 'echo \'~x\' \'#\' \'$HOME\' \'a b\''],
    ['make CC=gcc', ['make', 'CC=gcc'], 'make CC=gcc'],
    ['git log --format=%H@x,y:z/w.v+u', ['git', 'log', '--format=%H@x,y:z/w.v+u'], 'git log --format=%H@x,y:z/w.v+u'],
    ['/usr/bin/git status', ['/usr/bin/git', 'status'], '/usr/bin/git status'],
    ['ls', ['ls'], 'ls'],
    ['make', ['make'], 'make'],
    ['pnpm', ['pnpm'], 'pnpm'],
    ['python3 -m pytest', ['python3', '-m', 'pytest'], 'python3 -m pytest'],
    ['node scripts/build.js', ['node', 'scripts/build.js'], 'node scripts/build.js'],
    ['npx tsc', ['npx', 'tsc'], 'npx tsc'],
    ['npx -y create-vite', ['npx', '-y', 'create-vite'], 'npx -y create-vite'],
    ['echo', ['echo'], 'echo'],
    ['pnpm test\n', ['pnpm', 'test'], 'pnpm test'],
  ]

  it.each(accepted)('accepts %j', (prefix, tokens, canonical) => {
    expect(parseShellRule(prefix)).toEqual({ ok: true, tokens, canonical })
  })

  const refused: Array<[string, ShellRuleRejectReason]> = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['\n\t', 'empty'],
    ['x'.repeat(LIMITS.shellRulePrefixMaxChars + 1), 'too-long'],
    // The canonical form (`'\''` per quote) would exceed the limit.
    [`e ${'\\\''.repeat(99)}`, 'too-long'],
    ['pnpm test | cat', 'syntax'],
    ['ls; pwd', 'syntax'],
    ['ls && pwd', 'syntax'],
    ['ls\npwd', 'syntax'],
    ['ls >/dev/null', 'syntax'],
    ['ls 2>&1', 'syntax'],
    ['ls > out', 'syntax'],
    ['echo $HOME', 'syntax'],
    ['ls *', 'syntax'],
    ['\'\' x', 'syntax'],
    ['FOO=1 x', 'syntax'],
    ['if', 'syntax'],
    ['\'time\' ls', 'syntax'],
    ['ls &', 'syntax'],
    ['echo \'x', 'syntax'],
    ['ls\r', 'syntax'],
    ['cat ~/x', 'syntax'],
    ['cd', 'cd'],
    ['cd src', 'cd'],
    ['pushd x', 'cd'],
    ['popd', 'cd'],
    ['/usr/bin/cd x', 'cd'],
    ...['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'exec', 'source', '.', 'command', 'builtin', 'env', 'sudo', 'doas', 'su', 'xargs', 'nohup', 'nice', 'timeout', 'watch', 'stdbuf', 'chroot', 'setsid', 'ssh', 'parallel', 'busybox', 'flock', 'script']
      .map((runner): [string, ShellRuleRejectReason] => [`${runner} x`, 'command-runner']),
    ['/bin/sh -c x', 'command-runner'],
    ['BASH -c x', 'command-runner'],
    ['./env x', 'command-runner'],
    ['bash5.2 -c x', 'command-runner'],
    ...['export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'let', 'printf', 'read', 'mapfile', 'readarray', 'set', 'shopt', 'alias', 'trap', 'enable', 'hash', 'test', 'getopts', 'wait']
      .map((builtin): [string, ShellRuleRejectReason] => [`${builtin} x`, 'shell-builtin']),
    ['\'[\' -f x', 'shell-builtin'],
    ...['node', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun', 'npx', 'pnpx', 'bunx', 'uvx', 'tsx', 'awk']
      .map((interpreter): [string, ShellRuleRejectReason] => [interpreter, 'interpreter']),
    ['python3.12', 'interpreter'],
    ['/usr/bin/python3', 'interpreter'],
    ['Node', 'interpreter'],
    ['node --test', 'interpreter'],
    ['python3 -m', 'interpreter'],
    ['node -e', 'interpreter'],
    ['npx -y', 'interpreter'],
  ]

  it.each(refused)('refuses %j (%s)', (prefix, reason) => {
    const result = parseShellRule(prefix)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe(reason)
      expect(result.message).toMatch(/^[A-Z].*\.$/)
    }
  })

  it('has a fixed message for syntax errors', () => {
    const result = parseShellRule('ls | wc')
    expect(!result.ok && result.message).toBe('Use a plain command without |, ;, &&, redirections, $, globs or shell keywords.')
  })

  it('round-trips the canonical form', () => {
    const prefixes = [
      'pnpm test',
      'git commit -m \'fix: a "quoted" bug\'',
      'echo "it\'s" \'\' \'a\tb\'',
      'grep -n \'^foo$\' \'*.ts\'',
      'echo \\~ \\# \\{ \\} \\( \\) \\> \\< \\| \\& \\; \\! \\[ \\* \\?',
      'echo \'multi\nline\' é 日本 \u00A0',
      'printenv \'\'\\\'\'\'',
      'git log --format=%H@x,y:z/w.v+u=-_',
      'make A=1 B=\'two words\'',
    ]
    for (const prefix of prefixes) {
      const first = parseShellRule(prefix)
      expect(first.ok, prefix).toBe(true)
      if (!first.ok)
        continue
      const second = parseShellRule(first.canonical)
      expect(second).toEqual(first)
    }
  })
})

describe('matchShellRules', () => {
  const rows: Array<[string, string[], boolean, string[], string[]]> = [
    // command, rules, allowed, matched, unmatched
    ['pnpm test', ['pnpm test'], true, ['pnpm test'], []],
    ['pnpm test --run x', ['pnpm test'], true, ['pnpm test'], []],
    ['pnpm \'test\'', ['pnpm test'], true, ['pnpm test'], []],
    ['pnpm "test" --run', ['pnpm test'], true, ['pnpm test'], []],
    ['pn\\pm te""st', ['pnpm test'], true, ['pnpm test'], []],
    ['pnpm testx', ['pnpm test'], false, [], ['pnpm testx']],
    ['pnpm -C x test', ['pnpm test'], false, [], ['pnpm -C x test']],
    ['pnpm', ['pnpm test'], false, [], ['pnpm']],
    ['Pnpm test', ['pnpm test'], false, [], ['Pnpm test']],
    ['./pnpm test', ['pnpm test'], false, [], ['./pnpm test']],
    ['pnpm  test', ['pnpm test'], true, ['pnpm test'], []],
    ['pnpm \'test x\'', ['pnpm test'], false, [], ['pnpm \'test x\'']],
    ['git status && pnpm test', ['git status', 'pnpm test'], true, ['git status', 'pnpm test'], []],
    ['pnpm test; git status', ['git status', 'pnpm test'], true, ['pnpm test', 'git status'], []],
    ['git status && rm -rf x', ['git status'], false, ['git status'], ['rm -rf x']],
    ['pnpm test 2>&1 | tail -n 20', ['pnpm test', 'tail'], true, ['pnpm test', 'tail'], []],
    ['ls >/dev/null && ls -la', ['ls'], true, ['ls'], []],
    ['git status; git status', ['git status'], true, ['git status'], []],
    ['pnpm test', ['pnpm', 'pnpm test'], true, ['pnpm test'], []],
    ['pnpm install', ['pnpm', 'pnpm test'], true, ['pnpm'], []],
    ['pnpm test', ['  pnpm  test '], true, ['pnpm test'], []],
    ['git status', ['bad rule |', 'sh', '', 'cd', 'git status'], true, ['git status'], []],
    ['sh -c ls', ['sh'], false, [], ['sh -c ls']],
    ['node -e x', ['node'], false, [], ['node -e x']],
    ['git commit -m \'a b\'', ['git commit -m \'a b\''], true, ['git commit -m \'a b\''], []],
    ['git commit -m "a b" --amend', ['git commit -m \'a b\''], true, ['git commit -m \'a b\''], []],
    ['git commit -m a', ['git commit -m \'a b\''], false, [], ['git commit -m a']],
    ['ls\npwd', ['ls'], false, ['ls'], ['pwd']],
  ]

  it.each(rows)('%j with %j', (command, rules, allowed, matched, unmatched) => {
    expect(matchShellRules(command, rules)).toEqual({ allowed, reason: null, matched, unmatched, cdTargets: [] })
  })

  it('reports why a command always asks', () => {
    expect(matchShellRules('pnpm test > out.txt', ['pnpm test'])).toEqual({ allowed: false, reason: 'redirection', matched: [], unmatched: [], cdTargets: [] })
    expect(matchShellRules('pnpm test $X', ['pnpm'])).toMatchObject({ allowed: false, reason: 'expansion' })
    expect(matchShellRules('', ['pnpm'])).toMatchObject({ allowed: false, reason: 'empty' })
    expect(matchShellRules('FOO=1 pnpm test', ['pnpm test'])).toMatchObject({ allowed: false, reason: 'assignment' })
    expect(matchShellRules('pnpm test &', ['pnpm test'])).toMatchObject({ allowed: false, reason: 'background' })
    // dash runs `cmd &>/dev/null` as `cmd &` (background) plus a bare redirection.
    expect(matchShellRules('pnpm test &>/dev/null', ['pnpm test'])).toEqual({ allowed: false, reason: 'redirection', matched: [], unmatched: [], cdTargets: [] })
  })

  describe('cd', () => {
    const rows: Array<[string, string[], boolean, string[], string[]]> = [
      // command, rules, allowed, cdTargets, unmatched
      ['cd src && pnpm test', ['pnpm test'], true, ['src'], []],
      ['cd src', [], true, ['src'], []],
      ['cd ..', [], true, ['..'], []],
      ['cd /etc', [], true, ['/etc'], []],
      ['cd \'my dir\' && cd sub; ls', ['ls'], true, ['my dir', 'sub'], []],
      ['\\cd x', [], true, ['x'], []],
      ['cd src && rm -rf x', [], false, ['src'], ['rm -rf x']],
      ['cd', [], false, [], ['cd']],
      ['cd -', [], false, [], ['cd -']],
      ['cd \'-\'', [], false, [], ['cd \'-\'']],
      ['cd -P x', [], false, [], ['cd -P x']],
      ['cd -L', [], false, [], ['cd -L']],
      ['cd -- x', [], false, [], ['cd -- x']],
      ['cd a b', [], false, [], ['cd a b']],
      ['cd \'\'', [], false, [], ['cd \'\'']],
      ['pushd x', ['pushd'], false, [], ['pushd x']],
      ['popd', ['popd'], false, [], ['popd']],
      ['builtin cd x', ['builtin'], false, [], ['builtin cd x']],
    ]

    it.each(rows)('%j', (command, rules, allowed, cdTargets, unmatched) => {
      const result = matchShellRules(command, rules)
      expect(result).toMatchObject({ allowed, reason: null, cdTargets, unmatched })
    })

    it('asks for cd with a tilde or a variable', () => {
      expect(matchShellRules('cd ~', [])).toMatchObject({ allowed: false, reason: 'tilde', cdTargets: [] })
      expect(matchShellRules('cd $HOME', [])).toMatchObject({ allowed: false, reason: 'expansion', cdTargets: [] })
    })
  })
})

describe('suggestShellRules', () => {
  const rows: Array<[string, string[]]> = [
    ['git status', ['git status']],
    ['git commit -m "x"', ['git commit']],
    ['git log --oneline -5', ['git log']],
    ['git -C sub status', ['git']],
    ['git stash list', ['git stash list']],
    ['git add . && git commit -m "wip" && git push', ['git add', 'git commit', 'git push']],
    ['git status && git diff --stat', ['git status', 'git diff']],
    ['git status; git status', ['git status']],
    ['/usr/bin/git status', ['/usr/bin/git status']],
    ['pnpm test --run', ['pnpm test']],
    ['pnpm -F web test', ['pnpm']],
    ['pnpm run test', ['pnpm run test']],
    ['pnpm exec tsc --noEmit', ['pnpm exec tsc']],
    ['pnpm dlx @scope/pkg init', ['pnpm dlx @scope/pkg']],
    ['pnpm test 2>&1 | tail -n 50', ['pnpm test', 'tail']],
    ['npm run build', ['npm run build']],
    ['npm run build:prod', ['npm run build:prod']],
    ['npm install', ['npm install']],
    ['yarn build', ['yarn build']],
    ['cargo test', ['cargo test']],
    ['cargo build --release', ['cargo build']],
    ['go test ./...', ['go test']],
    ['go mod tidy', ['go mod tidy']],
    ['uv run pytest -x', ['uv run pytest']],
    ['bun run dev', ['bun run dev']],
    ['bun ./scripts/x.ts', ['bun ./scripts/x.ts']],
    ['deno task dev', ['deno task dev']],
    ['python3 -m pytest -q', ['python3 -m pytest']],
    ['python3 script.py --flag', ['python3 script.py']],
    ['node script.js', ['node script.js']],
    ['npx tsc --noEmit', ['npx tsc']],
    ['npx -y create-vite@latest app', ['npx -y create-vite@latest']],
    ['ls -la', ['ls']],
    ['cat README.md', ['cat']],
    ['rg -n foo src | head', ['rg', 'head']],
    ['make', ['make']],
    ['make test', ['make test']],
    ['docker compose up -d', ['docker compose up']],
    ['docker ps', ['docker ps']],
    ['gh pr view 12', ['gh pr view']],
    ['echo "it\'s"', ['echo']],
    ['cd src && pnpm test', ['pnpm test']],
    ['cd src && cd .. && ls', ['ls']],
    // no suggestion
    ['cd src', []],
    ['cd && ls', []],
    ['pushd x', []],
    ['ls *.ts', []],
    ['pnpm test > out.txt', []],
    ['sudo ls', []],
    ['env FOO=1 ls', []],
    ['export FOO=1', []],
    ['printf x', []],
    ['git status && sh -c x', []],
    ['pnpm run', []],
    ['npm run -s build', []],
    ['deno run -A main.ts', []],
    ['python3 -c "print(1)"', []],
    ['node --version', []],
    ['node -e x', []],
    ['python3 -m', []],
    ['\'\' x', []],
  ]

  it.each(rows)('%j → %j', (command, expected) => {
    expect(suggestShellRules(command)).toEqual(expected)
  })

  it('only suggests valid rules that allow the segment they were made for', () => {
    for (const [command] of rows) {
      const suggestions = suggestShellRules(command)
      if (suggestions.length === 0)
        continue
      for (const suggestion of suggestions)
        expect(parseShellRule(suggestion)).toMatchObject({ ok: true, canonical: suggestion })
      expect(matchShellRules(command, suggestions).allowed).toBe(true)
      const parsed = parseShellCommand(command)
      if (!parsed.ok)
        throw new Error('unreachable')
      for (const segment of parsed.segments) {
        if (segment.words[0] === 'cd')
          continue
        expect(suggestions.some(suggestion => matchShellRules(segment.raw, [suggestion]).allowed), segment.raw).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Seeded fuzzing

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const CHAR_ALPHABET = ['$', '`', '\'', '"', '\\', '<', '>', '|', '&', ';', '(', ')', '{', '}', '*', '?', '[', ']', '~', '#', '=', ' ', '\t', '\n', 'a', 'b', 'c', '/', '-', '1', '2', 'é']
const TOKEN_ALPHABET = [
  'a',
  'b',
  'c',
  'a',
  'b',
  ' ',
  ' ',
  ' ',
  '\t',
  '\n',
  ';',
  '&&',
  '||',
  '|',
  '\'',
  '"',
  '\\',
  '\'a b\'',
  '"b c"',
  '\\ ',
  '\\;',
  '\\$',
  '\'$x\'',
  '$x',
  '`a`',
  '$(a)',
  '(',
  ')',
  '<',
  '>',
  '>>',
  '/dev/null',
  ' >/dev/null',
  '2>/dev/null',
  '2>&1',
  '>&2',
  '&>/dev/null',
  '&',
  '2',
  '1',
  '=',
  '~',
  '#',
  '*',
  '{',
  '}',
  '[',
  ']',
  '!',
  'cd',
  'cd x',
  '-',
]

function randomString(random: () => number, alphabet: readonly string[], maxParts: number): string {
  const parts = Math.floor(random() * (maxParts + 1))
  let value = ''
  for (let index = 0; index < parts; index++)
    value += alphabet[Math.floor(random() * alphabet.length)]
  return value
}

const ACCEPTED_OUTPUT_REDIRECTIONS = [/^>&[0-2](?![^ \t\n;&|<>()])/, /^>>?[ \t]*\/dev\/null(?![^ \t\n;&|<>()])/]

/**
 * Independent check of the fail-closed property: outside single quotes there is no `$` or backtick, outside quotes no
 * `(`, `<` or `&>`, and every unquoted `>` starts `>&0..2` or `>/dev/null` / `>>/dev/null` (then a word boundary).
 */
function unsafeConstruct(command: string): string | null {
  let quote: '' | '\'' | '"' = ''
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote === '\'') {
      if (char === '\'')
        quote = ''
      continue
    }
    if (char === '$' || char === '`')
      return char
    if (quote === '"') {
      if (char === '"')
        quote = ''
      continue
    }
    if (char === '\\') {
      index++
      continue
    }
    if (char === '\'' || char === '"') {
      quote = char
      continue
    }
    if (char === '(' || char === '<')
      return char
    if (char === '&' && command[index + 1] === '>')
      return '&>'
    if (char === '>') {
      const rest = command.slice(index)
      const accepted = ACCEPTED_OUTPUT_REDIRECTIONS.map(pattern => rest.match(pattern)).find(found => found !== null)
      if (accepted === undefined || accepted === null)
        return `> at ${index}`
      index += accepted[0].length - 1
    }
  }
  return null
}

describe('fuzzing', () => {
  function check(command: string): boolean {
    const parsed = parseShellCommand(command)
    if (parsed.ok) {
      expect(parsed.segments.length).toBeGreaterThan(0)
      expect(parsed.segments.at(-1)!.operator).toBeNull()
      for (const segment of parsed.segments) {
        expect(segment.words.length).toBeGreaterThan(0)
        // The raw text of a segment parses to the same words.
        const again = parseShellCommand(segment.raw)
        expect(again.ok && again.segments.map(item => item.words), JSON.stringify(command)).toEqual([segment.words])
      }
    }
    const match = matchShellRules(command, ['a', 'b c'])
    expect(match.allowed && !parsed.ok).toBe(false)
    if (match.allowed) {
      expect(unsafeConstruct(command), JSON.stringify(command)).toBeNull()
      if (parsed.ok) {
        for (const { words } of parsed.segments)
          expect(words[0] === 'a' || (words[0] === 'b' && words[1] === 'c') || words[0] === 'cd', JSON.stringify(command)).toBe(true)
      }
    }
    for (const suggestion of suggestShellRules(command))
      expect(parseShellRule(suggestion)).toMatchObject({ ok: true, canonical: suggestion })
    const rule = parseShellRule(command)
    if (rule.ok)
      expect(parseShellRule(rule.canonical)).toEqual(rule)
    return match.allowed
  }

  it('never throws on random characters and keeps the fail-closed property', () => {
    const random = prng(0x5EED)
    for (let iteration = 0; iteration < 20_000; iteration++)
      check(randomString(random, CHAR_ALPHABET, 16))
  })

  it('keeps the fail-closed property on random token soups', () => {
    const random = prng(20261003)
    let allowed = 0
    for (let iteration = 0; iteration < 20_000; iteration++) {
      if (check(randomString(random, TOKEN_ALPHABET, 10)))
        allowed++
    }
    // The property is exercised: some of the generated commands are allowed.
    expect(allowed).toBeGreaterThan(100)
  })

  it('keeps the fail-closed property on random command lists', () => {
    const random = prng(42)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const commands = ['a', 'b c', 'b', 'cd x', 'cd', 'x', '\'a\'', 'a\\', '"b" c']
    const args = ['-l', 'x', '\'y z\'', '"q"', '\\;', '>/dev/null', '2>&1', '> /dev/null', '&>/dev/null', '>&2', '$x', '`x`', '(', '<x', '>x', '>&3', '2>>/dev/null', '*', '~', '#', '{', '\'$y\'', '"$y"', 'a=b', '\\$', '\\>x']
    const operators = [' && ', ' || ', '; ', ' | ', '\n', ' & ', ';;', '|&']
    let allowed = 0
    for (let iteration = 0; iteration < 10_000; iteration++) {
      const segments = Math.floor(random() * 4) + 1
      let command = ''
      for (let index = 0; index < segments; index++) {
        if (index > 0)
          command += pick(operators)
        command += pick(commands)
        const count = Math.floor(random() * 3)
        for (let arg = 0; arg < count; arg++)
          command += ` ${pick(args)}`
      }
      if (check(command))
        allowed++
    }
    expect(allowed).toBeGreaterThan(500)
  })
})
