/* eslint-disable no-template-curly-in-string -- the bodies hold `${CLAUDE_…}` variables on purpose */
// Phase 12 skills (W12.7-T6, T7; ADR-053 / ADR-058): `loadSkill` with the call's options and call scope: a plugin
// skill's supporting files listed and read through the skill-files helper (W12.1's, a fake here: the frozen signature),
// a project skill's file read with the project root, refused paths as tool errors, the `${CLAUDE_…}` variables of the
// body, qualified names and the bare alias, and fork skills (one child through the run's `runSubagent`, its report as
// `content`). Temp folders: `realpath(mkdtemp())`.
import type { CustomizationEntry, SkillOutput, TaskInput, TaskOutput } from '@harness-forge/shared'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { AppDeps } from '../types.ts'
import type { RunSubagentOptions } from './agent-scope.ts'
import type { SkillFileHelpers, SkillLoadContext } from './skills.ts'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HarnessError, LIMITS, skillInputSchema, skillOutputSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryLogger, createSilentLogger } from '../logger.ts'
import { catalogEntryKey, createFakeCustomizationService, fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { skillCallOptions, skillCallScopeOf } from './skills-call.ts'
import { FORK_LIMIT_NOTE, loadSkill } from './skills.ts'

const PROJECT = 'prj_SKILLSCLAUDEAAAAA'
const CHAT = '0199a8f0-0000-7000-8000-000000000001'

let base: string
let root: string
let pluginRoot: string
let fake: FakeCustomizationService

/** The fake skill-files helper: files of `skills/pdf` under the plugin root; `../` and hidden names refused. */
function helpers(calls: string[] = []): SkillFileHelpers {
  return {
    list: async (folderRoot, baseDir) => {
      calls.push(`list ${folderRoot} ${baseDir}`)
      return ['reference.md', 'scripts/fill.sh']
    },
    read: async (folderRoot, baseDir, file) => {
      calls.push(`read ${folderRoot} ${baseDir} ${file}`)
      if (file.split('/').includes('..') || file.startsWith('.'))
        throw new HarnessError({ code: 'validation_error', message: 'The path is outside the skill folder.' })
      if (file !== 'scripts/fill.sh' && file !== 'reference.md')
        throw new HarnessError({ code: 'not_found', message: `The skill file ${file} was not found.` })
      return { path: file, content: file === 'reference.md' ? '# Reference' : '#!/bin/sh\nprintf filled\n', truncated: false }
    },
  }
}

function deps(): AppDeps {
  return {
    customizations: fake,
    registry: {
      skills: {
        get: (name: string) => (name === 'review-kit:pdf' ? { pluginId: 'review-kit', definition: { name, description: 'PDF.', content: '', baseDir: 'skills/pdf' } } : undefined),
      },
    },
    plugins: { directory: async (id: string) => (id === 'review-kit' ? pluginRoot : null) },
  } as unknown as AppDeps
}

function pluginSkill(): CustomizationEntry {
  const entry = fakeCatalogEntry('skill', 'review-kit:pdf', { source: 'plugin', pluginId: 'review-kit', description: 'Fill in PDF forms.' })
  fake.entries.set('', [...(fake.entries.get('') ?? []), entry])
  fake.bodies.set(catalogEntryKey(entry), { kind: 'skill', fields: { name: 'review-kit:pdf', description: 'Fill in PDF forms.', content: 'Run `sh ${CLAUDE_SKILL_DIR}/scripts/fill.sh $ARGUMENTS` in ${CLAUDE_PROJECT_DIR} (${CLAUDE_SESSION_ID}).' } })
  return entry
}

async function context(overrides: Partial<SkillLoadContext> = {}): Promise<SkillLoadContext> {
  return {
    deps: deps(),
    catalog: await fake.catalog(PROJECT),
    workspace: { projectId: PROJECT, name: 'Demo', root, instructions: null, projectFile: null },
    logger: createSilentLogger(),
    skillFiles: helpers(),
    ...overrides,
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  pluginRoot = join(base, 'plugins', 'review-kit')
  await mkdir(root, { recursive: true })
  await mkdir(pluginRoot, { recursive: true })
  fake = createFakeCustomizationService()
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('loadSkill: plugin skills (W12.7-T7)', () => {
  it('a qualified plugin skill lists its files for skill { file } (no baseDir) and gets its variables', async () => {
    pluginSkill()
    const calls: string[] = []
    const output = await loadSkill(await context({ skillFiles: helpers(calls) }), 'review-kit:pdf', signal(), skillCallOptions({}, { chatId: CHAT }))
    expect(output).toEqual({
      name: 'review-kit:pdf',
      description: 'Fill in PDF forms.',
      source: 'plugin',
      content: `Run \`sh ${join(pluginRoot, 'skills/pdf')}/scripts/fill.sh \` in ${root} (${CHAT}).`,
      truncated: false,
      fileAccess: 'skill',
      files: ['reference.md', 'scripts/fill.sh'],
    })
    expect(skillOutputSchema.parse(output)).toEqual(output)
    expect(calls).toEqual([`list ${pluginRoot} skills/pdf`])
  })

  it('the bare alias loads it while unique', async () => {
    pluginSkill()
    expect((await loadSkill(await context(), 'pdf', signal())).name).toBe('review-kit:pdf')
  })

  it('skill { name, file } reads one file through the helper with the plugin root; ../x and hidden names are tool errors', async () => {
    pluginSkill()
    const calls: string[] = []
    const read = await loadSkill(await context({ skillFiles: helpers(calls) }), 'review-kit:pdf', signal(), { file: 'scripts/fill.sh' })
    expect(read).toEqual({
      name: 'review-kit:pdf',
      description: 'Fill in PDF forms.',
      source: 'plugin',
      content: '',
      truncated: false,
      fileAccess: 'skill',
      file: { path: 'scripts/fill.sh', content: '#!/bin/sh\nprintf filled\n', truncated: false },
    })
    expect(skillOutputSchema.parse(read)).toEqual(read)
    expect(calls).toEqual([`read ${pluginRoot} skills/pdf scripts/fill.sh`])
    await expect(loadSkill(await context(), 'review-kit:pdf', signal(), { file: '../x' })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(loadSkill(await context(), 'review-kit:pdf', signal(), { file: '.env' })).rejects.toThrow('has no readable file')
    await expect(loadSkill(await context(), 'review-kit:pdf', signal(), { file: 'missing.md' })).rejects.toMatchObject({ code: 'not_found' })
    // The tool input refuses `../` before any read.
    expect(skillInputSchema.safeParse({ name: 'review-kit:pdf', file: '../x' }).success).toBe(false)
  })

  it('the helper\'s file content is capped; a personal skill has no files to read', async () => {
    pluginSkill()
    const big: SkillFileHelpers = { ...helpers(), read: async (_root, _base, file) => ({ path: file, content: 'x'.repeat(LIMITS.skillFileReadBytes + 10), truncated: false }) }
    const read = await loadSkill(await context({ skillFiles: big }), 'review-kit:pdf', signal(), { file: 'reference.md' })
    expect(read.file?.truncated).toBe(true)
    expect(read.file?.content.length).toBe(LIMITS.skillFileReadBytes)
    await fake.create({ kind: 'skill', content: '---\nname: notes\ndescription: Notes.\n---\nWrite notes in ${CLAUDE_SKILL_DIR}.' })
    await expect(loadSkill(await context(), 'notes', signal(), { file: 'a.md' })).rejects.toThrow('has no supporting files')
    // A personal skill's `${CLAUDE_SKILL_DIR}` stays literal.
    expect((await loadSkill(await context(), 'notes', signal())).content).toBe('Write notes in ${CLAUDE_SKILL_DIR}.')
  })
})

describe('loadSkill: project skills keep read_file (W12.7-T7)', () => {
  async function put(path: string, content: string): Promise<void> {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }

  it('the listing keeps baseDir (read_file); ${CLAUDE_SKILL_DIR} is the project-relative folder; a file call reads with the project root', async () => {
    await put('.claude/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: PDF.\n---\nRead ${CLAUDE_SKILL_DIR}/ref.md.')
    await put('.claude/skills/pdf/ref.md', '# Ref')
    const entry = fakeCatalogEntry('skill', 'pdf', { path: '.claude/skills/pdf/SKILL.md' })
    fake.entries.set(PROJECT, [entry])
    fake.bodies.set(catalogEntryKey(entry), '---\nname: pdf\ndescription: PDF.\n---\nRead ${CLAUDE_SKILL_DIR}/ref.md.')
    const output = await loadSkill(await context(), 'pdf', signal())
    expect(output).toMatchObject({ content: 'Read .claude/skills/pdf/ref.md.', baseDir: '.claude/skills/pdf', files: ['ref.md'] })
    expect(output.fileAccess).toBeUndefined()
    const calls: string[] = []
    const read = await loadSkill(await context({ skillFiles: helpers(calls) }), 'pdf', signal(), { file: 'reference.md' })
    expect(read).toMatchObject({ fileAccess: 'workspace', file: { path: 'reference.md' } })
    expect(calls).toEqual([`read ${root} .claude/skills/pdf reference.md`])
  })
})

describe('loadSkill: fork skills (W12.7-T6)', () => {
  async function forkSkill(): Promise<void> {
    await fake.create({ kind: 'skill', content: '---\nname: deep\ndescription: Deep research.\ncontext: fork\nagent: explore\n---\nInvestigate $ARGUMENTS and report.' })
  }

  function output(status: TaskOutput['status'], report: string, error?: string): TaskOutput {
    return { status, type: 'explore', description: 'Skill deep', modelRef: 'mock:echo', steps: [], stepsOmitted: 0, report, startedAt: 1, ...(error === undefined ? {} : { error }) }
  }

  function runner(final: TaskOutput, runs: Array<{ input: TaskInput, options: RunSubagentOptions }>): (input: TaskInput, options: RunSubagentOptions) => AsyncIterable<TaskOutput> {
    return (input, options) => {
      runs.push({ input, options })
      return (async function* () {
        yield output('running', '')
        yield final
      })()
    }
  }

  it('runs ONE child of the skill\'s agent type with the body as its prompt and returns its report as content', async () => {
    await forkSkill()
    const runs: Array<{ input: TaskInput, options: RunSubagentOptions }> = []
    const memory = createMemoryLogger()
    const options = skillCallOptions({ toolCallId: 'call_skill_1' }, { chatId: CHAT, runSubagent: runner(output('completed', 'The cache is fine.'), runs) })
    const result = await loadSkill(await context({ logger: memory.logger }), 'deep', signal(), options)
    expect(result).toEqual({ name: 'deep', description: 'Deep research.', source: 'user', content: 'The cache is fine.', truncated: false } satisfies SkillOutput)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.input).toEqual({ description: 'Skill deep', prompt: 'Investigate  and report.', type: 'explore' })
    expect(runs[0]!.options.toolCallId).toBe('call_skill_1')
    // Bodies and reports are never logged.
    expect(memory.text()).toContain('fork skill finished')
    expect(memory.text()).not.toContain('Investigate')
    expect(memory.text()).not.toContain('The cache is fine')
  })

  it('a child at its limit returns its partial report with a note; a failed child is a tool error', async () => {
    await forkSkill()
    const limited = await loadSkill(await context(), 'deep', signal(), skillCallOptions({ toolCallId: 'call_1' }, { chatId: CHAT, runSubagent: runner(output('limit', 'Partial.'), []) }))
    expect(limited.content).toBe(`Partial.\n\n${FORK_LIMIT_NOTE}`)
    await expect(loadSkill(await context(), 'deep', signal(), skillCallOptions({ toolCallId: 'call_2' }, { chatId: CHAT, runSubagent: runner(output('failed', '', 'Unknown agent type explore.'), []) })))
      .rejects
      .toThrow('runs in a sub-agent, which did not finish. Unknown agent type explore.')
  })

  it('without a toolCallId or a runner the body comes back (nothing runs)', async () => {
    await forkSkill()
    const runs: Array<{ input: TaskInput, options: RunSubagentOptions }> = []
    const noCall = await loadSkill(await context(), 'deep', signal(), skillCallOptions({}, { chatId: CHAT, runSubagent: runner(output('completed', 'x'), runs) }))
    expect(noCall.content).toBe('Investigate  and report.')
    expect((await loadSkill(await context(), 'deep', signal(), { toolCallId: 'call_3' })).content).toBe('Investigate  and report.')
    expect(runs).toHaveLength(0)
  })

  it('the call scope is bound to the options object only', () => {
    const options = skillCallOptions({ file: 'a.md' }, { chatId: CHAT })
    expect(options).toEqual({ file: 'a.md' })
    expect(Object.isFrozen(options)).toBe(true)
    expect(skillCallScopeOf(options)).toEqual({ chatId: CHAT })
    expect(skillCallScopeOf({ file: 'a.md' })).toBeNull()
    expect(skillCallScopeOf(undefined)).toBeNull()
  })
})
