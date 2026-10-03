// The sticky working folder helpers (Phase 8, ADR-038): the initial folder from the history, the folder checks, the
// clamp of the reported end folder and the `cd` check of the shell rules. Temp folders are canonical
// (`realpath(mkdtemp())`); links are skipped on Windows.
import type { HarnessUIMessage } from '@harness-forge/shared'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cdTargetsInside, checkShellFolder, clampEndCwd, initialShellCwd, SHELL_CWD_OUTSIDE_NOTE, shellCwdGoneNote, shellFolderLabel } from './shell-cwd.ts'

const posix = process.platform !== 'win32'
const temps: string[] = []
let root: string
let outside: string

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  temps.push(dir)
  return dir
}

beforeEach(async () => {
  root = await tempFolder()
  outside = await tempFolder()
  await mkdir(join(root, 'sub', 'deep'), { recursive: true })
  await mkdir(join(root, 'packages', 'web'), { recursive: true })
  await writeFile(join(root, 'file.txt'), 'text\n')
})

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- history fixtures ----------

let ids = 0

function shellPart(output: unknown, state = 'output-available'): Record<string, unknown> {
  ids += 1
  return { type: 'tool-shell', toolCallId: `call_${ids}`, state, input: { command: 'cd x' }, ...(output === undefined ? {} : { output }) }
}

function shellOutput(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: 'cd x', cwd: '.', exitCode: 0, signal: null, timedOut: false, durationMs: 3, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, ...fields }
}

function assistant(...parts: Array<Record<string, unknown>>): HarnessUIMessage {
  ids += 1
  return { id: `msg_${ids}`, role: 'assistant', parts } as unknown as HarnessUIMessage
}

function user(text: string): HarnessUIMessage {
  ids += 1
  return { id: `msg_${ids}`, role: 'user', parts: [{ type: 'text', text }] } as HarnessUIMessage
}

describe('initialShellCwd', () => {
  it('is the project folder without a finished shell call', () => {
    expect(initialShellCwd([])).toBe('.')
    expect(initialShellCwd([user('hi'), assistant({ type: 'text', text: 'Hello' })])).toBe('.')
  })

  it('takes the endCwd of the last finished shell part on the path', () => {
    const history = [
      user('one'),
      assistant(shellPart(shellOutput({ endCwd: 'sub' })), { type: 'text', text: 'done' }),
      user('two'),
      assistant(shellPart(shellOutput({ endCwd: 'packages' })), shellPart(shellOutput({ endCwd: 'packages/web' }))),
    ]
    expect(initialShellCwd(history)).toBe('packages/web')
    expect(initialShellCwd(history.slice(0, 2))).toBe('sub')
  })

  it('follows the branch: two versions of a message with different folders', () => {
    const shared = [user('setup'), assistant(shellPart(shellOutput({ endCwd: 'sub' })))]
    const branchA = [...shared, user('go to web'), assistant(shellPart(shellOutput({ cwd: 'sub', endCwd: 'packages/web' })))]
    const branchB = [...shared, user('go deeper'), assistant(shellPart(shellOutput({ cwd: 'sub', endCwd: 'sub/deep' })))]
    expect(initialShellCwd(branchA)).toBe('packages/web')
    expect(initialShellCwd(branchB)).toBe('sub/deep')
    expect(initialShellCwd([...shared, user('edited, not answered yet')])).toBe('sub')
  })

  it('counts an output saved before v1.4 (no endCwd) as the project folder', () => {
    expect(initialShellCwd([user('old'), assistant(shellPart(shellOutput()))])).toBe('.')
    expect(initialShellCwd([assistant(shellPart(shellOutput({ cwd: 'sub' })))])).toBe('.')
  })

  it('keeps the folder of an earlier call when the last one reported nothing (exec, a kill, its own EXIT trap)', () => {
    const history = [assistant(shellPart(shellOutput({ endCwd: 'sub' }))), assistant(shellPart(shellOutput({ cwd: 'sub', timedOut: true, exitCode: null, signal: 'SIGTERM' })))]
    expect(initialShellCwd(history)).toBe('sub')
  })

  it('skips parts without an output: pending, denied, failed', () => {
    const history = [
      assistant(shellPart(shellOutput({ endCwd: 'sub' }))),
      assistant(
        shellPart(undefined, 'input-available'),
        shellPart(undefined, 'approval-requested'),
        shellPart(undefined, 'output-denied'),
        { ...shellPart(undefined, 'output-error'), errorText: 'boom' },
      ),
    ]
    expect(initialShellCwd(history)).toBe('sub')
  })

  it('reads a dynamic tool part named shell and ignores other tools and user messages', () => {
    expect(initialShellCwd([assistant({ type: 'dynamic-tool', toolName: 'shell', toolCallId: 'c1', state: 'output-available', input: {}, output: shellOutput({ endCwd: 'sub/deep' }) })])).toBe('sub/deep')
    const history = [
      assistant(shellPart(shellOutput({ endCwd: 'sub' }))),
      assistant({ type: 'tool-read_file', toolCallId: 'c2', state: 'output-available', input: {}, output: { endCwd: 'packages' } }),
      assistant({ type: 'dynamic-tool', toolName: 'mcp__x__shell', toolCallId: 'c3', state: 'output-available', input: {}, output: { endCwd: 'packages' } }),
      { id: 'msg_u', role: 'user', parts: [shellPart(shellOutput({ endCwd: 'packages' }))] } as unknown as HarnessUIMessage,
    ]
    expect(initialShellCwd(history)).toBe('sub')
  })

  it('skips an endCwd that is not a usable path (empty, control characters, not a string)', () => {
    const base = assistant(shellPart(shellOutput({ endCwd: 'sub' })))
    for (const endCwd of ['', 'a\nb', 42, null, 'x'.repeat(5000)])
      expect(initialShellCwd([base, assistant(shellPart(shellOutput({ endCwd })))])).toBe('sub')
    expect(initialShellCwd([base, assistant(shellPart('not an object'))])).toBe('sub')
  })
})

