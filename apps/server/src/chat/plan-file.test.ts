// `savePlan` (W10.5-T3; ADR-047, ARCHITECTURE.md 6.27): only with `planFiles` on, a workspace and the run scope of that
// project; `<planDirectory>/<YYYY-MM-DD>-<slug>.md` written through `journaledWrite` (a journal row with tool
// `exit_plan_mode`), `-2`, `-3` … on a collision, never an overwrite; the plan folder guard (a tampered setting, a link
// anywhere on the folder, a file in the way) gives `planError` and never a file; never rejects; plan texts never logged.
// Temp project folders: `realpath(mkdtemp())`.
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { Settings } from '@harness-forge/shared'
import type { CheckpointStore } from '../services/checkpoints/store.ts'
import type { CheckpointJournal } from '../services/checkpoints/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { PlanFileContext } from './plan-file.ts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, exitPlanModeOutputSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chats, projects, workspaceChanges } from '../db/schema.ts'
import { createMemoryLogger, createSilentLogger } from '../logger.ts'
import { createChangeRowWriter, createCheckpointJournal } from '../services/checkpoints/journal-service.ts'
import { createCheckpointStore } from '../services/checkpoints/store.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { bindRunScope } from '../workspace/run-scope.ts'
import {
  capPlanError,
  PLAN_DIRECTORY_UNSAFE_ERROR,
  PLAN_ERROR_MAX_CHARS,
  PLAN_FILE_STOPPED_ERROR,
  planDate,
  planDirectoryOf,
  planFileName,
  planSlug,
  savePlan,
} from './plan-file.ts'

const PROJECT = 'prj_PLANFILETESTAAAA'
const CHAT = '0199a8f0-0000-7000-8000-0000000000e1'
const ASSISTANT = 'msg_PLANFILEASSISTAA'
/** 2026-10-04T23:30:00Z: the date of the file names. */
const NOW = Date.UTC(2026, 9, 4, 23, 30)
const PLAN = '# Add a notes file\n1. Create notes.txt.\n2. Report back.'

let t: TestApp
let base: string
let root: string
let store: CheckpointStore

const skipLinks = process.platform === 'win32'

function journal(): CheckpointJournal {
  return createCheckpointJournal({ deps: t.deps, blobs: store, rows: createChangeRowWriter(t.deps, Date.now), now: Date.now }, { chatId: CHAT, messageId: ASSISTANT, projectId: PROJECT })
}

/** The call context of the approved `exit_plan_mode`; the run scope bound unless `scope: false` (as `wrapToolExecute`). */
function call(options: { scope?: boolean, projectId?: string, workspace?: boolean, signal?: AbortSignal } = {}): ToolCallContext {
  const c: ToolCallContext = {
    chatId: CHAT,
    modelRef: 'mock:plan',
    toolCallId: 'call_plan_1',
    messages: [],
    signal: options.signal ?? new AbortController().signal,
    ...(options.workspace === false ? {} : { workspace: { projectId: PROJECT, name: 'Plans', root } }),
  }
  if (options.scope !== false) {
    bindRunScope(c, {
      chatId: CHAT,
      messageId: ASSISTANT,
      projectId: options.projectId ?? PROJECT,
      toolCallId: 'call_plan_1',
      journal: journal(),
      shellRules: { projectId: PROJECT, prefixes: [] },
      shellCwd: { current: '.' },
    })
  }
  return c
}

function context(settings: Partial<Settings> = {}, logger = createSilentLogger()): PlanFileContext {
  return { deps: t.deps, settings: { ...DEFAULT_SETTINGS, planFiles: true, ...settings }, logger, now: () => NOW }
}

async function rows() {
  return t.db.select().from(workspaceChanges).where(eq(workspaceChanges.chatId, CHAT)).orderBy(workspaceChanges.id)
}

async function filesIn(rel: string): Promise<string[]> {
  return existsSync(join(root, rel)) ? (await readdir(join(root, rel))).sort() : []
}

beforeEach(async () => {
  t = await createTestApp({ start: false })
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
  store = createCheckpointStore(join(base, 'checkpoints'))
  await t.db.insert(projects).values({ id: PROJECT, name: 'Plans', path: root, createdAt: 1, updatedAt: 1 })
  await t.db.insert(chats).values({ id: CHAT, projectId: PROJECT })
})

afterEach(async () => {
  await t.close()
  await rm(base, { recursive: true, force: true })
})

