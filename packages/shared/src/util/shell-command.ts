// Shell command parser for shell rules (Phase 8, ADR-038): splits a command into segments and matches them against
// command-prefix rules. Shared by the server (enforcement) and the web (the approval card and Settings). Pure and
// isomorphic. Fails closed: anything it cannot tokenize with certainty makes the command ask.
//
// Supported subset of the shell grammar (anything else asks):
// - words separated by unquoted blanks (space, tab); single quotes (literal); double quotes holding only literal text
//   (no `$`, backtick or backslash inside); a backslash outside quotes escapes the next character;
// - segment operators `&&`, `||`, `;`, `|` and an unquoted newline (blank lines are ignored);
// - the redirections `N>&M` / `>&M` (M = 0, 1 or 2), `>/dev/null`, `N>/dev/null`, `>>/dev/null`, which are removed
//   from the words. `&>` asks: dash (the fallback shell) runs `cmd &>/dev/null` as `cmd &` plus a bare redirection.
// The command word of each segment must not be a shell keyword or an environment assignment.
import { LIMITS } from '../limits.ts'
import { WORKSPACE_LIMITS } from '../schemas/workspace.ts'
import { utf8ByteLength } from './text.ts'

/** Why a command can never be allowed by a rule (it always asks). */
export type ShellAskReason
  = | 'empty'
    | 'too-long'
    | 'control-character'
    | 'unterminated-quote'
    | 'expansion'
    | 'substitution'
    | 'redirection'
    | 'heredoc'
    | 'subshell'
    | 'background'
    | 'glob'
    | 'tilde'
    | 'comment'
    | 'keyword'
    | 'assignment'
    | 'too-many-segments'
    /** An empty segment: a leading, trailing or doubled operator (`&& ls`, `ls |`, `ls ;; x`, `ls ;`). */
    | 'syntax'
    /** A backslash inside double quotes, a backslash-newline continuation or a trailing backslash. */
    | 'escape'

/** The operator that ends a segment (`null` for the last one). */
export type ShellOperator = '&&' | '||' | ';' | '|' | '\n'

export interface ShellSegment {
  /** The words of the segment after unquoting (the command word first). */
  words: string[]
  /** The segment's source text, trimmed. */
  raw: string
  /** The operator after this segment, `null` for the last segment. */
  operator: ShellOperator | null
}

export type ShellParseResult
  = | { ok: true, segments: ShellSegment[] }
    | { ok: false, reason: ShellAskReason, detail: string }

/** Why a rule prefix is refused. `shell-builtin`: a builtin that changes the shell or evaluates its arguments. */
export type ShellRuleRejectReason = 'empty' | 'too-long' | 'syntax' | 'command-runner' | 'shell-builtin' | 'interpreter' | 'cd'

export type ShellRuleParseResult
  = | { ok: true, tokens: string[], canonical: string }
    | { ok: false, reason: ShellRuleRejectReason, message: string }

export interface ShellRuleMatchResult {
  /**
   * True when every segment matches a rule or is a `cd <literal>` (the caller must still check `cdTargets` resolve
   * inside the project, in order, each relative to the previous one, starting at the call's working folder).
   */
  allowed: boolean
  /** Why the command always asks (`null` when it parsed). */
  reason: ShellAskReason | null
  /** Canonical prefixes of the rules that matched, unique, in first-match order. */
  matched: string[]
  /** The raw text of every segment no rule matched. */
  unmatched: string[]
  /** The literal targets of `cd` segments, in order. */
  cdTargets: string[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Word lists

/** Reserved words and keywords that ask as the command word of a segment (compared after unquoting). */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'while',
  'until',
  'do',
  'done',
  'function',
  'select',
  'coproc',
  'time',
  '!',
  '[[',
  ']]',
  '((',
  '))',
  '{',
  '}',
])