describe.skipIf(!posix)('checkShellFolder', () => {
  it('resolves a folder inside the project', async () => {
    await expect(checkShellFolder(root, 'sub/deep')).resolves.toMatchObject({ ok: true, folder: { rel: 'sub/deep', absolute: join(root, 'sub', 'deep') } })
    await expect(checkShellFolder(root, '.')).resolves.toMatchObject({ ok: true, folder: { rel: '.', absolute: root } })
    await expect(checkShellFolder(root, join(root, 'sub'))).resolves.toMatchObject({ ok: true, folder: { rel: 'sub' } })
  })

  it('says missing for a folder that is gone, unusable for everything else', async () => {
    await expect(checkShellFolder(root, 'gone')).resolves.toEqual({ ok: false, problem: 'missing' })
    await expect(checkShellFolder(root, 'sub/gone/deeper')).resolves.toEqual({ ok: false, problem: 'missing' })
    await expect(checkShellFolder(root, 'file.txt')).resolves.toEqual({ ok: false, problem: 'unusable' })
    await expect(checkShellFolder(root, '..')).resolves.toEqual({ ok: false, problem: 'unusable' })
    await expect(checkShellFolder(root, outside)).resolves.toEqual({ ok: false, problem: 'unusable' })
    await symlink(outside, join(root, 'escape'))
    await expect(checkShellFolder(root, 'escape')).resolves.toEqual({ ok: false, problem: 'unusable' })
  })

  it('follows a link that stays inside the project', async () => {
    await symlink(join(root, 'sub', 'deep'), join(root, 'deep-link'))
    await expect(checkShellFolder(root, 'deep-link')).resolves.toMatchObject({ ok: true, folder: { rel: 'sub/deep' } })
  })
})

describe.skipIf(!posix)('clampEndCwd', () => {
  it('keeps a folder inside the project, project-relative', async () => {
    await expect(clampEndCwd(root, join(root, 'packages', 'web'))).resolves.toEqual({ endCwd: 'packages/web', note: null })
    await expect(clampEndCwd(root, root)).resolves.toEqual({ endCwd: '.', note: null })
  })

  it('clamps a folder outside the project, a link out of it, a file and a folder that is gone', async () => {
    await symlink(outside, join(root, 'escape'))
    for (const reported of ['/', outside, join(root, 'escape'), join(root, 'file.txt'), join(root, 'gone'), `${root}-sibling`])
      await expect(clampEndCwd(root, reported)).resolves.toEqual({ endCwd: '.', note: SHELL_CWD_OUTSIDE_NOTE })
  })
})

describe.skipIf(!posix)('cdTargetsInside', () => {
  it('accepts targets that stay inside, each relative to the previous one', async () => {
    await expect(cdTargetsInside(root, root, [])).resolves.toBe(true)
    await expect(cdTargetsInside(root, root, ['sub'])).resolves.toBe(true)
    await expect(cdTargetsInside(root, root, ['sub', 'deep', '..', '../packages/web'])).resolves.toBe(true)
    await expect(cdTargetsInside(root, join(root, 'sub'), ['deep'])).resolves.toBe(true)
    await expect(cdTargetsInside(root, root, [join(root, 'packages')])).resolves.toBe(true)
    await expect(cdTargetsInside(root, root, ['.'])).resolves.toBe(true)
  })

  it('refuses a target outside the project, missing, a file, or a link out of it', async () => {
    await symlink(outside, join(root, 'escape'))
    for (const targets of [['..'], ['/'], [outside], ['gone'], ['file.txt'], ['escape'], ['sub', 'sub'], ['sub', '../..'], ['sub', 'deep', '../../..']])
      await expect(cdTargetsInside(root, root, targets), JSON.stringify(targets)).resolves.toBe(false)
    await expect(cdTargetsInside(root, root, ['deep'])).resolves.toBe(false)
  })

  it('walks `..` lexically, like cd: `link/..` is the folder holding the link', async () => {
    await symlink(join(root, 'sub', 'deep'), join(root, 'packages', 'deep-link'))
    // Lexically packages/deep-link/.. is packages (where `packages/web` exists); physically it would be sub.
    await expect(cdTargetsInside(root, root, ['packages/deep-link', '..', 'web'])).resolves.toBe(true)
    await expect(cdTargetsInside(root, root, ['packages/deep-link', '..', 'deep'])).resolves.toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('refuses a folder the shell cannot enter', async () => {
    await mkdir(join(root, 'locked'))
    await chmod(join(root, 'locked'), 0o600)
    try {
      await expect(cdTargetsInside(root, root, ['locked'])).resolves.toBe(false)
    }
    finally {
      await chmod(join(root, 'locked'), 0o700)
    }
  })
})

describe('notes and labels', () => {
  it('names the project folder', () => {
    expect(shellFolderLabel('.')).toBe('the project folder')
    expect(shellFolderLabel('packages/web')).toBe('packages/web')
  })

  it('says why the remembered folder was not used, within 500 characters', () => {
    expect(shellCwdGoneNote('sub', 'missing')).toBe('The working folder sub no longer exists, so the command ran in the project folder.')
    expect(shellCwdGoneNote('sub', 'unusable')).toBe('The working folder sub can no longer be used, so the command ran in the project folder.')
    expect(shellCwdGoneNote('x'.repeat(4000), 'missing').length).toBeLessThan(300)
    expect(SHELL_CWD_OUTSIDE_NOTE).toBe('The command ended outside the project folder; the next call starts in the project folder.')
  })
})
