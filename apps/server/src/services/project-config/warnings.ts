// Review warnings of executable project items (Phase 11, ADR-049; API.md 4.32; ARCHITECTURE.md 6.29). Owner: W11.3.
//
// - `private-network`: an http / sse `.mcp.json` server whose URL host (expanded with the `:-default`s only; a host
//   that comes from a variable without a default is unknown and not flagged) is a loopback, private, link-local,
//   CGNAT, metadata, multicast, unspecified or reserved address (`classifyAddress`), or a local name (`localhost`,
//   `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, or a single label such as `mcp-box`). No DNS lookup
//   is made: the warning describes the URL as written.
// - `referenced-file-missing`: a script file the item names could not be hashed (`sha256: null`).
// - `runs-repository-code`: the item runs code it does not name, so the trust hash cannot pin it: a package manager,
//   build or task runner, or a tool that loads project configuration code (`REPOSITORY_CODE_TOOLS`), or an interpreter
//   running a script or module (`INTERPRETERS`: the script itself is pinned, the files it imports are not). Commands
//   are split with the shared shell parser (else a whitespace split on the shell operators); leading environment
//   assignments and wrappers (`env`, `exec`, `time`, `nice`, `nohup`, `command`, `sudo`, `doas`, `timeout`) are
//   skipped; the program is the base name, lowercase, without `.exe` / `.cmd` / `.bat`.
// Warnings are listed in the order of `trustWarningSchema` without duplicates.
import type { McpJsonServer, TrustRef, TrustWarning } from '@harness-forge/shared'
import { expandVariables, parseShellCommand, trustWarningSchema } from '@harness-forge/shared'
import { classifyAddress } from '../../security/ssrf.ts'

/**
 * Programs that run code of the repository the trust hash does not cover (scripts of `package.json`, a Makefile, build
 * files, test and lint configuration written in code). Fixed by `warnings.test.ts`.
 */
export const REPOSITORY_CODE_TOOLS: ReadonlySet<string> = new Set([
  // Package managers and package runners.
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'yarnpkg',
  'bunx',
  'corepack',
  'uv',
  'uvx',
  'poetry',
  'pipenv',
  'pdm',
  'hatch',
  'pipx',
  'composer',
  'bundle',
  'bundler',
  // Build and task runners.
  'make',
  'gmake',
  'just',
  'task',
  'cargo',
  'go',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
  'ant',
  'sbt',
  'rake',
  'mix',
  'dotnet',
  'bazel',
  'bazelisk',
  'turbo',
  'nx',
  'lerna',
  'cmake',
  'meson',
  'ninja',
  'scons',
  'tox',
  'nox',
  // Test runners, linters and formatters that load code-based configuration.
  'pytest',
  'jest',
  'vitest',
  'mocha',
  'playwright',
  'eslint',
  'prettier',
  'stylelint',
])

/** Interpreters: running a project script or module loads files the hash does not cover. */
export const INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'python',
  'python3',
  'py',
  'pypy',
  'pypy3',
  'ruby',
  'perl',
  'php',
  'lua',
  'rscript',
])

/** Options of an interpreter whose value is inline code (`node -e '…'`, `python3 -c '…'`): not a project file. */
const INLINE_CODE_OPTIONS: ReadonlySet<string> = new Set(['-e', '--eval', '-p', '--print', '-c'])

/** Wrappers that run the next word as the program (their own options are skipped). */
const WRAPPERS: ReadonlySet<string> = new Set(['env', 'exec', 'time', 'nice', 'nohup', 'command', 'sudo', 'doas', 'timeout', 'xargs'])

/** Shells whose `-c` argument is a command string (a stdio server started as `sh -c '…'`). */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

const ASSIGNMENT = /^[A-Z_]\w*=/i
/** Shell operators of the whitespace fallback. */
const OPERATOR_SPLIT = /&&|\|\||[;|\n&]/

