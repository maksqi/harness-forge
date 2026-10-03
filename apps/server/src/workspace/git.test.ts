import type { TempGitRepo } from './git.test-util.ts'
// Hardened git runner tests (Phase 8, C21-T1 … T5). Pure parts run everywhere; fake-git tests put a POSIX `sh` script
// named `git` on `PATH`; real-git suites use `describe.skipIf(!hasGit())` with repositories in `realpath(mkdtemp())`
// folders whose `HOME` / `GIT_CONFIG_GLOBAL` stay inside them (./git.test-util.ts). Sentinel scripts touch files inside
// their own temp folder only. Nothing here runs git on the harness-forge repository.
import type { GitHelperOptions, GitStatusEntry } from './git.ts'
import { Buffer } from 'node:buffer'
import { appendFile, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempGitRepo, hasGit, makeTempDir, writeFakeGit } from './git.test-util.ts'
import {
  clearGitMissingCache,
  GIT_ALLOWED_COMMANDS,
  GIT_DRIVERS_MAX,
  GIT_ENV_FIXED,
  GIT_FIXED_ARGS,
  GIT_MISSING_CACHE_MS,
  gitDriverOverrides,
  gitEnvironment,
  gitFilterAttr,
  gitHeadBlob,
  gitPathOf,
  gitRepoInfo,
  gitStatus,
  killLiveGitGroups,
  liveGitGroups,
  parseConfigDrivers,
  parseGitStatus,
  runGit,
} from './git.ts'

const posix = process.platform !== 'win32'
const gitPresent = hasGit()
const temps: string[] = []

async function tempDir(): Promise<string> {
  const dir = await makeTempDir()
  temps.push(dir)
  return dir
}

async function tempRepo(options: Parameters<typeof createTempGitRepo>[0] = {}): Promise<TempGitRepo> {
  const repo = await createTempGitRepo(options)
  temps.push(repo.base)
  return repo
}

/** Helper options for a temp repository: its temp folder is the allowed root, its environment the parent's. */
function helperOptions(repo: TempGitRepo, extra: Partial<GitHelperOptions> = {}): GitHelperOptions {
  return { workspaceRoots: [repo.base], parentEnv: repo.env, ...extra }
}

afterEach(async () => {
  killLiveGitGroups()
  clearGitMissingCache()
  vi.useRealTimers()
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true })
})

/** The error code of `process.kill(pid, 0)`, or null while the process exists. */
function probe(pid: number): string | null {
  try {
    process.kill(pid, 0)
    return null
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown'
  }
}

/** Waits until `process.kill(pid, 0)` throws ESRCH. */
async function expectGone(pid: number, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (probe(pid) === null && Date.now() < deadline)
    await delay(20)
  expect(probe(pid)).toBe('ESRCH')
}

/** Polls `path` until it holds `count` pids (one per line). */
async function readPids(path: string, count: number, ms = 3000): Promise<number[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '')
    const pids = text.split('\n').map(line => Number.parseInt(line, 10)).filter(pid => Number.isInteger(pid) && pid > 0)
    if (pids.length >= count)
      return pids
    if (Date.now() > deadline)
      throw new Error(`no pids in ${path}`)
    await delay(20)
  }
}

/** A short summary of status entries: `[type letter, xy, path, origPath?]`. */
function summary(entries: readonly GitStatusEntry[]): string[][] {
  return entries.map((entry) => {
    if (entry.type === 'untracked')
      return ['?', entry.path]
    if (entry.type === 'renamed')
      return ['2', entry.xy, entry.path, entry.origPath ?? '(outside)']
    return [entry.type === 'ordinary' ? '1' : 'u', entry.xy, entry.path]
  })
}

/** NUL-terminated records. */
function records(...lines: string[]): Buffer {
  return Buffer.concat(lines.map(line => Buffer.from(`${line}\0`, 'utf8')))
}

// ---------- pure parts ----------