/** Rules whose first word runs its arguments as a command are refused (`command-runner`). */
const COMMAND_RUNNERS: ReadonlySet<string> = new Set([
  // ADR-038 list.
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'eval',
  'exec',
  'source',
  '.',
  'command',
  'builtin',
  'env',
  'sudo',
  'doas',
  'su',
  'xargs',
  'nohup',
  'nice',
  'timeout',
  'time',
  'watch',
  'stdbuf',
  'chroot',
  'setsid',
  'ssh',
  'parallel',
  // Other shells and wrappers that run their arguments as a command.
  'ash',
  'csh',
  'tcsh',
  'busybox',
  'ionice',
  'taskset',
  'chrt',
  'flock',
  'script',
  'unbuffer',
  'caffeinate',
  'pkexec',
  'runuser',
  'sg',
  'nsenter',
  'unshare',
  'strace',
  'ltrace',
])

/**
 * Shell builtins that change the shell (variables, options, aliases, command lookup, traps) or evaluate their
 * arguments as code: bash evaluates array subscripts in variable names, so `read 'a[$(id)]'` or
 * `printf -v 'a[$(id)]' x` runs a command although the parser sees a single-quoted literal (`shell-builtin`).
 */
const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  'alias',
  'unalias',
  'bind',
  'compgen',
  'complete',
  'compopt',
  'declare',
  'typeset',
  'local',
  'readonly',
  'export',
  'unset',
  'let',
  'enable',
  'fc',
  'getopts',
  'hash',
  'mapfile',
  'readarray',
  'printf',
  'read',
  'set',
  'shopt',
  'test',
  '[',
  'trap',
  'wait',
])

/**
 * Interpreters, package runners and downloaders: a rule must name the script, module or package (`interpreter` when
 * every word after the first is an option, e.g. `node`, `node --test`, `python3 -m`).
 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  // ADR-038 list.
  'node',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'deno',
  'bun',
  'npx',
  'pnpx',
  'bunx',
  // More of the same kind.
  'nodejs',
  'pypy',
  'uvx',
  'pipx',
  'tsx',
  'ts-node',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'lua',
  'luajit',
  'tclsh',
  'rscript',
  'osascript',
  'pwsh',
  'irb',
])

const CD_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd'])

/** Tools whose second word is a subcommand (`git status`, `cargo test`): suggestions include it. */
const MULTI_COMMAND_TOOLS: ReadonlySet<string> = new Set([
  'git',
  'gh',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'npx',
  'pnpx',
  'bunx',
  'cargo',
  'rustup',
  'go',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'terraform',
  'uv',
  'pip',
  'poetry',
  'pipenv',
  'pdm',
  'hatch',
  'pipx',
  'make',
  'dotnet',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
  'composer',
  'bundle',
  'rake',
  'swift',
  'flutter',
  'dart',
  'brew',
  'turbo',
  'nx',
])

/** Subcommands that run a named script or package: suggestions include the name (`pnpm run test`). */
const RUNNER_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  npm: ['run', 'run-script', 'exec', 'x'],
  pnpm: ['run', 'exec', 'dlx'],
  yarn: ['run', 'exec', 'dlx'],
  bun: ['run', 'x'],
  deno: ['run', 'task'],
  uv: ['run'],
  poetry: ['run'],
  pipenv: ['run'],
  pdm: ['run'],
  hatch: ['run'],
  pipx: ['run'],
  bundle: ['exec'],
  composer: ['run', 'run-script', 'exec'],
  turbo: ['run'],
  nx: ['run'],
}

/** Subcommand groups whose next word is the actual subcommand (`docker compose up`, `gh pr view`). */
const NESTED_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  docker: ['compose', 'container', 'image', 'network', 'volume', 'buildx', 'builder', 'system', 'context'],
  podman: ['compose', 'container', 'image', 'network', 'volume', 'system'],
  gh: ['pr', 'issue', 'repo', 'run', 'workflow', 'release', 'gist', 'label', 'secret', 'variable', 'cache'],
  git: ['stash', 'remote', 'submodule', 'worktree'],
  go: ['mod', 'work'],
}

