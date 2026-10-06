// `!` spans and `@path` references through `resolveCommand` (W11.5-T2 – T4): with an expansion host, a command file, a
// personal command or a plugin template is scanned before its arguments are expanded and inlines what its trusted spans
// print and the project files it names; the invocation records `kind: 'command'` and `inlined`; without a host (a
// regenerate, a continuation) and for bodies without anything to inline the Phase 10 expansion is unchanged. Real shells
// in `realpath(mkdtemp())` projects (POSIX `sh` only; skipped on Windows); the catalog is the fake.
import type { CommandDefinition } from '@harness-forge/plugin-sdk'
import type { CustomizationEntry } from '@harness-forge/shared'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { CommandExpansionHost, CommandResolution, CommandServices } from './commands.ts'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { commandInvocationSchema, HarnessError, LIMITS, planCommandExpansion } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commandTrustSubject } from '../services/project-config/index.ts'
import { catalogEntryKey, createFakeCustomizationService, fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { killLiveShellGroups } from '../workspace/shell.ts'
import { resolveCommand } from './commands.ts'

const posix = process.platform !== 'win32'
const PROJECT = 'prj_0123456789abcdef'

interface TestHost extends CommandExpansionHost {
  readonly asked: string[]
  readonly approved: Set<string>
}

function hostOf(root: string | null, options: { shell?: boolean } = {}): TestHost {
  const asked: string[] = []
  const approved = new Set<string>()
  const workspace: OpenWorkspace | null = root === null ? null : { projectId: PROJECT, name: 'Demo', root, instructions: null, projectFile: null }
  return {
    asked,
    approved,
    projectId: root === null ? null : PROJECT,
    shellEnabled: options.shell ?? true,
    workspace: async () => {
      asked.push('workspace')
      return workspace
    },
    trusted: async (_projectId, sha256) => {
      asked.push('trusted')
      return approved.has(sha256)
    },
  }
}

function services(fake: FakeCustomizationService, commands: Record<string, CommandDefinition> = {}): CommandServices {
  return {
    registry: {
      commands: {
        get: name => (commands[name] === undefined ? undefined : { pluginId: 'demo', definition: commands[name] }),
        list: () => [],
        register: () => ({ dispose() {} }),
      },
    },
    plugins: { guard: async (_pluginId, fn) => fn(new AbortController().signal) },
    customizations: fake,
  }
}

function commandFile(fake: FakeCustomizationService, name: string, content: string, fields: Partial<CustomizationEntry> = {}): CustomizationEntry {
  const entry = fakeCatalogEntry('command', name, { source: 'project', path: `.harness/commands/${name}.md`, ...fields })
  fake.entries.set(PROJECT, [...(fake.entries.get(PROJECT) ?? []), entry])
  fake.bodies.set(catalogEntryKey(entry), content)
  return entry
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

function invocationOf(resolution: CommandResolution | null): Record<string, unknown> | undefined {
  return resolution?.kind === 'prompt' ? resolution.invocation : undefined
}

describe.skipIf(!posix)('resolveCommand with an expansion host (W11.5)', () => {
  let base: string
  let root: string
  let fake: FakeCustomizationService
  const signal = new AbortController().signal

  async function resolve(text: string, host: CommandExpansionHost | undefined, commands: Record<string, CommandDefinition> = {}, projectId: string | null = PROJECT): Promise<CommandResolution | null> {
    return resolveCommand(services(fake, commands), text, { chatId: 'chat', signal, catalog: await fake.catalog(projectId), ...(host === undefined ? {} : { expansion: host }) })
  }

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    root = join(base, 'project')
    await mkdir(join(root, 'scripts'), { recursive: true })
    await writeFile(join(root, 'README.md'), 'Hello readme\n')
    await writeFile(join(root, '.env'), 'SECRET=1\n')
    await writeFile(join(root, 'scripts', 'count.sh'), 'echo run >> counter.txt\necho "counted $1"\n')
    await writeFile(join(base, 'outside.md'), 'outside\n')
    await symlink(join(root, 'README.md'), join(root, 'linked.md'))
    fake = createFakeCustomizationService()
    await fake.create({ kind: 'command', content: '---\nname: status\ndescription: Status.\n---\nStatus: !`echo hello`\nRead @README.md @.env @linked.md @../outside.md for $ARGUMENTS' })
    await fake.create({ kind: 'command', content: '---\nname: x\ndescription: X.\n---\nEcho: !`echo "[$1]"`' })
    await fake.create({ kind: 'command', content: '---\nname: plain\ndescription: Plain.\n---\nSay $ARGUMENTS about @README.md' })
    await fake.create({ kind: 'command', content: '---\nname: floor\ndescription: Floor.\n---\n!`touch floor.txt` $ARGUMENTS $ARGUMENTS' })
    await fake.create({ kind: 'command', content: '---\nname: fenced\ndescription: Fenced.\n---\n```\n!`touch fenced.txt`\n```\n$ARGUMENTS' })
    commandFile(fake, 'count', '---\ndescription: Count.\n---\nCount: !`sh scripts/count.sh $1` for $ARGUMENTS')
  })

  afterAll(async () => {
    killLiveShellGroups()
    await rm(base, { recursive: true, force: true })
  })

  it('inlines a personal command\'s span output and readable @path files; refused references stay text', async () => {
    const host = hostOf(root)
    const resolution = await resolve('/status now', host)
    const invocation = invocationOf(resolution)
    expect(invocation).toEqual({
      name: 'status',
      input: 'now',
      type: 'prompt',
      expansion: 'Status: hello\nRead @README.md @.env @linked.md @../outside.md for now\n\n<file path="README.md">\nHello readme\n</file>',
      source: 'user',
      kind: 'command',
      inlined: { shell: 1, files: ['README.md'] },
    })
    expect(commandInvocationSchema.safeParse(invocation).success).toBe(true)
    // The folder is opened once for the spans and the files; a personal command needs no trust check.
    expect(host.asked).toEqual(['workspace'])
  })

  it('never puts an argument inside a span (`/x ; touch pwned` creates nothing)', async () => {
    const resolution = await resolve('/x ; touch pwned', hostOf(root))
    expect(invocationOf(resolution)).toMatchObject({ expansion: 'Echo: []\n\n; touch pwned', inlined: { shell: 1, files: [] } })
    expect(await exists(join(root, 'pwned'))).toBe(false)
  })

  it('refuses an unapproved project command file (409 untrusted) and runs it once its hash is approved', async () => {
    const host = hostOf(root)
    const refused = await resolve('/count one', host).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(HarnessError)
    expect((refused as HarnessError).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'untrusted' } })
    expect(await exists(join(root, 'counter.txt'))).toBe(false)

    const plan = planCommandExpansion('Count: !`sh scripts/count.sh $1` for $ARGUMENTS')
    host.approved.add((await commandTrustSubject(root, 'count', plan.shellCommands)).sha256)
    const resolution = await resolve('/count one', host)
    expect(invocationOf(resolution)).toEqual({
      name: 'count',
      input: 'one',
      type: 'prompt',
      expansion: 'Count: counted for one',
      source: 'project',
      kind: 'command',
      inlined: { shell: 1, files: [] },
    })
    expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe('run\n')
  })

  it('refuses spans in a chat without a project (400) and with the shell off (409 disabled); nothing runs', async () => {
    await expect(resolve('/floor', hostOf(null), {}, null)).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts'] }] } })
    await expect(resolve('/floor', hostOf(root, { shell: false }))).rejects.toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })
    expect(await exists(join(root, 'floor.txt'))).toBe(false)
  })

  it('refuses an expansion over 64 KB before any span runs', async () => {
    const half = 'y'.repeat(LIMITS.commandExpansionBytes / 2)
    await expect(resolve(`/floor ${half}`, hostOf(root))).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts'] }] } })
    expect(await exists(join(root, 'floor.txt'))).toBe(false)
  })

  it('keeps the Phase 10 expansion without a host, without a project for references, and for spans inside a code fence', async () => {
    // A regenerate or a continuation resolves without a host: the body stays text.
    expect(invocationOf(await resolve('/status now', undefined))).toEqual({
      name: 'status',
      input: 'now',
      type: 'prompt',
      expansion: 'Status: !`echo hello`\nRead @README.md @.env @linked.md @../outside.md for now',
      source: 'user',
    })
    // References alone in a chat without a project stay text, with the arguments expanded as before.
    const none = hostOf(null)
    expect(invocationOf(await resolve('/plain hi', none, {}, null))).toEqual({ name: 'plain', input: 'hi', type: 'prompt', expansion: 'Say hi about @README.md', source: 'user' })
    expect(none.asked).toEqual([])
    const fenced = hostOf(root)
    expect(invocationOf(await resolve('/fenced go', fenced))).toEqual({ name: 'fenced', input: 'go', type: 'prompt', expansion: '```\n!`touch fenced.txt`\n```\ngo', source: 'user' })
    expect(fenced.asked).toEqual([])
    expect(await exists(join(root, 'fenced.txt'))).toBe(false)
  })

  it('runs the spans of a loaded plugin\'s template (a trusted source); a template without spans keeps expandTemplate', async () => {
    const plugins: Record<string, CommandDefinition> = {
      branch: { name: 'branch', description: 'Branch.', template: 'On !`echo main`: {{input}}' },
      tldr: { name: 'tldr', description: 'TL;DR.', template: 'TL;DR $ARGUMENTS: {{input}}' },
    }
    const host = hostOf(root)
    expect(invocationOf(await resolve('/branch review it', host, plugins))).toEqual({
      name: 'branch',
      input: 'review it',
      type: 'prompt',
      expansion: 'On main: review it',
      kind: 'command',
      inlined: { shell: 1, files: [] },
    })
    expect(host.asked).toEqual(['workspace'])
    expect(invocationOf(await resolve('/tldr x', host, plugins))).toEqual({ name: 'tldr', input: 'x', type: 'prompt', expansion: 'TL;DR $ARGUMENTS: x' })
  })

  it('rethrows the abort of a stopped run while a span runs', async () => {
    await fake.create({ kind: 'command', content: '---\nname: slow\ndescription: Slow.\n---\n!`sleep 30`' })
    const controller = new AbortController()
    const catalog = await fake.catalog(PROJECT)
    const pending = resolveCommand(services(fake), '/slow', { chatId: 'chat', signal: controller.signal, catalog, expansion: hostOf(root) })
    setTimeout(() => controller.abort(new DOMException('stopped', 'AbortError')), 150)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