describe('fixed arguments and environment (C21-T2, C21-T3)', () => {
  it('starts every command with the fixed overrides', () => {
    expect(GIT_FIXED_ARGS).toEqual([
      '--no-pager',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'diff.external=',
      '-c',
      'core.pager=cat',
      '-c',
      'color.ui=false',
      '-c',
      'core.quotepath=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'safe.bareRepository=explicit',
    ])
    expect(GIT_FIXED_ARGS.some(arg => arg.startsWith('safe.directory'))).toBe(false)
  })

  it('keeps the shell allowlist, drops every inherited GIT_* variable and secrets, and adds the fixed values', () => {
    const env = gitEnvironment('/srv/roots/main', {
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      USER: 'u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'de_DE.UTF-8',
      SHELL: '/bin/zsh',
      GIT_DIR: '/decoy/.git',
      GIT_WORK_TREE: '/decoy',
      GIT_INDEX_FILE: '/decoy/index',
      GIT_OBJECT_DIRECTORY: '/decoy/objects',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: '/decoy/hook',
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='/decoy/hook'`,
      GIT_CONFIG_GLOBAL: '/decoy/gitconfig',
      GIT_CONFIG_SYSTEM: '/decoy/system',
      GIT_CONFIG: '/decoy/config',
      GIT_EXEC_PATH: '/decoy/libexec',
      GIT_TRACE: '/decoy/trace',
      GIT_SSH_COMMAND: '/decoy/ssh',
      GIT_EXTERNAL_DIFF: '/decoy/diff',
      GIT_CEILING_DIRECTORIES: '/',
      GIT_PAGER: '/decoy/pager',
      HF_PASSWORD: 'secret',
      HF_MASTER_KEY: 'secret',
      OPENAI_API_KEY: 'sk-secret',
      NODE_ENV: 'test',
    })
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      USER: 'u',
      LANG: 'en_US.UTF-8',
      TERM: 'dumb',
      NO_COLOR: '1',
      PAGER: 'cat',
      ...GIT_ENV_FIXED,
      LC_ALL: 'C',
      GIT_CEILING_DIRECTORIES: '/srv/roots',
    })
    expect(GIT_ENV_FIXED).toEqual({
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      LC_ALL: 'C',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_NO_LAZY_FETCH: '1',
    })
  })

  it('lists the filter and diff drivers of a configuration (names with dots, spaces and quotes)', () => {
    const output = [
      'filter.lfs.clean',
      'filter.lfs.smudge',
      'filter.lfs.process',
      'filter.lfs.required',
      'filter.a.b.clean',
      'filter.with space.smudge',
      'filter.Q"uote.clean',
      'filter..clean',
      'filter.clean',
      'diff.conv.textconv',
      'diff.external',
      'diff.renames',
      'diff.tool x.command',
      '',
    ].join('\0')
    expect(parseConfigDrivers(output)).toEqual({ filters: ['lfs', 'a.b', 'with space', 'Q"uote', ''], diffs: ['conv', 'tool x'] })
    expect(parseConfigDrivers('')).toEqual({ filters: [], diffs: [] })
    expect(parseConfigDrivers('filter.ok.clean\0filter.x=y.clean\0')).toEqual({ unsupported: 'x=y' })
    expect(parseConfigDrivers('diff.a=b.textconv\0')).toEqual({ unsupported: 'a=b' })
  })

  it('neutralizes each driver program on the command line', () => {
    expect(gitDriverOverrides({ filters: ['lfs'], diffs: ['conv'] })).toEqual([
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false',
      '-c',
      'diff.conv.textconv=',
      '-c',
      'diff.conv.command=',
    ])
    expect(gitDriverOverrides({ filters: [], diffs: [] })).toEqual([])
  })
})

describe('parseGitStatus (C21-T4)', () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const c = 'c'.repeat(40)
  const zero = '0'.repeat(40)

  it('parses every record type and maps the paths through the prefix', () => {
    const output = Buffer.concat([
      records(
        `# branch.oid ${a}`,
        `1 .M N... 100644 100644 100644 ${a} ${a} app/a b.txt`,
        `1 A. N... 000000 100644 100644 ${zero} ${b} app/new.txt`,
        `2 R. N... 100644 100644 100644 ${b} ${b} R100 app/renamed.txt`,
        'app/old.txt',
        `2 R. N... 100755 100755 100755 ${b} ${b} R087 app/moved-in.txt`,
        'lib/elsewhere.txt',
        `u UU N... 100644 100644 100644 100644 ${a} ${b} ${c} app/conflict.txt`,
        '? app/untracked ü.txt',
        '? app/nested/',
        '? lib/outside.txt',
        `1 .M N... 100644 100644 100644 ${a} ${a} lib/outside.txt`,
        '! app/ignored.txt',
      ),
      Buffer.from('? app/'),
      Buffer.from([0xFF, 0xFE, 0x00]),
    ])
    expect(parseGitStatus(output, 'app')).toEqual([
      { type: 'ordinary', path: 'a b.txt', xy: '.M', submodule: 'N...', modeHead: '100644', modeIndex: '100644', modeWorktree: '100644', oidHead: a, oidIndex: a },
      { type: 'ordinary', path: 'new.txt', xy: 'A.', submodule: 'N...', modeHead: '000000', modeIndex: '100644', modeWorktree: '100644', oidHead: zero, oidIndex: b },
      { type: 'renamed', path: 'renamed.txt', origPath: 'old.txt', xy: 'R.', submodule: 'N...', modeHead: '100644', modeIndex: '100644', modeWorktree: '100644', oidHead: b, oidIndex: b, score: 'R100' },
      { type: 'renamed', path: 'moved-in.txt', origPath: null, xy: 'R.', submodule: 'N...', modeHead: '100755', modeIndex: '100755', modeWorktree: '100755', oidHead: b, oidIndex: b, score: 'R087' },
      { type: 'unmerged', path: 'conflict.txt', xy: 'UU', submodule: 'N...', modeStage1: '100644', modeStage2: '100644', modeStage3: '100644', modeWorktree: '100644', oidStage1: a, oidStage2: b, oidStage3: c },
      { type: 'untracked', path: 'untracked ü.txt' },
      { type: 'untracked', path: 'nested/' },
    ])
  })

  it('keeps every path without a prefix', () => {
    const output = records(`1 .D N... 100644 100644 000000 ${a} ${a} lib/x.txt`, '? top.txt')
    expect(summary(parseGitStatus(output, '') ?? [])).toEqual([['1', '.D', 'lib/x.txt'], ['?', 'top.txt']])
  })

  it('answers null for a malformed or unknown record', () => {
    expect(parseGitStatus(records('1 .M N... 100644'), '')).toBeNull()
    expect(parseGitStatus(records(`1 .M N... 1006 100644 100644 ${a} ${a} x`), '')).toBeNull()
    expect(parseGitStatus(records(`2 R. N... 100644 100644 100644 ${a} ${a} X9 x`, 'y'), '')).toBeNull()
    expect(parseGitStatus(records(`2 R. N... 100644 100644 100644 ${a} ${a} R100 x`), '')).toBeNull()
    expect(parseGitStatus(records('x something'), '')).toBeNull()
    expect(parseGitStatus(Buffer.alloc(0), '')).toEqual([])
  })
})

describe('runGit refuses commands outside the read-only allowlist', () => {
  it.each([
    { args: ['diff'] },
    { args: ['checkout', '--', 'x'] },
    { args: ['config', 'core.fsmonitor', 'x'] },
    { args: ['-c', 'a=b', 'status'] },
    { args: [] },
  ])('$args', async ({ args }) => {
    await expect(runGit(args, { cwd: '/tmp', allowedRoot: '/tmp' })).rejects.toThrow(/not an allowed git command/)
  })

  it('allows the plumbing the helpers need', () => {
    expect(GIT_ALLOWED_COMMANDS).toEqual(['rev-parse', 'symbolic-ref', 'status', 'ls-tree', 'ls-files', 'cat-file', 'check-attr'])
  })
})

// ---------- the runner, with a fake git on PATH ----------

/** A fake git answers the driver discovery with "no driver" (exit 1). */
const NO_DRIVERS = 'case " $* " in *" config -z --name-only --get-regexp "*) exit 1 ;; esac'