/** Python-like interpreters: `-m <module>` names the program. */
const MODULE_INTERPRETERS: ReadonlySet<string> = new Set(['python', 'python3', 'pypy'])
/** Package runners: `-y` / `--yes` may precede the package. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'pnpx', 'bunx', 'uvx'])

const RULE_MESSAGES: Readonly<Record<ShellRuleRejectReason, string>> = {
  'empty': 'Enter a command prefix, for example pnpm test.',
  'too-long': `Use a prefix of at most ${LIMITS.shellRulePrefixMaxChars} characters.`,
  'syntax': 'Use a plain command without |, ;, &&, redirections, $, globs or shell keywords.',
  'command-runner': 'Commands that run other commands (sh, env, sudo, xargs, timeout, ...) cannot be allowed by a rule.',
  'shell-builtin': 'Shell builtins that change the shell or evaluate their arguments (export, set, printf, test, ...) cannot be allowed by a rule.',
  'interpreter': 'Name the script, module or package too (for example python3 -m pytest or node scripts/build.js).',
  'cd': 'No rule is needed to cd into a folder of the project; pushd and popd always ask.',
}

const ASSIGNMENT = /^[A-Z_]\w*\+?=/i
/** Characters a canonical token may contain without quotes. */
const PLAIN_TOKEN = /^[\w@%+=:,./-]+$/
/** Characters that end an unquoted word (blanks, newline and operator characters). */
const METACHARACTERS: ReadonlySet<string> = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')'])

// ---------------------------------------------------------------------------------------------------------------------
// Lexer

interface LexedSegment extends ShellSegment {
  /** Accepted redirections removed from the words. */
  redirections: number
}

type LexResult
  = | { ok: true, segments: LexedSegment[] }
    | { ok: false, reason: ShellAskReason, detail: string }

class Ask {
  readonly reason: ShellAskReason
  readonly detail: string

  constructor(reason: ShellAskReason, detail: string) {
    this.reason = reason
    this.detail = detail
  }
}

/** True for a C0 or C1 control character other than tab and newline, DEL, or a bidirectional formatting character. */
function isControlCharacter(code: number): boolean {
  if (code < 0x20)
    return code !== 0x09 && code !== 0x0A
  if (code >= 0x7F && code <= 0x9F)
    return true
  return code === 0x061C || code === 0x200E || code === 0x200F || (code >= 0x202A && code <= 0x202E) || (code >= 0x2066 && code <= 0x2069)
}

function isBlankText(value: string): boolean {
  return /^[ \t\n]*$/.test(value)
}

class Lexer {
  private readonly source: string
  private readonly segments: LexedSegment[] = []
  private words: string[] = []
  private redirections = 0
  private segmentStart = -1
  private segmentEnd = -1
  private word: string | null = null
  private wordQuoted = false
  private wordStart = 0
  private index = 0

  constructor(source: string) {
    this.source = source
  }

  run(): LexedSegment[] {
    const { source } = this
    while (this.index < source.length)
      this.step(source[this.index]!)
    this.endWord(source.length)
    if (this.words.length > 0 || this.redirections > 0) {
      this.endSegment(null)
    }
    else {
      const last = this.segments.at(-1)
      if (last === undefined)
        throw new Ask('empty', 'The command is empty.')
      if (last.operator !== '\n')
        throw new Ask('syntax', `The command ends with "${last.operator}".`)
      last.operator = null
    }
    return this.segments
  }