/** The lowercase base name of a program word, without quotes and a Windows extension. */
export function programName(word: string): string {
  const unquoted = word.replace(/^["']+|["']+$/g, '')
  const base = unquoted.slice(unquoted.lastIndexOf('/') + 1).toLowerCase()
  return base.replace(/\.(?:exe|cmd|bat)$/, '')
}

/** True when one command (program + arguments, already split) runs code it does not name. */
export function argvRunsRepositoryCode(argv: readonly string[]): boolean {
  let index = 0
  while (index < argv.length && ASSIGNMENT.test(argv[index]!))
    index++
  while (index < argv.length && WRAPPERS.has(programName(argv[index]!))) {
    const wrapper = programName(argv[index]!)
    index++
    while (index < argv.length && (argv[index]!.startsWith('-') || ASSIGNMENT.test(argv[index]!)))
      index++
    // `timeout 10 npm test`: the duration.
    if (wrapper === 'timeout' && index < argv.length && /^\d/.test(argv[index]!))
      index++
  }
  if (index >= argv.length)
    return false
  const program = programName(argv[index]!)
  const args = argv.slice(index + 1)
  if (REPOSITORY_CODE_TOOLS.has(program))
    return true
  if (SHELLS.has(program)) {
    const inline = args.indexOf('-c')
    return inline >= 0 && typeof args[inline + 1] === 'string' && commandRunsRepositoryCode(args[inline + 1]!)
  }
  if (!INTERPRETERS.has(program))
    return false
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (arg === '-m')
      return true
    if (INLINE_CODE_OPTIONS.has(arg)) {
      // The inline code itself; the interpreter runs no project file.
      at++
      continue
    }
    if (!arg.startsWith('-'))
      return true
  }
  return false
}

/** True when a shell command string runs code it does not name (see the module comment). */
export function commandRunsRepositoryCode(command: string): boolean {
  if (typeof command !== 'string' || command.trim() === '')
    return false
  const text = command.slice(0, 65_536)
  const parsed = parseShellCommand(text)
  const segments = parsed.ok
    ? parsed.segments.map(segment => segment.words)
    : text.split(OPERATOR_SPLIT).map(part => part.trim().split(/\s+/).filter(word => word !== '' && word !== '(' && word !== ')'))
  return segments.some(words => argvRunsRepositoryCode(words))
}

const LOCAL_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

/** True when a URL host is a non-public address or a local name. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === '')
    return false
  const kind = classifyAddress(host)
  if (kind !== 'invalid')
    return kind !== 'public'
  if (host === 'localhost' || LOCAL_NAME_SUFFIXES.some(suffix => host.endsWith(suffix)))
    return true
  return !host.includes('.')
}

/** True when a `.mcp.json` URL (with `${VAR:-default}` references) points at a private network or a local name. */
export function urlIsPrivateNetwork(url: string): boolean {
  const expanded = expandVariables(url, {})
  if (!expanded.ok)
    return false
  try {
    return isPrivateHost(new URL(expanded.value).hostname)
  }
  catch {
    return false
  }
}

/** The warnings in `trustWarningSchema` order, without duplicates. */
function ordered(flags: ReadonlySet<TrustWarning>): TrustWarning[] {
  return trustWarningSchema.options.filter(warning => flags.has(warning))
}

function missingRef(refs: readonly TrustRef[]): boolean {
  return refs.some(ref => ref.sha256 === null)
}

/** The warnings of a hook (or of one or more `!` span commands). */
export function commandWarnings(commands: readonly string[], refs: readonly TrustRef[]): TrustWarning[] {
  const flags = new Set<TrustWarning>()
  if (missingRef(refs))
    flags.add('referenced-file-missing')
  if (commands.some(command => commandRunsRepositoryCode(command)))
    flags.add('runs-repository-code')
  return ordered(flags)
}

/** The warnings of a `.mcp.json` server. */
export function mcpServerWarnings(server: McpJsonServer, refs: readonly TrustRef[]): TrustWarning[] {
  const flags = new Set<TrustWarning>()
  const transport = server.transport
  if (transport.type === 'stdio') {
    if (argvRunsRepositoryCode([transport.command, ...transport.args]))
      flags.add('runs-repository-code')
  }
  else if (urlIsPrivateNetwork(transport.url)) {
    flags.add('private-network')
  }
  if (missingRef(refs))
    flags.add('referenced-file-missing')
  return ordered(flags)
}