describe.skipIf(!posix)('runGit with a fake git (C21-T1)', () => {
  async function setup(): Promise<{ base: string, bin: string, root: string, project: string, env: Record<string, string> }> {
    const base = await tempDir()
    const bin = join(base, 'bin')
    const root = join(base, 'root')
    const project = join(root, 'proj')
    await mkdir(project, { recursive: true })
    await mkdir(bin)
    return { base, bin, root, project, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base } }
  }

  it('spawns git with the fixed arguments, the driver overrides and the scrubbed environment', async () => {
    const { base, bin, root, project, env } = await setup()
    const log = join(base, 'log')
    await writeFakeGit(bin, [
      'case " $* " in',
      `  *" config -z --name-only --get-regexp "*) printf 'filter.lfs.clean\\000filter.lfs.process\\000filter.a b.smudge\\000diff.conv.textconv\\000diff.external\\000'; exit 0 ;;`,
      'esac',
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > '${log}.args'`,
      `env > '${log}.env'`,
      `pwd -P > '${log}.cwd'`,
      `printf 'hello'`,
      `printf 'note' >&2`,
    ].join('\n'))
    const result = await runGit(['status', '--porcelain=v2', '--', '.'], {
      cwd: project,
      allowedRoot: root,
      parentEnv: {
        ...env,
        GIT_DIR: '/decoy/.git',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: '/decoy/hook',
        HF_PASSWORD: 'secret',
        OPENAI_API_KEY: 'sk-secret',
      },
    })
    expect(result).toEqual({ ok: true, exitCode: 0, stdout: Buffer.from('hello'), stderr: 'note' })
    const args = (await readFile(`${log}.args`, 'utf8')).split('\n').slice(0, -1)
    expect(args).toEqual([
      ...GIT_FIXED_ARGS,
      ...gitDriverOverrides({ filters: ['lfs', 'a b'], diffs: ['conv'] }),
      'status',
      '--porcelain=v2',
      '--',
      '.',
    ])
    const lines = (await readFile(`${log}.env`, 'utf8')).split('\n').filter(line => line.includes('='))
    const childEnv = Object.fromEntries(lines.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    const gitKeys = (env: object): string[] => Object.keys(env).filter(key => key.startsWith('GIT_'))
    expect(gitKeys(childEnv).sort()).toEqual([...gitKeys(GIT_ENV_FIXED), 'GIT_CEILING_DIRECTORIES'].sort())
    expect(childEnv).toMatchObject({ ...GIT_ENV_FIXED, GIT_CEILING_DIRECTORIES: base, HOME: base })
    expect(childEnv.HF_PASSWORD).toBeUndefined()
    expect(childEnv.OPENAI_API_KEY).toBeUndefined()
    expect((await readFile(`${log}.cwd`, 'utf8')).trim()).toBe(project)
  })

  it('stops the whole process group after the timeout', async () => {
    const { base, bin, root, project, env } = await setup()
    const pids = join(base, 'pids')
    await writeFakeGit(bin, `${NO_DRIVERS}\nsleep 30 &\necho $! > '${pids}'\necho $$ >> '${pids}'\nwait`)
    const result = await runGit(['status'], { cwd: project, allowedRoot: root, parentEnv: env, timeoutMs: 400, killGraceMs: 200 })
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    const [sleepPid = 0, shPid = 0] = await readPids(pids, 2)
    await expectGone(sleepPid)
    await expectGone(shPid)
    expect(liveGitGroups()).toEqual([])
  })

  it('stops the whole process group on abort and rejects with an AbortError', async () => {
    const { base, bin, root, project, env } = await setup()
    const pids = join(base, 'pids')
    await writeFakeGit(bin, `${NO_DRIVERS}\nsleep 30 &\necho $! > '${pids}'\necho $$ >> '${pids}'\nwait`)
    const controller = new AbortController()
    const running = runGit(['status'], { cwd: project, allowedRoot: root, parentEnv: env, signal: controller.signal, killGraceMs: 200 })
    const [sleepPid = 0, shPid = 0] = await readPids(pids, 2)
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    await expectGone(sleepPid)
    await expectGone(shPid)
    expect(liveGitGroups()).toEqual([])
  })

  it('rejects at once when the signal already aborted', async () => {
    const { bin, root, project, env } = await setup()
    await writeFakeGit(bin, `${NO_DRIVERS}\nprintf ran`)
    await expect(runGit(['status'], { cwd: project, allowedRoot: root, parentEnv: env, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.each([
    ['refused', `echo "fatal: detected dubious ownership in repository at '/x'" >&2; exit 128`],
    ['refused', `echo "fatal: cannot use bare repository '/x' (safe.bareRepository is 'explicit')" >&2; exit 128`],
    ['not-a-repo', 'echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128'],
    ['failed', 'echo "fatal: something else" >&2; exit 2'],
    ['failed', 'kill -9 $$'],
  ])('maps a failing git onto %s', async (reason, body) => {
    const { bin, root, project, env } = await setup()
    await writeFakeGit(bin, `${NO_DRIVERS}\n${body}`)
    const result = await runGit(['status'], { cwd: project, allowedRoot: root, parentEnv: env })
    expect(result).toMatchObject({ ok: false, reason })
  })

  it('keeps the first stderr line as the detail of a failure', async () => {
    const { bin, root, project, env } = await setup()
    await writeFakeGit(bin, `${NO_DRIVERS}\necho "" >&2\necho "fatal: something else" >&2\nexit 2`)
    expect(await runGit(['status'], { cwd: project, allowedRoot: root, parentEnv: env })).toEqual({
      ok: false,
      reason: 'failed',
      message: 'git status failed (exit code 2).',
      detail: 'fatal: something else',
    })
  })

  it('accepts the listed exit codes', async () => {
    const { bin, root, project, env } = await setup()
    await writeFakeGit(bin, `${NO_DRIVERS}\nprintf partial\nexit 1`)
    const result = await runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: project, allowedRoot: root, parentEnv: env, okExitCodes: [0, 1] })
    expect(result).toEqual({ ok: true, exitCode: 1, stdout: Buffer.from('partial'), stderr: '' })
  })

  it('fails when stdout passes the cap', async () => {
    const { bin, root, project, env } = await setup()
    await writeFakeGit(bin, `${NO_DRIVERS}\ni=0\nwhile [ "$i" -lt 200 ]; do printf '0123456789'; i=$((i + 1)); done`)
    const options = { cwd: project, allowedRoot: root, parentEnv: env }
    expect(await runGit(['cat-file', 'blob', 'x'], { ...options, maxOutputBytes: 1000 })).toMatchObject({ ok: false, reason: 'failed' })
    const whole = await runGit(['cat-file', 'blob', 'x'], { ...options, maxOutputBytes: 2000 })
    expect(whole.ok && whole.stdout.length).toBe(2000)
    expect(liveGitGroups()).toEqual([])
  })

  it.each([
    ['an unreadable configuration', `echo "fatal: bad config line 1 in file .git/config" >&2; exit 128`],
    ['a driver name with "="', `printf 'filter.ok.clean\\000filter.x=y.clean\\000'; exit 0`],
    ['too many drivers', `i=0; while [ "$i" -le ${GIT_DRIVERS_MAX} ]; do printf 'filter.f%s.clean\\000' "$i"; i=$((i + 1)); done; exit 0`],
  ])('refuses to run git with %s', async (_label, discovery) => {
    const { base, bin, root, project, env } = await setup()
    const ran = join(base, 'ran')
    await writeFakeGit(bin, `case " $* " in *" config -z --name-only --get-regexp "*) ${discovery} ;; esac\ntouch '${ran}'`)
    const result = await runGit(['status'], { cwd: project, allowedRoot: root, parentEnv: env })
    expect(result).toMatchObject({ ok: false, reason: 'refused' })
    await expect(readFile(ran)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers git-missing without git on PATH, remembers it for 60 s per PATH', async () => {
    const { base, bin, root, project, env } = await setup()
    const empty = join(base, 'empty-bin')
    await mkdir(empty)
    const options = { cwd: project, allowedRoot: root, parentEnv: { PATH: empty, HOME: base } }
    expect(await runGit(['status'], options)).toMatchObject({ ok: false, reason: 'git-missing' })
    // Another PATH is not affected.
    await writeFakeGit(bin, `${NO_DRIVERS}\nprintf other`)
    expect(await runGit(['status'], { cwd: project, allowedRoot: root, parentEnv: env })).toMatchObject({ ok: true })
    // git appears, but the answer is cached.
    await writeFakeGit(empty, `${NO_DRIVERS}\nprintf found`)
    expect(await runGit(['status'], options)).toMatchObject({ ok: false, reason: 'git-missing' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + GIT_MISSING_CACHE_MS + 1)
    const found = await runGit(['status'], options)
    expect(found.ok && found.stdout.toString()).toBe('found')
  })

  it('does not take a missing working folder for a missing git', async () => {
    const { bin, root, project, env } = await setup()
    await writeFakeGit(bin, `${NO_DRIVERS}\nprintf ok`)
    expect(await runGit(['status'], { cwd: join(project, 'gone'), allowedRoot: root, parentEnv: env })).toMatchObject({ ok: false, reason: 'failed' })
    expect(await runGit(['status'], { cwd: project, allowedRoot: root, parentEnv: env })).toMatchObject({ ok: true })
  })

  it('refuses a folder outside the allowed root and a root whose parent cannot be a ceiling', async () => {
    const { base, bin, root, env } = await setup()
    await writeFakeGit(bin, `${NO_DRIVERS}\nprintf ok`)
    expect(await runGit(['status'], { cwd: base, allowedRoot: root, parentEnv: env })).toMatchObject({ ok: false, reason: 'refused' })
    const colonRoot = join(base, 'a:b', 'root')
    await mkdir(colonRoot, { recursive: true })
    expect(await runGit(['status'], { cwd: colonRoot, allowedRoot: colonRoot, parentEnv: env })).toMatchObject({ ok: false, reason: 'refused' })
  })
})

// ---------- real git ----------

describe.skipIf(!gitPresent)('gitRepoInfo (C21-T4)', () => {
  it('reads the branch, HEAD and an empty prefix at the repository top', async () => {
    const repo = await tempRepo()
    await repo.write('a.txt', 'a\n')
    const head = await repo.commitAll()
    expect(await gitRepoInfo(repo.dir, helperOptions(repo))).toEqual({ ok: true, branch: 'main', head, prefix: '' })
  })

  it('reads an unborn HEAD (no commit yet) and a detached HEAD', async () => {
    const unborn = await tempRepo({ branch: 'trunk' })
    expect(await gitRepoInfo(unborn.dir, helperOptions(unborn))).toEqual({ ok: true, branch: 'trunk', head: null, prefix: '' })

    const repo = await tempRepo()
    const head = await repo.commitAll()
    await repo.git(['checkout', '-q', '--detach', 'HEAD'])
    expect(await gitRepoInfo(repo.dir, helperOptions(repo))).toEqual({ ok: true, branch: null, head, prefix: '' })
  })

  it('maps a project in a repository subfolder (with spaces and non-ASCII names)', async () => {
    const repo = await tempRepo()
    await repo.write('packages/app ü/index.ts', 'x\n')
    const head = await repo.commitAll()
    const project = join(repo.dir, 'packages', 'app ü')
    expect(await gitRepoInfo(project, helperOptions(repo))).toEqual({ ok: true, branch: 'main', head, prefix: 'packages/app ü' })
  })

  it('answers not-a-repo for a plain folder and for the .git folder itself', async () => {
    const repo = await tempRepo()
    const plain = join(repo.base, 'plain')
    await mkdir(plain)
    expect(await gitRepoInfo(plain, helperOptions(repo))).toMatchObject({ ok: false, reason: 'not-a-repo' })
    expect(await gitRepoInfo(join(repo.dir, '.git'), helperOptions(repo))).toMatchObject({ ok: false, reason: 'not-a-repo' })
  })

  it('never looks above the allowed root (GIT_CEILING_DIRECTORIES), the outermost root counts', async () => {
    const repo = await tempRepo()
    await repo.write('roots/proj/file.txt', 'x\n')
    await repo.commitAll()
    const roots = join(repo.dir, 'roots')
    const project = join(roots, 'proj')
    expect(await gitRepoInfo(project, { workspaceRoots: [roots], parentEnv: repo.env })).toMatchObject({ ok: false, reason: 'not-a-repo' })
    expect(await gitRepoInfo(project, { workspaceRoots: [roots, repo.base], parentEnv: repo.env })).toMatchObject({ ok: true, prefix: 'roots/proj' })
    expect(await gitRepoInfo(project, { workspaceRoots: [join(repo.base, 'elsewhere')], parentEnv: repo.env })).toMatchObject({ ok: false, reason: 'refused' })
  })

  it('ignores an inherited GIT_DIR, GIT_WORK_TREE and GIT_CONFIG_* pointing at a decoy', async () => {
    const repo = await tempRepo()
    await repo.write('tracked.md', 'x\n')
    await repo.commitAll()
    await repo.write('x.txt', 'untracked\n')
    const excludes = join(repo.base, 'decoy-excludes')
    await writeFile(excludes, '*.txt\n')
    const decoyConfig = join(repo.base, 'decoy-gitconfig')
    await writeFile(decoyConfig, `[core]\n\texcludesFile = ${excludes}\n`)
    const parentEnv = {
      ...repo.env,
      GIT_DIR: join(repo.dir, '.git'),
      GIT_WORK_TREE: repo.dir,
      GIT_INDEX_FILE: join(repo.base, 'decoy-index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: excludes,
      GIT_CONFIG_PARAMETERS: `'core.excludesfile'='${excludes}'`,
      GIT_CONFIG_GLOBAL: decoyConfig,
      GIT_CONFIG: decoyConfig,
    }
    const plain = join(repo.base, 'plain')
    await mkdir(plain)
    expect(await gitRepoInfo(plain, { workspaceRoots: [repo.base], parentEnv })).toMatchObject({ ok: false, reason: 'not-a-repo' })
    const status = await gitStatus(repo.dir, { workspaceRoots: [repo.base], parentEnv })
    expect(status.ok && status.entries).toEqual([{ type: 'untracked', path: 'x.txt' }])
  })

  it('refuses a project folder that is a bare repository (safe.bareRepository=explicit)', async () => {
    const repo = await tempRepo()
    const bare = join(repo.base, 'bare.git')
    await repo.git(['init', '-q', '--bare', bare])
    expect(await gitRepoInfo(bare, helperOptions(repo))).toMatchObject({ ok: false, reason: 'refused' })
  })

  it('answers failed for a project folder that is not its own realpath', async () => {
    const repo = await tempRepo()
    await repo.commitAll()
    const link = join(repo.base, 'link')
    await symlink(repo.dir, link)
    expect(await gitRepoInfo(link, helperOptions(repo))).toMatchObject({ ok: false, reason: 'failed' })
  })
})

describe.skipIf(!gitPresent)('gitStatus (C21-T4)', () => {
  it('lists modified, staged, deleted, renamed, added, binary, type-changed and untracked files', async () => {
    const repo = await tempRepo()
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'tc.txt'])
      await repo.write(name, `${name}\n`)
    await repo.write('old.txt', `${lines}\n`)
    await repo.write('bin.dat', Buffer.from([0, 1, 2, 3]))
    const head = await repo.commitAll()
    await repo.write('a.txt', 'a changed\n')
    await repo.write('b.txt', 'b staged\n')
    await repo.git(['add', 'b.txt'])
    await rm(join(repo.dir, 'c.txt'))
    await repo.git(['rm', '-q', 'd.txt'])
    await repo.git(['mv', 'old.txt', 'new.txt'])
    await repo.write('e.txt', 'e\n')
    await repo.git(['add', 'e.txt'])
    await repo.write('u dir/ü.txt', 'u\n')
    await repo.write('bin.dat', Buffer.from([0, 9, 8, 7, 255]))
    await rm(join(repo.dir, 'tc.txt'))
    await symlink('a.txt', join(repo.dir, 'tc.txt'))

    const result = await gitStatus(repo.dir, helperOptions(repo))
    if (!result.ok)
      throw new Error(result.message)
    expect(result).toMatchObject({ branch: 'main', head, prefix: '', truncated: false })
    expect(summary(result.entries)).toEqual([
      ['1', '.M', 'a.txt'],
      ['1', 'M.', 'b.txt'],
      ['1', '.M', 'bin.dat'],
      ['1', '.D', 'c.txt'],
      ['1', 'D.', 'd.txt'],
      ['1', 'A.', 'e.txt'],
      ['2', 'R.', 'new.txt', 'old.txt'],
      ['1', '.T', 'tc.txt'],
      ['?', 'u dir/ü.txt'],
    ])
    expect(result.entries.find(entry => entry.path === 'tc.txt')).toMatchObject({ modeHead: '100644', modeWorktree: '120000' })
    // GIT_OPTIONAL_LOCKS=0: the index is not refreshed, so plain git still sees the same state.
    expect(await repo.git(['status', '--porcelain'])).toContain('R  old.txt -> new.txt')
  })

  it('lists only the entries inside a project in a repository subfolder, with project paths', async () => {
    const repo = await tempRepo()
    await repo.write('app/x.txt', 'x\n')
    await repo.write('app/sub/y.txt', 'y\n')
    await repo.write('lib/z.txt', 'z\n')
    await repo.write('lib/moved.txt', 'moved\n')
    await repo.write('root.txt', 'r\n')
    await repo.commitAll()
    await repo.write('app/x.txt', 'x2\n')
    await repo.write('lib/z.txt', 'z2\n')
    await repo.write('root.txt', 'r2\n')
    await repo.write('app/new.txt', 'n\n')
    await repo.write('lib/new.txt', 'n\n')
    await repo.git(['mv', 'lib/moved.txt', 'app/moved.txt'])
    await repo.git(['mv', 'app/sub/y.txt', 'app/y2.txt'])

    const result = await gitStatus(join(repo.dir, 'app'), helperOptions(repo))
    if (!result.ok)
      throw new Error(result.message)
    expect(result.prefix).toBe('app')
    expect(summary(result.entries)).toEqual([
      ['1', 'A.', 'moved.txt'],
      ['?', 'new.txt'],
      ['1', '.M', 'x.txt'],
      ['2', 'R.', 'y2.txt', 'sub/y.txt'],
    ])
  })

  it('lists a conflicted file as unmerged', async () => {
    const repo = await tempRepo()
    await repo.write('conflict.txt', 'base\n')
    await repo.commitAll()
    await repo.git(['checkout', '-q', '-b', 'other'])
    await repo.write('conflict.txt', 'other\n')
    await repo.commitAll()
    await repo.git(['checkout', '-q', 'main'])
    await repo.write('conflict.txt', 'main\n')
    await repo.commitAll()
    await expect(repo.git(['merge', '-q', 'other'])).rejects.toThrow()
    const result = await gitStatus(repo.dir, helperOptions(repo))
    expect(result.ok && result.entries).toEqual([expect.objectContaining({ type: 'unmerged', path: 'conflict.txt', xy: 'UU' })])
  })

  it('works on an unborn HEAD', async () => {
    const repo = await tempRepo({ branch: 'trunk' })
    await repo.write('staged.txt', 's\n')
    await repo.git(['add', 'staged.txt'])
    await repo.write('untracked.txt', 'u\n')
    const result = await gitStatus(repo.dir, helperOptions(repo))
    if (!result.ok)
      throw new Error(result.message)
    expect(result).toMatchObject({ branch: 'trunk', head: null, prefix: '', truncated: false })
    expect(summary(result.entries)).toEqual([['1', 'A.', 'staged.txt'], ['?', 'untracked.txt']])
  })

  it(`keeps the first ${LIMITS.gitStatusFilesMax} entries by path and reports truncated`, async () => {
    const repo = await tempRepo()
    await repo.commitAll()
    const count = LIMITS.gitStatusFilesMax + 1
    for (let start = 0; start < count; start += 100) {
      const batch = Array.from({ length: Math.min(100, count - start) }, (_, offset) => start + offset)
      await Promise.all(batch.map(index => repo.write(`f${String(index).padStart(4, '0')}.txt`, `${index}\n`)))
    }
    const result = await gitStatus(repo.dir, helperOptions(repo))
    if (!result.ok)
      throw new Error(result.message)
    expect(result.truncated).toBe(true)
    expect(result.entries).toHaveLength(LIMITS.gitStatusFilesMax)
    expect(result.entries[0]?.path).toBe('f0000.txt')
    expect(result.entries.at(-1)?.path).toBe(`f${String(LIMITS.gitStatusFilesMax - 1).padStart(4, '0')}.txt`)
  })
})

describe.skipIf(!gitPresent)('gitHeadBlob (C21-T4)', () => {
  async function fixture(): Promise<{ repo: TempGitRepo, gitlink: string }> {
    const repo = await tempRepo()
    await repo.write('hello.txt', 'hello\n')
    await repo.write('run.sh', '#!/bin/sh\necho hi\n', 0o755)
    await repo.write('target.txt', 't\n')
    await symlink('target.txt', join(repo.dir, 'link'))
    await repo.write('bin.dat', Buffer.from([0, 1, 2, 255]))
    await repo.write('dir/inner.txt', 'inner\n')
    await repo.write('a.md', 'markdown\n')
    await repo.write('app/f.txt', 'in app\n')
    const gitlink = await repo.commitAll()
    // A submodule entry (mode 160000) without cloning anything.
    await repo.git(['update-index', '--add', '--cacheinfo', `160000,${gitlink},mod`])
    await repo.git(['commit', '-q', '--no-verify', '-m', 'gitlink'])
    return { repo, gitlink }
  }

  it('reads files, executables, links and submodules at HEAD', async () => {
    const { repo, gitlink } = await fixture()
    const options = helperOptions(repo)
    expect(await gitHeadBlob(repo.dir, 'hello.txt', options)).toEqual({
      ok: true,
      blob: { mode: '100644', kind: 'file', oid: (await repo.git(['rev-parse', 'HEAD:hello.txt'])).trim(), size: 6, content: Buffer.from('hello\n'), tooLarge: false },
    })
    expect(await gitHeadBlob(repo.dir, 'run.sh', options)).toMatchObject({ ok: true, blob: { mode: '100755', kind: 'executable' } })
    expect(await gitHeadBlob(repo.dir, 'link', options)).toMatchObject({ ok: true, blob: { mode: '120000', kind: 'symlink', content: Buffer.from('target.txt') } })
    expect(await gitHeadBlob(repo.dir, 'mod', options)).toEqual({ ok: true, blob: { mode: '160000', kind: 'submodule', oid: gitlink, size: null, content: null, tooLarge: false } })
    expect(await gitHeadBlob(repo.dir, 'bin.dat', options)).toMatchObject({ ok: true, blob: { content: Buffer.from([0, 1, 2, 255]), size: 4 } })
  })

  it('reads a file deleted on disk, and answers null for paths HEAD does not hold as a file', async () => {
    const { repo } = await fixture()
    const options = helperOptions(repo)
    await rm(join(repo.dir, 'hello.txt'))
    await rm(join(repo.dir, 'dir'), { recursive: true })
    expect(await gitHeadBlob(repo.dir, 'hello.txt', options)).toMatchObject({ ok: true, blob: { content: Buffer.from('hello\n') } })
    expect(await gitHeadBlob(repo.dir, 'dir/inner.txt', options)).toMatchObject({ ok: true, blob: { content: Buffer.from('inner\n') } })
    expect(await gitHeadBlob(repo.dir, 'missing.txt', options)).toEqual({ ok: true, blob: null })
    expect(await gitHeadBlob(repo.dir, 'app', options)).toEqual({ ok: true, blob: null })
    // Paths are literal: no globs, no pathspec magic.
    expect(await gitHeadBlob(repo.dir, '*.md', options)).toEqual({ ok: true, blob: null })
    expect(await gitHeadBlob(repo.dir, ':(top)a.md', options)).toEqual({ ok: true, blob: null })
  })

  it('reports a blob over the cap without reading it', async () => {
    const { repo } = await fixture()
    expect(await gitHeadBlob(repo.dir, 'hello.txt', { ...helperOptions(repo), maxBytes: 3 })).toMatchObject({
      ok: true,
      blob: { kind: 'file', size: 6, content: null, tooLarge: true },
    })
  })

  it('maps the path through the project folder of a repository subfolder', async () => {
    const { repo } = await fixture()
    expect(await gitHeadBlob(join(repo.dir, 'app'), 'f.txt', helperOptions(repo))).toMatchObject({ ok: true, blob: { content: Buffer.from('in app\n') } })
  })

  it('answers null on an unborn HEAD', async () => {
    const repo = await tempRepo()
    expect(await gitHeadBlob(repo.dir, 'x.txt', helperOptions(repo))).toEqual({ ok: true, blob: null })
  })

  it('refuses paths outside the project through the path guard', async () => {
    const { repo } = await fixture()
    const options = helperOptions(repo)
    const outside = join(repo.base, 'outside')
    await mkdir(outside)
    await symlink(outside, join(repo.dir, 'out'))
    for (const path of ['../x', join(repo.base, 'x'), '.', 'out/x.txt', 'bad\nname'])
      await expect(gitHeadBlob(repo.dir, path, options)).rejects.toMatchObject({ code: 'validation_error' })
    // A final link is not followed: git reads it as a link, even when it points outside.
    await symlink(outside, join(repo.dir, 'leaf-link'))
    expect(await gitPathOf(repo.dir, 'leaf-link')).toBe('leaf-link')
    expect(await gitPathOf(repo.dir, `${repo.dir}/dir/../hello.txt`)).toBe('hello.txt')
  })
})

describe.skipIf(!gitPresent)('gitFilterAttr (C21-T4)', () => {
  it('reports the filter attribute of each path (LFS and other drivers)', async () => {
    const repo = await tempRepo()
    await repo.write('.gitattributes', '*.bin filter=lfs\nbig/** filter=lfs\nplain.bin -filter\nx.dat filter\n')
    await repo.commitAll()
    const result = await gitFilterAttr(repo.dir, ['a.bin', 'plain.bin', 'readme.md', 'big/z.txt', 'x.dat', 'sub/../a.bin'], helperOptions(repo))
    expect(result.ok && Object.fromEntries(result.filters)).toEqual({
      'a.bin': 'lfs',
      'plain.bin': null,
      'readme.md': null,
      'big/z.txt': 'lfs',
      'x.dat': 'set',
    })
  })

  it('splits many paths over several commands', async () => {
    const repo = await tempRepo()
    await repo.write('.gitattributes', '*.bin filter=lfs\n')
    await repo.commitAll()
    const paths = Array.from({ length: 600 }, (_, index) => `f${index}.${index % 2 === 0 ? 'bin' : 'txt'}`)
    const result = await gitFilterAttr(repo.dir, paths, helperOptions(repo))
    if (!result.ok)
      throw new Error(result.message)
    expect(result.filters.size).toBe(600)
    expect(result.filters.get('f598.bin')).toBe('lfs')
    expect(result.filters.get('f599.txt')).toBeNull()
  })

  it('answers an empty map for no paths without running git', async () => {
    expect(await gitFilterAttr('/nowhere', [], { workspaceRoots: [] })).toEqual({ ok: true, filters: new Map() })
  })
})

describe.skipIf(!gitPresent)('runGit with a real git (C21-T1)', () => {
  it('fails when a blob passes the output cap', async () => {
    const repo = await tempRepo()
    await repo.write('big.txt', 'x'.repeat(5000))
    await repo.commitAll()
    const oid = (await repo.git(['rev-parse', 'HEAD:big.txt'])).trim()
    const options = { cwd: repo.dir, allowedRoot: repo.base, parentEnv: repo.env }
    expect(await runGit(['cat-file', 'blob', oid], { ...options, maxOutputBytes: 1000 })).toMatchObject({ ok: false, reason: 'failed' })
    const whole = await runGit(['cat-file', 'blob', oid], options)
    expect(whole.ok && whole.stdout.length).toBe(5000)
  })
})

// ---------- C21-T5: the sentinel suite ----------

/** Hooks that commit, checkout and index changes would run (none reads stdin). */
const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'post-index-change', 'post-merge', 'pre-auto-gc']

describe.skipIf(!gitPresent || !posix)('sentinel suite: no program configured by the repository runs (C21-T5)', () => {
  it('runs none of them in gitRepoInfo, gitStatus, gitHeadBlob, gitFilterAttr and runGit', async () => {
    const repo = await tempRepo()
    const sentinels = join(repo.base, 'sentinels')
    const scripts = join(repo.base, 'scripts')
    await mkdir(sentinels)
    await mkdir(scripts)
    const fired = async (): Promise<string[]> => (await readdir(sentinels)).sort()

    /** A POSIX script that touches `<sentinels>/<name>`, then runs `tail` (filters pass their input through). */
    async function sentinel(name: string, tail = ''): Promise<string> {
      const path = join(scripts, `${name}.sh`)
      await writeFile(path, `#!/bin/sh\ntouch '${join(sentinels, name)}'\n${tail}\n`, { mode: 0o755 })
      return path
    }

    // Files committed with old timestamps, so the first refresh compares no content.
    const filtered = ['a.c', 'm.i', 'n.w', 'z.p']
    await repo.write('.gitattributes', '*.c filter=evil\n*.i filter=chain\n*.w filter=wt\n*.p filter=proc\n*.t diff=conv\n')
    for (const name of [...filtered, 't.t', 'plain.txt'])
      await repo.write(name, `${name}\n`)
    const past = new Date(Date.now() - 86_400_000)
    for (const name of [...filtered, 't.t', 'plain.txt', '.gitattributes'])
      await utimes(join(repo.dir, name), past, past)
    await repo.commitAll('init')

    // The hostile configuration: every program-running key we know of, an include chain and a worktree config.
    const hooks = join(repo.base, 'hooks')
    await mkdir(hooks)
    for (const hook of HOOKS) {
      const body = `#!/bin/sh\ntouch '${join(sentinels, `hook-${hook}`)}'\n`
      await writeFile(join(hooks, hook), body, { mode: 0o755 })
      await writeFile(join(repo.dir, '.git', 'hooks', hook), body, { mode: 0o755 })
    }
    const include2 = join(repo.base, 'include-2.gitconfig')
    await writeFile(include2, `[filter "chain"]\n\tclean = ${await sentinel('include-chain-clean', 'exec cat')}\n\trequired = true\n`)
    const include1 = join(repo.base, 'include-1.gitconfig')
    await writeFile(include1, `[include]\n\tpath = ${include2}\n`)
    await writeFile(join(repo.dir, '.git', 'config.worktree'), `[filter "wt"]\n\tclean = ${await sentinel('worktree-clean', 'exec cat')}\n\trequired = true\n`)
    await appendFile(join(repo.dir, '.git', 'config'), [
      '[core]',
      `\tfsmonitor = ${await sentinel('fsmonitor')}`,
      `\thooksPath = ${hooks}`,
      `\tpager = ${await sentinel('core-pager', 'exec cat')}`,
      `\tsshCommand = ${await sentinel('ssh-command')}`,
      `\taskPass = ${await sentinel('askpass')}`,
      `\teditor = ${await sentinel('editor')}`,
      `\talternateRefsCommand = ${await sentinel('alternate-refs')}`,
      `\tgitProxy = ${await sentinel('git-proxy')}`,
      '\trepositoryFormatVersion = 1',
      '[extensions]',
      '\tworktreeConfig = true',
      '[pager]',
      `\tstatus = ${await sentinel('pager-status', 'exec cat')}`,
      '[diff]',
      `\texternal = ${await sentinel('diff-external')}`,
      '[diff "conv"]',
      `\ttextconv = ${await sentinel('textconv', 'cat "$1"')}`,
      `\tcommand = ${await sentinel('diff-command')}`,
      '[filter "evil"]',
      `\tclean = ${await sentinel('filter-clean', 'exec cat')}`,
      `\tsmudge = ${await sentinel('filter-smudge', 'exec cat')}`,
      '\trequired = true',
      '[filter "proc"]',
      `\tprocess = ${await sentinel('filter-process', 'exit 1')}`,
      '\trequired = true',
      '[credential]',
      `\thelper = ${await sentinel('credential-helper')}`,
      '[gpg]',
      `\tprogram = ${await sentinel('gpg')}`,
      '[sequence]',
      `\teditor = ${await sentinel('sequence-editor')}`,
      '[uploadpack]',
      `\tpackObjectsHook = ${await sentinel('pack-objects-hook')}`,
      '[remote "origin"]',
      `\turl = ext::${await sentinel('remote-ext')}`,
      '[include]',
      `\tpath = ${include1}`,
      '',
    ].join('\n'))

    // Controls: plain git (no hardening) does run these programs here, so the assertions below prove something.
    await repo.git(['commit', '-q', '--allow-empty', '-m', 'control'])
    await repo.write('plain.txt', 'changed\n')
    await repo.write('t.t', 'changed\n')
    await repo.git(['diff'])
    await repo.git(['diff', '--no-ext-diff'])
    await rm(join(repo.dir, 'a.c'))
    await repo.git(['checkout', '--', 'a.c'])
    const soon = new Date(Date.now() + 86_400_000)
    for (const name of filtered)
      await utimes(join(repo.dir, name), soon, soon)
    // The process filter dies (and with it this status) after the clean filters ran.
    await repo.git(['status', '--porcelain']).catch(() => '')
    expect(await fired()).toEqual(expect.arrayContaining([
      'diff-command',
      'diff-external',
      'filter-clean',
      'filter-process',
      'filter-smudge',
      'fsmonitor',
      'hook-commit-msg',
      'hook-pre-commit',
      'include-chain-clean',
      'textconv',
      'worktree-clean',
    ]))

    // The hardened runner: same repository, files stat-dirty again (content compared, so filters would run).
    await rm(sentinels, { recursive: true })
    await mkdir(sentinels)
    const later = new Date(Date.now() + 2 * 86_400_000)
    for (const name of filtered)
      await utimes(join(repo.dir, name), later, later)
    const options = helperOptions(repo, {
      parentEnv: {
        ...repo.env,
        GIT_TRACE: join(sentinels, 'env-trace'),
        GIT_TRACE2_EVENT: join(sentinels, 'env-trace2'),
        GIT_EXTERNAL_DIFF: await sentinel('env-external-diff'),
        GIT_SSH_COMMAND: await sentinel('env-ssh'),
        GIT_ASKPASS: await sentinel('env-askpass'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: await sentinel('env-fsmonitor'),
      },
    })

    expect(await gitRepoInfo(repo.dir, options)).toMatchObject({ ok: true, branch: 'main' })
    const status = await gitStatus(repo.dir, options)
    if (!status.ok)
      throw new Error(status.message)
    expect(summary(status.entries)).toEqual([['1', '.M', 'plain.txt'], ['1', '.M', 't.t']])
    for (const path of [...filtered, 't.t', 'plain.txt'])
      expect(await gitHeadBlob(repo.dir, path, options)).toMatchObject({ ok: true, blob: { kind: 'file' } })
    const attributes = await gitFilterAttr(repo.dir, [...filtered, 't.t'], options)
    expect(attributes.ok && Object.fromEntries(attributes.filters)).toEqual({ 'a.c': 'evil', 'm.i': 'chain', 'n.w': 'wt', 'z.p': 'proc', 't.t': null })
    const run = { cwd: repo.dir, allowedRoot: repo.base, parentEnv: options.parentEnv, okExitCodes: [0, 1, 128] }
    for (const args of [
      ['status', '--porcelain=v2'],
      ['status', '-v'],
      ['ls-files', '-m'],
      ['cat-file', '--textconv', 'HEAD:t.t'],
      ['cat-file', '--filters', 'HEAD:a.c'],
    ])
      await runGit(args, run)

    expect(await fired()).toEqual([])
  })
})