  private step(char: string): void {
    const { source, index } = this
    const next = source[index + 1]
    switch (char) {
      case ' ':
      case '\t':
        this.endWord(index)
        this.index++
        return
      case '\n':
      case ';':
        this.endWord(index)
        this.endSegment(char === ';' ? ';' : '\n')
        this.index++
        return
      case '&':
        this.endWord(index)
        if (next === '&') {
          this.endSegment('&&')
          this.index += 2
        }
        else if (next === '>') {
          throw new Ask('redirection', `"&>" (sh runs the command in the background)${at(index)}.`)
        }
        else {
          throw new Ask('background', `"&" runs a command in the background${at(index)}.`)
        }
        return
      case '|':
        this.endWord(index)
        if (next === '&')
          throw new Ask('redirection', `"|&" pipes standard error${at(index)}.`)
        this.endSegment(next === '|' ? '||' : '|')
        this.index += next === '|' ? 2 : 1
        return
      case '(':
      case ')':
        throw new Ask('subshell', `"${char}" starts or ends a subshell or function${at(index)}.`)
      case '<':
        if (next === '<')
          throw new Ask('heredoc', `A here-document or here-string${at(index)}.`)
        if (next === '(')
          throw new Ask('substitution', `A process substitution${at(index)}.`)
        throw new Ask('redirection', `An input redirection${at(index)}.`)
      case '>':
        this.index = this.outputRedirection(index)
        return
      case '\'':
        this.singleQuote(index)
        return
      case '"':
        this.doubleQuote(index)
        return
      case '\\':
        if (next === undefined)
          throw new Ask('escape', `A trailing backslash${at(index)}.`)
        if (next === '\n')
          throw new Ask('escape', `A line continuation${at(index)}.`)
        this.append(next, true, index)
        this.index += 2
        return
      case '$':
        if (next === '(')
          throw new Ask('substitution', `A command substitution${at(index)}.`)
        throw new Ask('expansion', `A variable or parameter expansion${at(index)}.`)
      case '`':
        throw new Ask('substitution', `A command substitution${at(index)}.`)
      case '*':
      case '?':
      case '[':
        throw new Ask('glob', `A glob pattern "${char}"${at(index)}.`)
      case '{':
      case '}':
        throw new Ask('glob', `A brace "${char}" (brace expansion or group)${at(index)}.`)
      case '#':
        if (this.word === null)
          throw new Ask('comment', `A comment${at(index)}.`)
        break
      case '~':
        if (this.word === null || this.word.endsWith('=') || this.word.endsWith(':'))
          throw new Ask('tilde', `A tilde expansion${at(index)}.`)
        break
    }
    this.append(char, false, index)
    this.index++
  }

  private append(text: string, quoted: boolean, start: number): void {
    if (this.word === null) {
      this.word = ''
      this.wordQuoted = false
      this.wordStart = start
    }
    this.word += text
    if (quoted)
      this.wordQuoted = true
  }

  private touch(start: number, end: number): void {
    if (this.segmentStart < 0)
      this.segmentStart = start
    this.segmentEnd = end
  }

  private endWord(end: number): void {
    const { word } = this
    if (word === null)
      return
    if (this.words.length === 0) {
      if (SHELL_KEYWORDS.has(word))
        throw new Ask('keyword', `The shell keyword "${word}"${at(this.wordStart)}.`)
      if (ASSIGNMENT.test(word))
        throw new Ask('assignment', `An environment assignment before the command${at(this.wordStart)}.`)
    }
    this.words.push(word)
    this.touch(this.wordStart, end)
    this.word = null
  }

  private endSegment(operator: ShellOperator | null): void {
    if (this.words.length === 0 && this.redirections === 0) {
      if (operator === '\n')
        return
      throw new Ask('syntax', `"${operator}" without a command before it${at(this.index)}.`)
    }
    if (this.words.length === 0)
      throw new Ask('redirection', `A redirection without a command${at(this.segmentStart)}.`)
    this.segments.push({
      words: this.words,
      raw: this.source.slice(this.segmentStart, this.segmentEnd),
      operator,
      redirections: this.redirections,
    })
    if (this.segments.length > LIMITS.shellCommandSegmentsMax)
      throw new Ask('too-many-segments', `More than ${LIMITS.shellCommandSegmentsMax} commands.`)
    this.words = []
    this.redirections = 0
    this.segmentStart = -1
    this.segmentEnd = -1
  }

  private isBoundary(index: number): boolean {
    const char = this.source[index]
    return char === undefined || METACHARACTERS.has(char)
  }

