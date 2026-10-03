// Test helpers for code that runs git (Phase 8, C21-T6; used by git.test.ts and the changes panel tests of W8.2 /
// W8.3). TEST CODE ONLY: the setup of temp repositories runs git directly through `execFile` (argument arrays, never a
// shell); the code under test runs git only through ./git.ts.
//
// Safety: every repository lives in its own `realpath(mkdtemp())` folder, which is also `HOME` (`GIT_CONFIG_GLOBAL` =
// `<base>/.gitconfig`); the environment is built from scratch (only `PATH` is inherited: a parent `GIT_DIR` or
// `GIT_INDEX_FILE`, e.g. from a git hook running the tests, would point at the harness-forge repository), discovery
// stops above the temp folder (`GIT_CEILING_DIRECTORIES`), and `git()` refuses a working folder outside it. The author
// is set with `-c user.name=… -c user.email=…`; nothing is ever written to the harness-forge repository.
import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { isWithin } from '../plugins/scaffold/paths.ts'

const execFileAsync = promisify(execFile)

/** The author and the defaults of every test git command. */
export const TEST_GIT_CONFIG: readonly string[] = Object.freeze([
  '-c',
  'user.name=harness-forge test',
  '-c',
  'user.email=test@harness-forge.invalid',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
])

let gitAvailable: boolean | undefined

/** True when a `git` binary runs (`git --version`); checked once. Use with `describe.skipIf(!hasGit())`. */
export function hasGit(): boolean {
  if (gitAvailable === undefined) {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '' }, timeout: 10_000 })
      gitAvailable = true
    }
    catch {
      gitAvailable = false
    }
  }
  return gitAvailable
}

/** A new canonical temp folder (`realpath(mkdtemp(<tmpdir>/hf-git-))`; macOS `/var` is a link to `/private/var`). */
export async function makeTempDir(prefix = 'hf-git-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

/**
 * The environment of test git commands, and the `parentEnv` to pass to the runner in tests: `PATH` of this process,
 * `HOME` = `home`, `GIT_CONFIG_GLOBAL` = `<home>/.gitconfig`, no system configuration, the C locale, discovery bounded
 * by `dirname(home)`. Nothing else is inherited.
 */
export function gitTestEnv(home: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: dirname(home),
    LC_ALL: 'C',
    ...extra,
  }
}

export interface TempGitRepoOptions {
  /** Temp folder to use (default: a new `makeTempDir()`); it becomes `HOME`. */
  readonly base?: string
  /** The work tree, relative to `base` (default `repo`). */
  readonly path?: string
  /** Initial branch (default `main`). */
  readonly branch?: string
  /** Run `git init` (default true); false only creates the folder. */
  readonly init?: boolean
}

export interface TempGitRepo {
  /** The temp folder that holds everything (also `HOME`); `cleanup()` removes it. */
  readonly base: string
  /** The work tree (canonical). */
  readonly dir: string
  /** The environment of the test git commands (`gitTestEnv(base)`); pass it as the runner's `parentEnv`. */
  readonly env: Record<string, string>
  /**
   * Runs `git <TEST_GIT_CONFIG> <args>` in `cwd` (default `dir`; must be inside `base`) and returns stdout; rejects
   * when git fails. `env` adds variables. Plain git: no hardening (this is also the "control" of the sentinel tests).
   */
  git: (args: readonly string[], options?: { cwd?: string, env?: Readonly<Record<string, string>> }) => Promise<string>
  /** Writes a file of the work tree (`rel` relative to `dir`; folders created); returns its absolute path. */
  write: (rel: string, content: string | Uint8Array, mode?: number) => Promise<string>
  /** `git add -A` + `git commit -m <message>` (allows an empty commit); returns the new HEAD id. */
  commitAll: (message?: string) => Promise<string>
  /** Removes `base`. */
  cleanup: () => Promise<void>
}

/** Creates a temp repository (see the module comment). */
export async function createTempGitRepo(options: TempGitRepoOptions = {}): Promise<TempGitRepo> {
  const base = options.base ?? await makeTempDir()
  const dir = resolve(base, options.path ?? 'repo')
  if (!isWithin(base, dir))
    throw new Error('The repository must be inside the temp folder.')
  await mkdir(dir, { recursive: true })
  const env = gitTestEnv(base)

  const git: TempGitRepo['git'] = async (args, gitOptions = {}) => {
    const cwd = gitOptions.cwd ?? dir
    if (!isWithin(base, resolve(cwd)))
      throw new Error(`Test git commands run only inside ${base}.`)
    const running = execFileAsync('git', [...TEST_GIT_CONFIG, ...args], {
      cwd,
      env: { ...env, ...gitOptions.env },
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      timeout: 30_000,
    })
    // No input: a program started by git (a hook, a filter) never waits for this process.
    running.child.stdin?.end()
    const { stdout } = await running
    return stdout
  }

  const write: TempGitRepo['write'] = async (rel, content, mode) => {
    const target = resolve(dir, rel)
    if (!isWithin(base, target))
      throw new Error('Test files are written only inside the temp folder.')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    if (mode !== undefined)
      await chmod(target, mode)
    return target
  }

  const commitAll: TempGitRepo['commitAll'] = async (message = 'test commit') => {
    await git(['add', '-A'])
    await git(['commit', '-q', '--allow-empty', '--no-verify', '-m', message])
    return (await git(['rev-parse', 'HEAD'])).trim()
  }

  if (options.init !== false)
    await git(['init', '-q', '-b', options.branch ?? 'main'])

  return {
    base,
    dir,
    env,
    git,
    write,
    commitAll,
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

/** Writes an executable POSIX `sh` script named `git` into `binDir` (a fake git for `PATH` tests); returns its path. */
export async function writeFakeGit(binDir: string, body: string): Promise<string> {
  await mkdir(binDir, { recursive: true })
  const target = join(binDir, 'git')
  await writeFile(target, `#!/bin/sh\n${body}\n`)
  await chmod(target, 0o755)
  return target
}
