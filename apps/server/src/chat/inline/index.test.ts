// `expandCommandPlan` (W11.5-T2 – T4): the checks of `!` spans in their order (a project chat, the shell, the folder, a
// trusted source: a personal command, a plugin template, or a project command file whose trust hash is approved — the
// hash the trust listing computes, re-read right before the spans run), the spans and `@path` files of a trusted body,
// the rendered text and `inlined`. Real shells in `realpath(mkdtemp())` projects, POSIX `sh` only; skipped on Windows.
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { CommandExpansionHost } from '../commands.ts'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { HarnessError, planCommandExpansion } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commandTrustSubject } from '../../services/project-config/index.ts'
import { killLiveShellGroups } from '../../workspace/shell.ts'
import { expandCommandPlan, isSpanRefusal, minimalExpansion, needsInlining, spansFolderUnavailable, spansNeedProject, spansShellDisabled, spansUntrusted } from './index.ts'

const posix = process.platform !== 'win32'
const PROJECT = 'prj_0123456789abcdef'

interface TestHost extends CommandExpansionHost {
  readonly asked: string[]
  readonly approved: Set<string>
}

function hostOf(root: string | null, options: { shell?: boolean, folder?: boolean, approved?: Iterable<string> } = {}): TestHost {
  const asked: string[] = []
  const approved = new Set(options.approved ?? [])
  const workspace: OpenWorkspace | null = root === null || options.folder === false ? null : { projectId: PROJECT, name: 'Demo', root, instructions: null, projectFile: null }
  return {
    asked,
    approved,
    projectId: root === null ? null : PROJECT,
    shellEnabled: options.shell ?? true,
    workspace: async () => {
      asked.push('workspace')
      return workspace
    },
    trusted: async (projectId, sha256) => {
      asked.push(`trusted:${projectId}`)
      return approved.has(sha256)
    },
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

describe.skipIf(!posix)('expandCommandPlan', () => {
  let root: string
  const signal = new AbortController().signal

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'scripts', 'count.sh'), 'echo run >> counter.txt\necho counted\n')
    await writeFile(join(root, 'README.md'), 'Hello readme\n')
  })

  afterAll(async () => {
    killLiveShellGroups()
    await rm(root, { recursive: true, force: true })
  })

  it('refuses spans without a project (400), with the shell off (409 disabled) and without the folder (400), in that order', async () => {
    const plan = planCommandExpansion('Run !`touch ran.txt`')
    const refused = async (host: CommandExpansionHost): Promise<HarnessError> => expandCommandPlan({ name: 'x', input: '', plan, source: 'user', host, signal }).then(
      () => { throw new Error('expected a refusal') },
      (error: HarnessError) => error,
    )
    const none = hostOf(null, { shell: false })
    expect((await refused(none)).toJSON().error).toEqual(spansNeedProject('x').toJSON().error)
    expect(spansNeedProject('x').toJSON().error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts'] }] } })
    const off = hostOf(root, { shell: false })
    expect((await refused(off)).toJSON().error).toEqual({ code: 'conflict', message: spansShellDisabled('x').message, details: { reason: 'disabled' } })
    expect(off.asked).toEqual([])
    const gone = hostOf(root, { folder: false })
    expect((await refused(gone)).toJSON().error).toEqual(spansFolderUnavailable('x').toJSON().error)
    expect(await exists(join(root, 'ran.txt'))).toBe(false)
    // Only the 409s are refusals that remove a new chat row (a 400 keeps the v1.6 behavior).
    expect(isSpanRefusal(spansShellDisabled('x'))).toBe(true)
    expect(isSpanRefusal(spansUntrusted('x'))).toBe(true)
    expect(isSpanRefusal(spansNeedProject('x'))).toBe(false)
    expect(isSpanRefusal(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'disabled' } }))).toBe(false)
  })

  it('runs a project command file only when its trust hash is approved; editing a referenced script makes it pending', async () => {
    const plan = planCommandExpansion('Count: !`sh scripts/count.sh` for $ARGUMENTS')
    const host = hostOf(root)
    const untrusted = await expandCommandPlan({ name: 'count', input: 'now', plan, source: 'project', host, signal }).catch((error: HarnessError) => error)
    expect((untrusted as HarnessError).toJSON().error).toEqual({ code: 'conflict', message: '/count runs shell lines you haven\'t approved. Review the project\'s files to run it.', details: { reason: 'untrusted' } })
    expect(spansUntrusted('count').message).toBe((untrusted as HarnessError).message)
    expect(host.asked).toEqual(['workspace', `trusted:${PROJECT}`])
    expect(await exists(join(root, 'counter.txt'))).toBe(false)

    // The hash the trust listing shows for this file (name, spans, the referenced script and its content).
    const subject = await commandTrustSubject(root, 'count', plan.shellCommands)
    expect(subject.hashItem).toMatchObject({ kind: 'command', name: 'count', spans: ['sh scripts/count.sh'], refs: [{ path: 'scripts/count.sh', sha256: expect.stringMatching(/^[\da-f]{64}$/) }] })
    host.approved.add(subject.sha256)
    const ran = await expandCommandPlan({ name: 'count', input: 'now', plan, source: 'project', host, signal })
    expect(ran).toEqual({ text: 'Count: counted for now', inlined: { shell: 1, files: [] } })
    expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe('run\n')

    // Another name is another item; a changed script is another hash.
    await expect(expandCommandPlan({ name: 'other', input: '', plan, source: 'project', host, signal })).rejects.toMatchObject({ code: 'conflict' })
    await writeFile(join(root, 'scripts', 'count.sh'), 'echo run >> counter.txt\necho changed\n')
    await expect(expandCommandPlan({ name: 'count', input: 'now', plan, source: 'project', host, signal })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'untrusted' } })
    expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe('run\n')
  })

  it('runs personal and plugin spans without a trust check; arguments never reach a span', async () => {
    const plan = planCommandExpansion('Echo: !`echo "[$1]"` and $ARGUMENTS')
    for (const source of ['user', 'plugin'] as const) {
      const host = hostOf(root)
      const result = await expandCommandPlan({ name: 'x', input: '; touch pwned', plan, source, host, signal })
      expect(result).toEqual({ text: 'Echo: [] and ; touch pwned', inlined: { shell: 1, files: [] } })
      expect(host.asked).toEqual(['workspace'])
    }
    expect(await exists(join(root, 'pwned'))).toBe(false)
  })

  it('inlines @path files in project chats only, after the spans; references alone need no shell and no trust', async () => {
    const plan = planCommandExpansion('Read @README.md and @.env about $ARGUMENTS')
    expect(needsInlining(plan, hostOf(null))).toBe(false)
    const host = hostOf(root, { shell: false })
    expect(needsInlining(plan, host)).toBe(true)
    const result = await expandCommandPlan({ name: 'read', input: 'docs', plan, source: 'project', host, signal })
    expect(result).toEqual({ text: 'Read @README.md and @.env about docs\n\n<file path="README.md">\nHello readme\n</file>', inlined: { shell: 0, files: ['README.md'] } })
    expect(host.asked).toEqual(['workspace'])
    // An unavailable folder leaves every reference as text.
    const gone = await expandCommandPlan({ name: 'read', input: 'docs', plan, source: 'project', host: hostOf(root, { folder: false }), signal })
    expect(gone).toEqual({ text: 'Read @README.md and @.env about docs' })

    const both = planCommandExpansion('!`printf one > made.txt` then @made.txt')
    const made = await expandCommandPlan({ name: 'make', input: '', plan: both, source: 'user', host: hostOf(root), signal })
    expect(made).toEqual({ text: ' then @made.txt\n\n<file path="made.txt">\none\n</file>', inlined: { shell: 1, files: ['made.txt'] } })
  })

  it('minimalExpansion is the text with empty span outputs and no file blocks (the 64 KB floor)', () => {
    const plan = planCommandExpansion('A !`echo x` B @README.md $ARGUMENTS')
    expect(minimalExpansion(plan, 'in')).toBe('A  B @README.md in')
    expect(needsInlining(planCommandExpansion('```\n!`echo x`\n```'), hostOf(root))).toBe(false)
  })
})