  /** `>` at `index`, possibly after a file descriptor number; returns the index after the redirection. */
  private outputRedirection(index: number): number {
    const { source } = this
    let start = index
    let descriptor = false
    if (this.word !== null && !this.wordQuoted && /^\d+$/.test(this.word)) {
      descriptor = true
      start = this.wordStart
      this.word = null
    }
    else {
      this.endWord(index)
    }
    const next = source[index + 1]
    if (next === '(')
      throw new Ask('substitution', `A process substitution${at(index)}.`)
    if (next === '&') {
      const target = source[index + 2]
      if (target !== undefined && target >= '0' && target <= '2' && this.isBoundary(index + 3)) {
        this.redirections++
        this.touch(start, index + 3)
        return index + 3
      }
      throw new Ask('redirection', `A redirection other than to /dev/null or between standard streams${at(index)}.`)
    }
    if (next === '>') {
      if (descriptor)
        throw new Ask('redirection', `A redirection other than to /dev/null or between standard streams${at(index)}.`)
      return this.devNull(start, index + 2)
    }
    if (next === '|')
      throw new Ask('redirection', `A redirection other than to /dev/null or between standard streams${at(index)}.`)
    return this.devNull(start, index + 1)
  }

  /** The target of an output redirection that starts at `start`: optional blanks, then `/dev/null` as a whole word. */
  private devNull(start: number, position: number): number {
    const { source } = this
    let index = position
    while (source[index] === ' ' || source[index] === '\t')
      index++
    const end = index + '/dev/null'.length
    if (source.startsWith('/dev/null', index) && this.isBoundary(end)) {
      this.redirections++
      this.touch(start, end)
      return end
    }
    throw new Ask('redirection', `A redirection other than to /dev/null or between standard streams${at(start)}.`)
  }

  private singleQuote(index: number): void {
    const close = this.source.indexOf('\'', index + 1)
    if (close < 0)
      throw new Ask('unterminated-quote', `A single quote is not closed${at(index)}.`)
    this.append(this.source.slice(index + 1, close), true, index)
    this.index = close + 1
  }

  private doubleQuote(index: number): void {
    const { source } = this
    let cursor = index + 1
    for (; cursor < source.length && source[cursor] !== '"'; cursor++) {
      const char = source[cursor]
      if (char === '$') {
        if (source[cursor + 1] === '(')
          throw new Ask('substitution', `A command substitution inside double quotes${at(cursor)}.`)
        throw new Ask('expansion', `A variable or parameter expansion inside double quotes${at(cursor)}.`)
      }
      if (char === '`')
        throw new Ask('substitution', `A command substitution inside double quotes${at(cursor)}.`)
      if (char === '\\')
        throw new Ask('escape', `A backslash inside double quotes${at(cursor)}.`)
    }
    if (cursor >= source.length)
      throw new Ask('unterminated-quote', `A double quote is not closed${at(index)}.`)
    this.append(source.slice(index + 1, cursor), true, index)
    this.index = cursor + 1
  }
}

function at(index: number): string {
  return ` at character ${index + 1}`
}