describe('planSlug, planDate, planFileName, planDirectoryOf', () => {
  it.each([
    ['# Plan\n1. Create notes.txt.\n2. Report back.', 'plan'],
    [PLAN, 'add-a-notes-file'],
    ['Intro line\n\n## Refactor the API: v2! ##\nSteps', 'refactor-the-api-v2'],
    ['## Port the parser to C#', 'port-the-parser-to-c'],
    ['\n\n  Refactor *auth* (phase 2)  \n- step', 'refactor-auth-phase-2'],
    ['# Café crème brûlée', 'cafe-creme-brulee'],
    ['# 计划', 'plan'],
    ['#\n# ##\nFix the build', 'plan'],
    ['# ##\n## Fix the build', 'fix-the-build'],
    ['#Not a heading\nNext', 'not-a-heading'],
    ['', 'plan'],
    ['   \n\t\n', 'plan'],
    [`# ${'word '.repeat(30)}`, 'word-word-word-word-word-word-word-word-word-wor'],
  ])('planSlug(%j) = %s', (plan, slug) => {
    expect(planSlug(plan)).toBe(slug)
  })

  it('slugs are [a-z0-9-], at most 48 characters, never with an edge dash', () => {
    for (const plan of [`# ${'a'.repeat(47)} b`, `# ${'x-'.repeat(60)}`, '# --- ---', `# ${'É'.repeat(100)}`]) {
      const slug = planSlug(plan)
      expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      expect(slug.length).toBeLessThanOrEqual(48)
    }
  })

  it('stays linear on hostile lines', () => {
    const started = performance.now()
    planSlug(`#${' '.repeat(50_000)}x`)
    planSlug(`${' '.repeat(25_000)}#${'#'.repeat(25_000)}`)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('planDate is the UTC date; planFileName adds -n from 2', () => {
    expect(planDate(NOW)).toBe('2026-10-04')
    expect(planDate(0)).toBe('1970-01-01')
    expect(planFileName('2026-10-04', 'plan', 1)).toBe('2026-10-04-plan.md')
    expect(planFileName('2026-10-04', 'plan', 2)).toBe('2026-10-04-plan-2.md')
  })

  it('planDirectoryOf normalizes a safe folder and refuses an unsafe one', () => {
    expect(planDirectoryOf('.harness/plans')).toBe('.harness/plans')
    expect(planDirectoryOf(' docs\\plans/ ')).toBe('docs/plans')
    for (const unsafe of ['', '/', '../x', 'a/../../x', '.git/x', 'docs/.GIT', '/etc', 'C:/x', './x', 'a//b', 'a\u0000b'])
      expect(planDirectoryOf(unsafe), unsafe).toBeNull()
  })

  it('capPlanError keeps one line of at most 500 characters', () => {
    expect(capPlanError('  a\n b  ')).toBe('a b')
    expect(capPlanError('x'.repeat(900))).toHaveLength(PLAN_ERROR_MAX_CHARS)
  })
})

describe('savePlan: when a file is due', () => {
  it('planFiles off, no workspace, no run scope or another project\'s scope -> {} and no file', async () => {
    expect(await savePlan(context({ planFiles: false }), PLAN, call())).toEqual({})
    expect(await savePlan(context(), PLAN, call({ workspace: false }))).toEqual({})
    expect(await savePlan(context(), PLAN, call({ scope: false }))).toEqual({})
    expect(await savePlan(context(), PLAN, call({ projectId: 'prj_OTHERPROJECTAAAA' }))).toEqual({})
    expect(existsSync(join(root, '.harness'))).toBe(false)
    expect(await rows()).toEqual([])
  })
})

describe('savePlan: writing the file', () => {
  it('writes <planDirectory>/<date>-<slug>.md through the journal (tool exit_plan_mode)', async () => {
    const saved = await savePlan(context(), PLAN, call())
    expect(saved).toEqual({ planPath: '.harness/plans/2026-10-04-add-a-notes-file.md' })
    expect(exitPlanModeOutputSchema.parse({ approved: true, mode: 'edits', ...saved })).toMatchObject(saved)
    expect(await readFile(join(root, saved.planPath!), 'utf8')).toBe(`${PLAN}\n`)
    const [row, ...rest] = await rows()
    expect(rest).toEqual([])
    expect(row).toMatchObject({ kind: 'edit', tool: 'exit_plan_mode', path: '.harness/plans/2026-10-04-add-a-notes-file.md', toolCallId: 'call_plan_1', messageId: ASSISTANT, beforeState: 'missing' })
  })

  it('keeps a trailing newline and uses a custom folder (backslashes and a trailing slash allowed)', async () => {
    const saved = await savePlan(context({ planDirectory: 'docs\\plans/' }), '# Plan\n', call())
    expect(saved).toEqual({ planPath: 'docs/plans/2026-10-04-plan.md' })
    expect(await readFile(join(root, 'docs/plans/2026-10-04-plan.md'), 'utf8')).toBe('# Plan\n')
  })

  it('a taken name -> -2, -3; an existing file is never overwritten', async () => {
    await mkdir(join(root, '.harness/plans'), { recursive: true })
    await writeFile(join(root, '.harness/plans/2026-10-04-add-a-notes-file.md'), 'mine')
    expect(await savePlan(context(), PLAN, call())).toEqual({ planPath: '.harness/plans/2026-10-04-add-a-notes-file-2.md' })
    expect(await savePlan(context(), PLAN, call())).toEqual({ planPath: '.harness/plans/2026-10-04-add-a-notes-file-3.md' })
    expect(await readFile(join(root, '.harness/plans/2026-10-04-add-a-notes-file.md'), 'utf8')).toBe('mine')
    expect((await rows()).map(row => row.path)).toEqual([
      '.harness/plans/2026-10-04-add-a-notes-file-2.md',
      '.harness/plans/2026-10-04-add-a-notes-file-3.md',
    ])
  })

  it('two approvals at once get two files', async () => {
    const [a, b] = await Promise.all([savePlan(context(), PLAN, call()), savePlan(context(), PLAN, call())])
    expect([a.planPath, b.planPath].sort()).toEqual([
      '.harness/plans/2026-10-04-add-a-notes-file-2.md',
      '.harness/plans/2026-10-04-add-a-notes-file.md',
    ])
  })

  it.skipIf(skipLinks)('a folder or a dangling link at the name is skipped like a file', async () => {
    await mkdir(join(root, '.harness/plans/2026-10-04-plan.md'), { recursive: true })
    await symlink(join(base, 'missing.md'), join(root, '.harness/plans/2026-10-04-plan-2.md'))
    expect(await savePlan(context(), '# Plan', call())).toEqual({ planPath: '.harness/plans/2026-10-04-plan-3.md' })
    expect(existsSync(join(base, 'missing.md'))).toBe(false)
  })
})

describe('savePlan: the plan folder guard', () => {
  it.each(['../x', '.git/plans', '/tmp/plans', 'docs/../../x'])('a tampered planDirectory %j -> planError, no file anywhere', async (planDirectory) => {
    const saved = await savePlan(context({ planDirectory }), PLAN, call())
    expect(saved).toEqual({ planError: PLAN_DIRECTORY_UNSAFE_ERROR })
    expect(await readdir(root)).toEqual([])
    expect((await readdir(base)).sort()).toEqual(['project'])
    expect(await rows()).toEqual([])
  })

  it.skipIf(skipLinks)('a link at the plan folder (inside or outside the project) is refused', async () => {
    await mkdir(join(root, 'docs/plans'), { recursive: true })
    await mkdir(join(root, '.harness'))
    await symlink(join(root, 'docs/plans'), join(root, '.harness/plans'))
    const inside = await savePlan(context(), PLAN, call())
    expect(inside.planError).toBe('The plan folder ".harness/plans" is or goes through a symbolic link.')
    expect(await filesIn('docs/plans')).toEqual([])

    await mkdir(join(base, 'outside'))
    await symlink(join(base, 'outside'), join(root, 'out'))
    const outside = await savePlan(context({ planDirectory: 'out/plans' }), PLAN, call())
    expect(outside.planError).toMatch(/symbolic link/)
    expect(await readdir(join(base, 'outside'))).toEqual([])
    expect(await rows()).toEqual([])
  })

  it.skipIf(skipLinks)('a linked .harness folder is refused too', async () => {
    await mkdir(join(root, 'real/plans'), { recursive: true })
    await symlink(join(root, 'real'), join(root, '.harness'))
    expect((await savePlan(context(), PLAN, call())).planError).toMatch(/symbolic link/)
    expect(await filesIn('real/plans')).toEqual([])
  })

  it('a file where the folder should be -> planError', async () => {
    await mkdir(join(root, '.harness'))
    await writeFile(join(root, '.harness/plans'), 'not a folder')
    const saved = await savePlan(context(), PLAN, call())
    expect(saved.planError).toMatch(/not a folder/)
    expect(await readFile(join(root, '.harness/plans'), 'utf8')).toBe('not a folder')
  })

  it('a project folder that is gone -> planError (never rejects)', async () => {
    await rm(root, { recursive: true })
    const saved = await savePlan(context(), PLAN, call())
    expect(saved.planError).toBe('The project folder no longer exists.')
  })

  it('a stopped reply -> planError, no file', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('Stopped.', 'AbortError'))
    expect(await savePlan(context(), PLAN, call({ signal: controller.signal }))).toEqual({ planError: PLAN_FILE_STOPPED_ERROR })
    expect(existsSync(join(root, '.harness/plans/2026-10-04-add-a-notes-file.md'))).toBe(false)
  })
})

describe('savePlan logging', () => {
  it('never logs the plan text; a failure is one warning with the reason', async () => {
    const memory = createMemoryLogger()
    await savePlan(context({}, memory.logger), PLAN, call())
    await savePlan(context({ planDirectory: '../x' }, memory.logger), PLAN, call())
    expect(memory.text()).not.toContain('Create notes.txt')
    const warnings = memory.records.filter(record => record.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(JSON.stringify(warnings[0])).toContain(PLAN_DIRECTORY_UNSAFE_ERROR)
    expect(memory.records.filter(record => record.level === 'info')).toEqual([])
  })
})
