// `loadSkill` (W10.5-T1; ADR-045, ARCHITECTURE.md 6.25): the run catalog's active skill, its body loaded again, the
// content cap, and for a project skill the base folder and its supporting files (walked through the frozen guards:
// depth 3, at most 50, no links, hidden or secret-looking names); unknown / turned-off / invalid / unreadable skills
// are errors that list the available skills; bodies are never logged. Temp project folders: `realpath(mkdtemp())`.
// Phase 11 (W11.6-T6, ADR-052): a `disable-model-invocation` skill is refused (also when its file changed after the
// listing) and never listed as available.
import type { CustomizationEntry, ParsedDefinition } from '@harness-forge/shared'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { AppDeps } from '../types.ts'
import type { SkillLoadContext } from './skills.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LIMITS, skillOutputSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryLogger, createSilentLogger } from '../logger.ts'
import { catalogEntryKey, createFakeCustomizationService, fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { capUtf8, listSkillFiles, loadSkill, modelInvocableSkills, skillBaseDir, skillBody, SKILLS_UNAVAILABLE_TEXT } from './skills.ts'
import { catalogEntry, testCatalog } from './testing.ts'

const PROJECT = 'prj_SKILLSTESTAAAAAA'
const SKILL_BODY = '# PDF\nUse ref.md for the field names.'
const SKILL_MD = `---\nname: pdf\ndescription: Work with PDF files.\n---\n${SKILL_BODY}\n`

let base: string
let root: string
let fake: FakeCustomizationService

const skipLinks = process.platform === 'win32'

async function put(path: string, content = 'x'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

function workspace(): OpenWorkspace {
  return { projectId: PROJECT, name: 'Skills', root, instructions: null, projectFile: null }
}

function deps(): AppDeps {
  return { customizations: fake } as unknown as AppDeps
}

/** Registers a project skill `name` (folder `.harness/skills/<folder>`) with a body in the fake service. */
function projectSkill(name: string, body: string | ParsedDefinition = SKILL_MD, folder = name): CustomizationEntry {
  const entry = fakeCatalogEntry('skill', name, { description: 'Work with PDF files.', path: `.harness/skills/${folder}/SKILL.md` })
  fake.entries.set(PROJECT, [...(fake.entries.get(PROJECT) ?? []), entry])
  fake.bodies.set(catalogEntryKey(entry), body)
  return entry
}

async function context(overrides: Partial<SkillLoadContext> = {}): Promise<SkillLoadContext> {
  return { deps: deps(), catalog: await fake.catalog(PROJECT), workspace: workspace(), logger: createSilentLogger(), ...overrides }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
  fake = createFakeCustomizationService()
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('loadSkill: a project skill', () => {
  it('pdf/SKILL.md + ref.md -> the body, baseDir and files: [\'ref.md\']', async () => {
    await put('.harness/skills/pdf/SKILL.md', SKILL_MD)
    await put('.harness/skills/pdf/ref.md', '# Fields')
    projectSkill('pdf')
    const output = await loadSkill(await context(), 'pdf', signal())
    expect(output).toEqual({
      name: 'pdf',
      description: 'Work with PDF files.',
      source: 'project',
      content: SKILL_BODY,
      truncated: false,
      baseDir: '.harness/skills/pdf',
      files: ['ref.md'],
    })
    expect(skillOutputSchema.parse(output)).toEqual(output)
  })

  it('normalizes the name as the tool input does (trimmed, lowercased)', async () => {
    await put('.harness/skills/pdf/SKILL.md', SKILL_MD)
    projectSkill('pdf')
    expect((await loadSkill(await context(), '  PDF ', signal())).name).toBe('pdf')
  })

  it('lists supporting files in walk order: nested up to 3 folders, no hidden, secret-looking, ignored or deeper files', async () => {
    await put('.harness/skills/pdf/SKILL.md', SKILL_MD)
    await put('.harness/skills/pdf/ref.md')
    await put('.harness/skills/pdf/templates/form.md')
    await put('.harness/skills/pdf/a/b/c/deep.md')
    await put('.harness/skills/pdf/a/b/c/d/too-deep.md')
    await put('.harness/skills/pdf/.hidden.md')
    await put('.harness/skills/pdf/.cache/x.md')
    await put('.harness/skills/pdf/.env')
    await put('.harness/skills/pdf/server.pem')
    await put('.harness/skills/pdf/credentials.json')
    await put('.harness/skills/pdf/node_modules/pkg/index.js')
    await put('.harness/skills/pdf/.gitignore', 'build/\n')
    await put('.harness/skills/pdf/build/out.txt')
    projectSkill('pdf')
    const output = await loadSkill(await context(), 'pdf', signal())
    expect(output.files).toEqual(['ref.md', 'a/b/c/deep.md', 'templates/form.md'])
  })

  it.skipIf(skipLinks)('leaves out file and folder links in the skill folder', async () => {
    await put('.harness/skills/pdf/SKILL.md', SKILL_MD)
    await put('.harness/skills/pdf/ref.md')
    await put('docs/inside.md')
    await mkdir(join(root, 'docs/folder'))
    await put('docs/folder/x.md')
    await symlink(join(root, 'docs/inside.md'), join(root, '.harness/skills/pdf/linked.md'))
    await symlink(join(root, 'docs/folder'), join(root, '.harness/skills/pdf/linked-folder'))
    await writeFile(join(base, 'outside.md'), 'outside')
    await symlink(join(base, 'outside.md'), join(root, '.harness/skills/pdf/outside.md'))
    projectSkill('pdf')
    expect((await loadSkill(await context(), 'pdf', signal())).files).toEqual(['ref.md'])
  })

  it.skipIf(skipLinks)('a skill folder that is a link (even into the project) gives no files', async () => {
    await put('docs/pdf/SKILL.md', SKILL_MD)
    await put('docs/pdf/ref.md')
    await mkdir(join(root, '.harness/skills'), { recursive: true })
    await symlink(join(root, 'docs/pdf'), join(root, '.harness/skills/pdf'))
    projectSkill('pdf')
    const output = await loadSkill(await context(), 'pdf', signal())
    expect(output).toMatchObject({ content: SKILL_BODY, baseDir: '.harness/skills/pdf', files: [] })
    await expect(listSkillFiles(root, '.harness/skills/pdf', 'SKILL.md', signal())).rejects.toThrow('symbolic link')
  })

  it('lists at most LIMITS.skillFilesListedMax files', async () => {
    await put('.harness/skills/pdf/SKILL.md', SKILL_MD)
    for (let index = 0; index < LIMITS.skillFilesListedMax + 10; index += 1)
      await put(`.harness/skills/pdf/f${String(index).padStart(3, '0')}.md`)
    projectSkill('pdf')
    const output = await loadSkill(await context(), 'pdf', signal())
    expect(output.files).toHaveLength(LIMITS.skillFilesListedMax)
    expect(output.files?.[0]).toBe('f000.md')
    expect(skillOutputSchema.safeParse(output).success).toBe(true)
  })

  it('a missing skill folder lists no files; the body still loads (the folder name may differ from the skill name)', async () => {
    projectSkill('pdf', SKILL_MD, 'pdf-tools')
    const output = await loadSkill(await context(), 'pdf', signal())
    expect(output).toMatchObject({ content: SKILL_BODY, baseDir: '.harness/skills/pdf-tools', files: [] })
  })

  it('without the open project folder: no baseDir and no files', async () => {
    await put('.harness/skills/pdf/SKILL.md', SKILL_MD)
    await put('.harness/skills/pdf/ref.md')
    projectSkill('pdf')
    const output = await loadSkill(await context({ workspace: null }), 'pdf', signal())
    expect(output).not.toHaveProperty('baseDir')
    expect(output).not.toHaveProperty('files')
    // Another project's folder is never walked.
    const other = await loadSkill(await context({ workspace: { ...workspace(), projectId: 'prj_OTHERPROJECTAAAA' } }), 'pdf', signal())
    expect(other).not.toHaveProperty('files')
  })
})

describe('loadSkill: plugin and personal skills', () => {
  it('a plugin skill has no folder', async () => {
    const entry = fakeCatalogEntry('skill', 'notes', { source: 'plugin', pluginId: 'agent-pack' })
    fake.entries.set('', [entry])
    fake.bodies.set(catalogEntryKey(entry), '---\nname: notes\ndescription: Short notes.\n---\nWrite short notes.\n')
    const output = await loadSkill(await context(), 'notes', signal())
    expect(output).toEqual({ name: 'notes', description: 'Short notes.', source: 'plugin', content: 'Write short notes.', truncated: false })
  })

  it('a personal skill loads from the store', async () => {
    await fake.create({ kind: 'skill', content: '---\nname: style\ndescription: House style.\n---\nUse short sentences.\n' })
    const output = await loadSkill(await context(), 'style', signal())
    expect(output).toMatchObject({ name: 'style', source: 'user', content: 'Use short sentences.' })
  })

  it('cuts a body over 64 KiB at a character boundary (truncated)', async () => {
    const entry = fakeCatalogEntry('skill', 'big', { source: 'plugin', pluginId: 'agent-pack' })
    fake.entries.set('', [entry])
    const content = `a${'é'.repeat(LIMITS.customizationContentBytes)}`
    fake.bodies.set(catalogEntryKey(entry), { kind: 'skill', fields: { name: 'big', description: 'Big.', content } })
    const output = await loadSkill(await context(), 'big', signal())
    expect(output.truncated).toBe(true)
    expect(Buffer.byteLength(output.content, 'utf8')).toBeLessThanOrEqual(LIMITS.customizationContentBytes)
    expect(output.content.endsWith('é')).toBe(true)
    expect(output.content).not.toContain('�')
    expect(skillOutputSchema.safeParse(output).success).toBe(true)
  })
})

describe('loadSkill: errors', () => {
  it('an unknown skill lists the available ones', async () => {
    projectSkill('pdf')
    const failed = loadSkill(await context(), 'docx', signal())
    await expect(failed).rejects.toMatchObject({ code: 'not_found', message: 'Unknown skill "docx". Available skills: pdf.' })
  })

  it('a catalog without skills answers SKILLS_UNAVAILABLE_TEXT', async () => {
    await expect(loadSkill(await context({ catalog: testCatalog() }), 'pdf', signal())).rejects.toMatchObject({ code: 'not_found', message: SKILLS_UNAVAILABLE_TEXT })
  })

  it('a turned-off or invalid skill says so', async () => {
    const catalog = testCatalog([
      catalogEntry('skill', 'pdf', { source: 'user', state: 'off', enabled: false }),
      catalogEntry('skill', 'broken', { source: 'project', state: 'invalid' }),
      catalogEntry('skill', 'notes', { source: 'user' }),
    ], PROJECT)
    await expect(loadSkill(await context({ catalog }), 'pdf', signal())).rejects.toThrow('The skill "pdf" is turned off. Available skills: notes.')
    await expect(loadSkill(await context({ catalog }), 'broken', signal())).rejects.toThrow('The skill "broken" is not valid. Available skills: notes.')
  })

  it('a body that is gone or invalid now fails with the load error and the list', async () => {
    const entry = projectSkill('pdf')
    fake.bodies.delete(catalogEntryKey(entry))
    await expect(loadSkill(await context(), 'pdf', signal())).rejects.toMatchObject({
      code: 'not_found',
      message: 'The skill "pdf" could not be loaded. The skill "pdf" is no longer available. Available skills: pdf.',
    })
    fake.bodies.set(catalogEntryKey(entry), '---\nname: pdf\n---\n')
    await expect(loadSkill(await context(), 'pdf', signal())).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('quotes at most 64 characters of an odd name', async () => {
    projectSkill('pdf')
    await expect(loadSkill(await context(), `x${'y'.repeat(200)}`, signal())).rejects.toThrow(`Unknown skill "x${'y'.repeat(63)}…".`)
  })

  it('rejects with the abort reason', async () => {
    projectSkill('pdf')
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(loadSkill(await context(), 'pdf', controller.signal)).rejects.toThrow('stopped')
  })
})

describe('loadSkill: model invocation (Phase 11)', () => {
  const INTERNAL_MD = '---\nname: internal\ndescription: Internal notes.\ndisable-model-invocation: true\n---\nINTERNAL-BODY\n'

  it('refuses a disable-model-invocation skill and lists only the model-invocable ones', async () => {
    projectSkill('pdf')
    const internal = { ...projectSkill('internal', INTERNAL_MD), modelInvocable: false }
    fake.entries.set(PROJECT, [...(fake.entries.get(PROJECT) ?? []).filter(entry => entry.name !== 'internal'), internal])
    const memory = createMemoryLogger()
    await expect(loadSkill(await context({ logger: memory.logger }), 'internal', signal())).rejects.toMatchObject({
      code: 'forbidden',
      message: 'The skill "internal" can only be run by the user (as /internal); you cannot load it. Available skills: pdf.',
    })
    // The body was never read.
    expect(fake.calls.load).toBe(0)
    await expect(loadSkill(await context(), 'docx', signal())).rejects.toThrow('Unknown skill "docx". Available skills: pdf.')
    expect(memory.text()).not.toContain('INTERNAL-BODY')
  })

  it('refuses a skill whose file turned it off for the model after the listing', async () => {
    const entry = projectSkill('pdf')
    fake.bodies.set(catalogEntryKey(entry), SKILL_MD.replace('description: Work with PDF files.\n', 'description: Work with PDF files.\ndisable-model-invocation: true\n'))
    await expect(loadSkill(await context(), 'pdf', signal())).rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/^The skill "pdf" can only be run by the user/) })
  })

  it('a catalog with only user-invocable skills answers SKILLS_UNAVAILABLE_TEXT for other names', async () => {
    const catalog = testCatalog([catalogEntry('skill', 'internal', { source: 'user', modelInvocable: false })], PROJECT)
    await expect(loadSkill(await context({ catalog }), 'pdf', signal())).rejects.toMatchObject({ code: 'not_found', message: SKILLS_UNAVAILABLE_TEXT })
    await expect(loadSkill(await context({ catalog }), 'internal', signal())).rejects.toThrow('The skill "internal" can only be run by the user (as /internal); you cannot load it.')
  })

  it('modelInvocableSkills keeps the order and drops modelInvocable: false only', () => {
    const entries = [
      catalogEntry('skill', 'b', { modelInvocable: true }),
      catalogEntry('skill', 'internal', { modelInvocable: false }),
      catalogEntry('skill', 'a'),
    ]
    expect(modelInvocableSkills(entries).map(entry => entry.name)).toEqual(['b', 'a'])
    expect(modelInvocableSkills([])).toEqual([])
  })
})

describe('loadSkill logging', () => {
  it('never logs the body (names and counts at debug only)', async () => {
    await put('.harness/skills/pdf/SKILL.md', SKILL_MD)
    await put('.harness/skills/pdf/ref.md')
    projectSkill('pdf')
    const memory = createMemoryLogger()
    await loadSkill(await context({ logger: memory.logger }), 'pdf', signal())
    await expect(loadSkill(await context({ logger: memory.logger }), 'docx', signal())).rejects.toThrow()
    expect(memory.text()).not.toContain('field names')
    expect(memory.records.every(record => record.level === 'debug')).toBe(true)
  })
})

describe('helpers', () => {
  it('skillBaseDir: the folder of a project skill file, else null', () => {
    expect(skillBaseDir({ source: 'project', path: '.harness/skills/pdf/SKILL.md' })).toBe('.harness/skills/pdf')
    expect(skillBaseDir({ source: 'project', path: '.claude/skills/release-notes/SKILL.md' })).toBe('.claude/skills/release-notes')
    expect(skillBaseDir({ source: 'project', path: 'SKILL.md' })).toBeNull()
    expect(skillBaseDir({ source: 'project' })).toBeNull()
    expect(skillBaseDir({ source: 'plugin', path: '.harness/skills/pdf/SKILL.md' })).toBeNull()
  })

  it('capUtf8 keeps whole characters', () => {
    expect(capUtf8('abc', 3)).toEqual({ text: 'abc', truncated: false })
    expect(capUtf8('abé', 3)).toEqual({ text: 'ab', truncated: true })
    expect(capUtf8('a😀b', 4)).toEqual({ text: 'a', truncated: true })
    expect(capUtf8('a😀b', 5)).toEqual({ text: 'a😀', truncated: true })
  })
})

describe('phase 12 stubs (C44-T6): the loadSkill options and the body seam', () => {
  it('loadSkill takes the options (file, toolCallId) and answers as before until W12.7', async () => {
    await put('.harness/skills/pdf/SKILL.md', SKILL_MD)
    await put('.harness/skills/pdf/ref.md', '# Fields')
    projectSkill('pdf')
    const plain = await loadSkill(await context(), 'pdf', signal())
    expect(await loadSkill(await context(), 'pdf', signal(), { file: 'ref.md', toolCallId: 'call_1' })).toEqual(plain)
    expect(await loadSkill(await context(), 'pdf', signal(), {})).toEqual(plain)
  })

  it('skillBody leaves the body as it is (the argumentOptions stub answers no options)', () => {
    const body = `Use $ARGUMENTS, $0, $ARGUMENTS[1], \\$HOME and \${CLAUDE_SKILL_DIR}/ref.md.`
    expect(skillBody(body, ['first'], { CLAUDE_SKILL_DIR: '/srv/skills/pdf' })).toBe(body)
    expect(skillBody(body, null, {})).toBe(body)
  })
})