function lex(command: string): LexResult {
  if (typeof command !== 'string')
    return { ok: false, reason: 'empty', detail: 'The command is empty.' }
  if (utf8ByteLength(command) > WORKSPACE_LIMITS.commandMaxBytes)
    return { ok: false, reason: 'too-long', detail: `The command is longer than ${WORKSPACE_LIMITS.commandMaxBytes} bytes.` }
  for (let index = 0; index < command.length; index++) {
    if (isControlCharacter(command.charCodeAt(index)))
      return { ok: false, reason: 'control-character', detail: `A control character${at(index)}.` }
  }
  if (isBlankText(command))
    return { ok: false, reason: 'empty', detail: 'The command is empty.' }
  try {
    return { ok: true, segments: new Lexer(command).run() }
  }
  catch (error) {
    if (error instanceof Ask)
      return { ok: false, reason: error.reason, detail: error.detail }
    throw error
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Rules

/**
 * Lower-case base names of a command word, with and without a version suffix: `/usr/bin/Python3.12` →
 * `['python3.12', 'python']` (macOS file systems ignore case, so `BASH` runs bash). A loop, not a regular expression:
 * command words can be 16 KiB long.
 */
function commandNames(word: string): string[] {
  const base = word.slice(word.lastIndexOf('/') + 1).toLowerCase()
  let end = base.length
  let digits = false
  while (end > 0) {
    const char = base[end - 1]!
    if (char >= '0' && char <= '9')
      digits = true
    else if (char !== '.')
      break
    end--
  }
  if (end > 0 && base[end - 1] === '-')
    end--
  const bare = base.slice(0, end)
  return digits && bare !== '' ? [base, bare] : [base]
}

function isAny(names: readonly string[], set: ReadonlySet<string>): boolean {
  return names.some(name => set.has(name))
}

function lookup<T>(names: readonly string[], table: Readonly<Record<string, T>>): T | undefined {
  for (const name of names) {
    if (Object.hasOwn(table, name))
      return table[name]
  }
  return undefined
}

/** Quotes a token for the canonical form (single quotes unless it is plain; `'` as `'\''`). */
function quoteToken(token: string): string {
  return PLAIN_TOKEN.test(token) ? token : `'${token.replaceAll('\'', '\'\\\'\'')}'`
}

function refuse(reason: ShellRuleRejectReason): ShellRuleParseResult {
  return { ok: false, reason, message: RULE_MESSAGES[reason] }
}

function isPrefix(tokens: readonly string[], words: readonly string[]): boolean {
  return tokens.length <= words.length && tokens.every((token, index) => token === words[index])
}

/** The target of a `cd <one literal word>` segment, or `null` for `cd`, `cd -`, `cd -P x`, `cd a b`. */
function cdTarget(words: readonly string[]): string | null {
  const target = words[1]
  return words.length === 2 && target !== undefined && target !== '' && !target.startsWith('-') ? target : null
}

// ---------------------------------------------------------------------------------------------------------------------
// Public API

/** Splits a command into segments (`&&`, `||`, `;`, `|`, unquoted newline) or says why it always asks. */
export function parseShellCommand(command: string): ShellParseResult {
  const result = lex(command)
  if (!result.ok)
    return result
  return { ok: true, segments: result.segments.map(({ words, raw, operator }) => ({ words, raw, operator })) }
}

/** Validates and canonicalizes a rule prefix (`pnpm  test` → tokens `['pnpm', 'test']`, canonical `pnpm test`). */
export function parseShellRule(prefix: string): ShellRuleParseResult {
  if (typeof prefix !== 'string' || isBlankText(prefix))
    return refuse('empty')
  if (prefix.length > LIMITS.shellRulePrefixMaxChars)
    return refuse('too-long')
  const result = lex(prefix)
  if (!result.ok || result.segments.length !== 1)
    return refuse('syntax')
  const segment = result.segments[0]!
  const tokens = segment.words
  const first = tokens[0]
  if (segment.redirections > 0 || first === undefined || first === '')
    return refuse('syntax')
  const names = commandNames(first)
  if (isAny(names, CD_COMMANDS))
    return refuse('cd')
  if (isAny(names, COMMAND_RUNNERS))
    return refuse('command-runner')
  if (isAny(names, SHELL_BUILTINS))
    return refuse('shell-builtin')
  if (isAny(names, INTERPRETERS) && tokens.slice(1).every(token => token.startsWith('-')))
    return refuse('interpreter')
  const canonical = tokens.map(quoteToken).join(' ')
  if (canonical.length > LIMITS.shellRulePrefixMaxChars)
    return refuse('too-long')
  return { ok: true, tokens, canonical }
}

/**
 * Matches every segment of `command` against the rule prefixes in `rules` (invalid rules are ignored). A segment
 * matches when a rule's tokens equal its first words; the longest matching rule is reported. `cd <literal>` needs no
 * rule (its target goes to `cdTargets`); `cd`, `cd -`, `pushd` and `popd` never match.
 */
export function matchShellRules(command: string, rules: readonly string[]): ShellRuleMatchResult {
  const parsed = lex(command)
  if (!parsed.ok)
    return { allowed: false, reason: parsed.reason, matched: [], unmatched: [], cdTargets: [] }
  const compiled: Array<{ tokens: string[], canonical: string }> = []
  for (const rule of rules) {
    const result = parseShellRule(rule)
    if (result.ok)
      compiled.push(result)
  }
  const matched: string[] = []
  const unmatched: string[] = []
  const cdTargets: string[] = []
  for (const { words, raw } of parsed.segments) {
    const first = words[0]
    if (first === 'cd') {
      const target = cdTarget(words)
      if (target === null)
        unmatched.push(raw)
      else
        cdTargets.push(target)
      continue
    }
    let best: { tokens: string[], canonical: string } | null = null
    if (first !== 'pushd' && first !== 'popd') {
      for (const rule of compiled) {
        if (isPrefix(rule.tokens, words) && (best === null || rule.tokens.length > best.tokens.length))
          best = rule
      }
    }
    if (best === null)
      unmatched.push(raw)
    else if (!matched.includes(best.canonical))
      matched.push(best.canonical)
  }
  return { allowed: unmatched.length === 0, reason: null, matched, unmatched, cdTargets }
}

/** A subcommand worth a rule of its own: not an option, no path, assignment or `host:path`. */
function isSubcommand(word: string | undefined): word is string {
  return word !== undefined && word !== '' && !word.startsWith('-') && !/[/=:]/.test(word)
}

/** A script, package or file name after a runner subcommand or an interpreter. */
function isProgramName(word: string | undefined): word is string {
  return word !== undefined && word !== '' && !word.startsWith('-')
}

/** The prefix to suggest for an interpreter segment, or `null` when no safe prefix names the program. */
function interpreterPrefix(words: readonly string[], names: readonly string[]): string[] | null {
  const [command, second, third] = words
  if (command === undefined)
    return null
  if (isProgramName(second))
    return [command, second]
  if (second === '-m' && isAny(names, MODULE_INTERPRETERS) && isProgramName(third))
    return [command, second, third]
  if ((second === '-y' || second === '--yes') && isAny(names, PACKAGE_RUNNERS) && isProgramName(third))
    return [command, second, third]
  return null
}

/** The suggested canonical prefix for one segment, or `null` when no valid rule fits. */
function suggestForSegment(words: readonly string[]): string | null {
  const command = words[0]
  if (command === undefined || command === '')
    return null
  const names = commandNames(command)
  let tokens: string[] = [command]
  if (isAny(names, MULTI_COMMAND_TOOLS) && isSubcommand(words[1])) {
    const sub = words[1]
    tokens = [command, sub]
    if (lookup(names, RUNNER_SUBCOMMANDS)?.includes(sub)) {
      if (!isProgramName(words[2]))
        return null
      tokens.push(words[2])
    }
    else if (lookup(names, NESTED_SUBCOMMANDS)?.includes(sub) && isSubcommand(words[2])) {
      tokens.push(words[2])
    }
  }
  let rule = parseShellRule(tokens.map(quoteToken).join(' '))
  if (!rule.ok && rule.reason === 'interpreter') {
    const prefix = interpreterPrefix(words, names)
    if (prefix === null)
      return null
    rule = parseShellRule(prefix.map(quoteToken).join(' '))
  }
  return rule.ok ? rule.canonical : null
}

/**
 * Rule prefixes to offer for a command: one per segment that needs a rule, deduplicated, in order of appearance
 * (`cd <literal>` segments need none). Per segment: the command word, plus the subcommand of a multi-command tool
 * (`git status`, `pnpm test`), plus the script name after a runner subcommand (`pnpm run test`); for an interpreter the
 * shortest prefix naming the program (`python3 -m pytest`, `node build.js`). Empty when the command always asks or a
 * segment has no valid rule.
 */
export function suggestShellRules(command: string): string[] {
  const parsed = lex(command)
  if (!parsed.ok)
    return []
  const suggestions: string[] = []
  for (const { words } of parsed.segments) {
    if (words[0] === 'cd' && cdTarget(words) !== null)
      continue
    const suggestion = suggestForSegment(words)
    if (suggestion === null)
      return []
    if (!suggestions.includes(suggestion))
      suggestions.push(suggestion)
  }
  // Defensive: never offer rules that would not allow the command they were made for.
  return suggestions.length > 0 && matchShellRules(command, suggestions).allowed ? suggestions : []
}
