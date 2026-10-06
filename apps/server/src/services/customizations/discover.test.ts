// Discovery of project definition files (W10.1-T1, T2): the folder rules (links on the path, hidden names, `.md` only,
// the command depth and namespace, skills one level down), the per-file guards (a linked file, a 70 KiB file, a binary
// file, a secret-looking name), invalid YAML, the 200-file limit, the whole read of a cut head that does not parse, and
// a spy proving that no linked target is ever opened. Project folders are `realpath(mkdtemp())`. Phase 11 (W11.6-T1):
// the output styles folders (top-level `*.md`, labels and slug names, `keep-coding-instructions`, a reserved builtin
// name, a broken file, links and subfolders skipped) and the skill keys of the entries.
import type { CustomizationEntry } from '@harness-forge/shared'
import type { OpenDefinitionFile } from './discover.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { customizationEntrySchema, DEFINITION_LIMITS, definitionDiagnosticSchema, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { openWorkspaceFile } from '../../workspace/paths.ts'
import { discoverProject, DISCOVERY_READ_BYTES, PROJECT_DEFINITION_FOLDERS, readDefinitionFile } from './discover.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

const isWindows = process.platform === 'win32'

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function write(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
}

function agent(name: string, description = `The ${name} agent.`, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\nYou are ${name}.\n`
}

function command(description: string, extra = ''): string {
  return `---\ndescription: ${description}\n${extra}---\nRun $ARGUMENTS.\n`
}

/** An opener that records every path it opens. */
function spyOpener(): { open: OpenDefinitionFile, opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    open: async (root, rel) => {
      opened.push(rel)
      return openWorkspaceFile(root, rel)
    },
  }
}

function byPath(entries: readonly CustomizationEntry[], path: string): CustomizationEntry | undefined {
  return entries.find(entry => entry.path === path)
}

describe('the definition folders', () => {
  it('are the .claude folders, then the .harness folders (lowest precedence first)', () => {
    expect(PROJECT_DEFINITION_FOLDERS.map(folder => folder.folder)).toEqual([
      '.claude/agents',
      '.claude/commands',
      '.claude/skills',
      '.claude/output-styles',
      '.harness/agents',
      '.harness/commands',
      '.harness/skills',
      '.harness/output-styles',
    ])
  })
})

describe('discoverProject', () => {
  it('reads agents, commands (namespaces, 3 folders deep) and skills; skips hidden, non-.md and deeper files', async () => {
    const root = await tempFolder()
    await write(root, {
      '.harness/agents/reviewer.md': agent('reviewer', 'Reviews diffs.', 'tools: Read, Grep\nmodel: mock:echo\n'),
      '.harness/agents/.hidden.md': agent('hidden'),
      '.harness/agents/notes.txt': 'not a definition',
      '.harness/agents/nested/deep.md': agent('deep'),
      '.claude/commands/review.md': command('Review a change.', 'argument-hint: [file] [focus]\nallowed-tools: Read\n'),
      '.claude/commands/frontend/forms/a/component.md': command('Make a component.'),
      '.claude/commands/frontend/forms/a/b/too-deep.md': command('Too deep.'),
      '.claude/commands/.private/secret-ish.md': command('Hidden folder.'),
      '.harness/skills/release-notes/SKILL.md': '---\ndescription: Write release notes.\n---\n# Release notes\n',
      '.harness/skills/release-notes/template.md': 'Template',
      '.harness/skills/no-skill-file/README.md': 'Nothing here',
      '.harness/skills/top-level.md': 'Not a skill folder',
      'README.md': 'not read',
    })
    const found = await discoverProject(root)
    expect(found.folders).toEqual(['.claude/commands', '.harness/agents', '.harness/skills'])
    expect(found.diagnostics).toEqual([])
    // Folder order (.claude before .harness), then the sorted paths of each folder.
    expect(found.entries.map(entry => [entry.kind, entry.name, entry.path, entry.state])).toEqual([
      ['command', 'component', '.claude/commands/frontend/forms/a/component.md', 'active'],
      ['command', 'review', '.claude/commands/review.md', 'active'],
      ['agent', 'reviewer', '.harness/agents/reviewer.md', 'active'],
      ['skill', 'release-notes', '.harness/skills/release-notes/SKILL.md', 'active'],
    ])
    const reviewer = byPath(found.entries, '.harness/agents/reviewer.md')!
    expect(reviewer).toMatchObject({ source: 'project', description: 'Reviews diffs.', tools: ['read_file', 'search_files'], modelRef: 'mock:echo', enabled: true })
    const review = byPath(found.entries, '.claude/commands/review.md')!
    expect(review).toMatchObject({ argumentHint: '[file] [focus]', tools: ['read_file'] })
    expect(review.namespace).toBeUndefined()
    expect(byPath(found.entries, '.claude/commands/frontend/forms/a/component.md')!.namespace).toBe('frontend/forms/a')
    for (const entry of found.entries)
      expect(customizationEntrySchema.safeParse(entry).success, entry.path).toBe(true)
  })

  it.skipIf(isWindows)('skips a linked file and a linked folder with `link`; no linked target is ever opened', async () => {
    const root = await tempFolder()
    const outside = await tempFolder()
    await write(outside, { 'evil.md': agent('evil', 'OUTSIDE-SECRET') })
    await write(root, {
      'shared/inside.md': agent('inside', 'INSIDE-TARGET'),
      'shared/agents/linked-folder-agent.md': agent('folder-agent', 'FOLDER-TARGET'),
      '.claude/agents/plain.md': agent('plain'),
      '.claude/commands/real/run.md': command('Real.'),
      'shared/commands/run.md': command('LINKED-COMMAND'),
    })
    await symlink(join(root, 'shared/inside.md'), join(root, '.claude/agents/inside-link.md'))
    await symlink(join(outside, 'evil.md'), join(root, '.claude/agents/outside-link.md'))
    // A linked `.harness/agents` folder and a linked command subfolder.
    await mkdir(join(root, '.harness'), { recursive: true })
    await symlink(join(root, 'shared/agents'), join(root, '.harness/agents'))
    await symlink(join(root, 'shared/commands'), join(root, '.claude/commands/linked'))
    const spy = spyOpener()
    const found = await discoverProject(root, { openFile: spy.open })
    expect(found.entries.map(entry => entry.path)).toEqual(['.claude/agents/plain.md', '.claude/commands/real/run.md'])
    expect(found.diagnostics.map(item => [item.code, item.path])).toEqual(expect.arrayContaining([
      ['link', '.claude/agents/inside-link.md'],
      ['link', '.claude/agents/outside-link.md'],
      ['link', '.harness/agents'],
      ['link', '.claude/commands/linked'],
    ]))
    expect(found.folders).not.toContain('.harness/agents')
    expect(spy.opened.sort()).toEqual(['.claude/agents/plain.md', '.claude/commands/real/run.md'])
    const answer = JSON.stringify(found)
    for (const marker of ['OUTSIDE-SECRET', 'INSIDE-TARGET', 'FOLDER-TARGET', 'LINKED-COMMAND', outside, root])
      expect(answer).not.toContain(marker)
    for (const item of found.diagnostics)
      expect(definitionDiagnosticSchema.safeParse(item).success).toBe(true)
  })

  it.skipIf(isWindows)('skips a linked .harness folder (a link anywhere on the path)', async () => {
    const root = await tempFolder()
    await write(root, { 'real-harness/agents/a.md': agent('a') })
    await symlink(join(root, 'real-harness'), join(root, '.harness'))
    const found = await discoverProject(root)
    expect(found.entries).toEqual([])
    // Only the folders that exist behind the link are reported (`.harness/commands` does not exist).
    expect(found.diagnostics.map(item => [item.code, item.path])).toEqual([['link', '.harness/agents']])
  })

  it('lists a 70 KiB file and a binary file as invalid (too-large, binary) without their content', async () => {
    const root = await tempFolder()
    const big = `${agent('big', 'BIG-MARKER')}${'x'.repeat(70 * 1024)}`
    const binary = Buffer.concat([Buffer.from('---\nname: bin\ndescription: BIN-MARKER\n---\n'), Buffer.from([0, 1, 2, 3])])
    await write(root, { '.harness/agents/big.md': big, '.harness/agents/bin.md': binary })
    const found = await discoverProject(root)
    expect(found.entries.map(entry => [entry.name, entry.state, entry.description, entry.diagnostics.map(item => [item.level, item.code, item.path])])).toEqual([
      ['big', 'invalid', '', [['error', 'too-large', '.harness/agents/big.md']]],
      ['bin', 'invalid', '', [['error', 'binary', '.harness/agents/bin.md']]],
    ])
    expect(JSON.stringify(found)).not.toMatch(/BIG-MARKER|BIN-MARKER/)
  })

  it('reports invalid YAML (invalid-frontmatter), a reserved name and missing fields; never quotes the file', async () => {
    const root = await tempFolder()
    await write(root, {
      '.harness/agents/broken.md': '---\n[unclosed SECRET-VALUE\n---\nBody\n',
      '.harness/agents/lenient.md': '---\nname: lenient\ndescription: Lenient.\ntools: [Read\n---\nBody\n',
      '.harness/agents/explore.md': agent('explore'),
      '.harness/agents/nodesc.md': '---\nname: nodesc\n---\nBody\n',
      '.harness/commands/compact.md': command('Mine.'),
    })
    const found = await discoverProject(root)
    const states = Object.fromEntries(found.entries.map(entry => [entry.path, [entry.state, entry.diagnostics.map(item => item.code)]]))
    expect(states['.harness/agents/broken.md']).toEqual(['invalid', ['invalid-frontmatter']])
    expect(states['.harness/agents/lenient.md']![0]).toBe('active')
    expect(states['.harness/agents/lenient.md']![1]).toContain('invalid-frontmatter')
    expect(states['.harness/agents/explore.md']).toEqual(['invalid', ['reserved-name']])
    expect(states['.harness/agents/nodesc.md']).toEqual(['invalid', ['missing-field']])
    expect(states['.harness/commands/compact.md']).toEqual(['invalid', ['reserved-name']])
    expect(found.entries.find(entry => entry.path === '.harness/agents/broken.md')?.name).toBe('broken')
    expect(JSON.stringify(found)).not.toContain('SECRET-VALUE')
  })

  it('reads the top-level output styles of both folders: labels, slug names, the keep flag; reserved and broken files invalid', async () => {
    const root = await tempFolder()
    const style = (name: string, extra = '', body = 'Answer in short sentences.'): string => `---\nname: ${name}\ndescription: The ${name} style.\n${extra}---\n${body}\n`
    await write(root, {
      '.claude/output-styles/terse.md': style('Terse'),
      '.harness/output-styles/terse.md': style('terse', 'keep-coding-instructions: true\n'),
      '.harness/output-styles/team-voice.md': style('Team Voice!'),
      '.harness/output-styles/stem.md': '---\ndescription: Named by its file.\n---\nBe kind.\n',
      '.harness/output-styles/explanatory.md': style('explanatory'),
      // The seeded file of the gate: read line by line (a warning), so it stays usable.
      '.harness/output-styles/broken.md': '---\nname: broken\ndescription: [unclosed\nkeep-coding-instructions: : :\n---\nSTYLE-BROKEN\n',
      // No description and no body line to take it from.
      '.harness/output-styles/nodesc.md': '---\nname: nodesc\n---\n',
      '.harness/output-styles/garbage.md': '---\n[unclosed SECRET-VALUE\n---\nBody\n',
      '.harness/output-styles/nested/deep.md': style('deep'),
      '.harness/output-styles/notes.txt': 'not markdown',
    })
    if (!isWindows)
      await symlink(join(root, '.claude/output-styles/terse.md'), join(root, '.harness/output-styles/linked.md'))
    const spy = spyOpener()
    const found = await discoverProject(root, { openFile: spy.open })
    expect(found.folders).toEqual(['.claude/output-styles', '.harness/output-styles'])
    const styles = found.entries.filter(entry => entry.kind === 'style')
    expect(styles.map(entry => [entry.path, entry.name, entry.state, entry.label ?? null, entry.keepCodingInstructions ?? null])).toEqual([
      ['.claude/output-styles/terse.md', 'terse', 'active', 'Terse', false],
      ['.harness/output-styles/broken.md', 'broken', 'active', 'broken', false],
      ['.harness/output-styles/explanatory.md', 'explanatory', 'invalid', null, null],
      ['.harness/output-styles/garbage.md', 'garbage', 'invalid', null, null],
      ['.harness/output-styles/nodesc.md', 'nodesc', 'invalid', null, null],
      ['.harness/output-styles/stem.md', 'stem', 'active', 'stem', false],
      ['.harness/output-styles/team-voice.md', 'team-voice', 'active', 'Team Voice!', false],
      ['.harness/output-styles/terse.md', 'terse', 'active', 'terse', true],
    ])
    expect(byPath(styles, '.harness/output-styles/explanatory.md')!.diagnostics.map(item => item.code)).toEqual(['reserved-name'])
    expect(byPath(styles, '.harness/output-styles/broken.md')!.diagnostics.map(item => `${item.level}:${item.code}`)).toEqual(['warning:invalid-frontmatter', 'warning:invalid-field'])
    expect(byPath(styles, '.harness/output-styles/garbage.md')!.diagnostics.map(item => item.code)).toEqual(['invalid-frontmatter'])
    expect(byPath(styles, '.harness/output-styles/nodesc.md')!.diagnostics.map(item => `${item.level}:${item.code}`)).toEqual(['error:missing-field', 'warning:missing-field'])
    for (const entry of styles)
      expect(customizationEntrySchema.safeParse(entry).success, entry.path).toBe(true)
    // Subfolders, other files and links are never read.
    expect(spy.opened.filter(path => path.includes('output-styles')).sort()).toEqual(styles.map(entry => entry.path).sort())
    if (!isWindows)
      expect(found.diagnostics).toContainEqual(expect.objectContaining({ code: 'link', path: '.harness/output-styles/linked.md' }))
    expect(JSON.stringify(found)).not.toContain('SECRET-VALUE')
    expect(JSON.stringify(found)).not.toMatch(/short sentences|STYLE-BROKEN/)
  })

  it('lists the skill keys of Phase 11 (user-invocable, disable-model-invocation, argument-hint) only when set', async () => {
    const root = await tempFolder()
    await write(root, {
      '.harness/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploys.\nargument-hint: [env]\n---\nDeploy to $ARGUMENTS.\n',
      '.harness/skills/internal/SKILL.md': '---\nname: internal\ndescription: Internal notes.\ndisable-model-invocation: true\nuser-invocable: false\n---\nNotes.\n',
      '.harness/skills/plain/SKILL.md': '---\nname: plain\ndescription: Plain.\n---\nPlain.\n',
    })
    const found = await discoverProject(root)
    const pick = (path: string) => {
      const entry = byPath(found.entries, path)!
      return { name: entry.name, argumentHint: entry.argumentHint, userInvocable: entry.userInvocable, modelInvocable: entry.modelInvocable }
    }
    expect(pick('.harness/skills/deploy/SKILL.md')).toEqual({ name: 'deploy', argumentHint: '[env]', userInvocable: undefined, modelInvocable: undefined })
    expect(pick('.harness/skills/internal/SKILL.md')).toEqual({ name: 'internal', argumentHint: undefined, userInvocable: false, modelInvocable: false })
    expect(pick('.harness/skills/plain/SKILL.md')).toEqual({ name: 'plain', argumentHint: undefined, userInvocable: undefined, modelInvocable: undefined })
  })

  it('reads at most 200 definitions per folder (the first sorted paths) and reports `limit`', async () => {
    const root = await tempFolder()
    const files: Record<string, string> = {}
    for (let index = 0; index <= LIMITS.customizationFilesPerFolderMax; index++)
      files[`.harness/commands/c${String(index).padStart(3, '0')}.md`] = command(`Command ${index}.`)
    await write(root, files)
    const found = await discoverProject(root)
    expect(found.entries).toHaveLength(LIMITS.customizationFilesPerFolderMax)
    expect(found.entries.at(-1)?.name).toBe('c199')
    expect(found.diagnostics.map(item => [item.code, item.path])).toEqual([['limit', '.harness/commands']])
  })

  it('never reads a secret-looking file name (an info), and reads a long file only as far as its frontmatter', async () => {
    const root = await tempFolder()
    const body = `First line of the prompt.\n${'more text\n'.repeat(4000)}`
    await write(root, {
      '.harness/commands/secrets.md': command('Secrets.'),
      '.harness/commands/long.md': `---\nargument-hint: <x>\n---\n${body}`,
    })
    const spy = spyOpener()
    const found = await discoverProject(root, { openFile: spy.open })
    expect(spy.opened).toEqual(['.harness/commands/long.md'])
    expect(found.diagnostics.map(item => [item.level, item.code, item.path])).toEqual([['info', 'read-failed', '.harness/commands/secrets.md']])
    expect(found.entries).toHaveLength(1)
    expect(found.entries[0]).toMatchObject({ name: 'long', state: 'active', description: 'First line of the prompt.', argumentHint: '<x>' })
  })

  it('reads a cut head again whole when it does not parse (a body that starts after the first 9 KiB)', async () => {
    const root = await tempFolder()
    const filler = `x-note: ${'a'.repeat(DEFINITION_LIMITS.frontmatterBytes - 200)}\n`
    await write(root, { '.harness/commands/late.md': `---\ndescription: Late body.\n${filler}---\n${'\n'.repeat(2000)}Do it.\n` })
    const spy = spyOpener()
    const found = await discoverProject(root, { openFile: spy.open })
    expect(spy.opened).toEqual(['.harness/commands/late.md', '.harness/commands/late.md'])
    expect(found.entries[0]).toMatchObject({ name: 'late', state: 'active' })
  })

  it('gives no entries and no diagnostics for a project without definition folders', async () => {
    const root = await tempFolder()
    await write(root, { 'src/index.ts': 'export {}' })
    expect(await discoverProject(root)).toEqual({ entries: [], diagnostics: [], folders: [] })
  })

  it.skipIf(isWindows)('skips a linked skill folder and a linked SKILL.md', async () => {
    const root = await tempFolder()
    await write(root, {
      'elsewhere/pdf/SKILL.md': '---\ndescription: PDF.\n---\nRead PDFs.',
      'elsewhere/SKILL.md': '---\ndescription: Linked file.\n---\nNo.',
      '.claude/skills/docx/SKILL.md': '---\ndescription: Word files.\n---\nRead DOCX.',
    })
    await symlink(join(root, 'elsewhere/pdf'), join(root, '.claude/skills/pdf'))
    await mkdir(join(root, '.claude/skills/linked-file'), { recursive: true })
    await symlink(join(root, 'elsewhere/SKILL.md'), join(root, '.claude/skills/linked-file/SKILL.md'))
    const found = await discoverProject(root)
    expect(found.entries.map(entry => [entry.name, entry.path])).toEqual([['docx', '.claude/skills/docx/SKILL.md']])
    expect(found.diagnostics.map(item => [item.code, item.path])).toEqual([
      ['link', '.claude/skills/pdf'],
      ['link', '.claude/skills/linked-file/SKILL.md'],
    ])
  })
})

describe('readDefinitionFile', () => {
  it('reads a head (more) or the whole file, and refuses missing, linked, binary and too-large files', async () => {
    const root = await tempFolder()
    await write(root, {
      '.harness/agents/a.md': `${agent('a')}${'y'.repeat(20_000)}`,
      '.harness/agents/exact.md': 'z'.repeat(DEFINITION_LIMITS.contentBytes),
      '.harness/agents/over.md': 'z'.repeat(DEFINITION_LIMITS.contentBytes + 1),
      '.harness/agents/bin.md': Buffer.from([65, 0, 66]),
    })
    const head = await readDefinitionFile(root, '.harness/agents/a.md', { maxBytes: DISCOVERY_READ_BYTES })
    expect(head).toMatchObject({ ok: true, more: true })
    expect(head.ok && head.text.length).toBe(DISCOVERY_READ_BYTES)
    const whole = await readDefinitionFile(root, '.harness/agents/exact.md', { maxBytes: DEFINITION_LIMITS.contentBytes })
    expect(whole).toMatchObject({ ok: true, more: false, size: DEFINITION_LIMITS.contentBytes })
    expect(await readDefinitionFile(root, '.harness/agents/over.md', { maxBytes: DEFINITION_LIMITS.contentBytes })).toEqual({ ok: false, reason: 'too-large' })
    expect(await readDefinitionFile(root, '.harness/agents/bin.md', { maxBytes: 100 })).toEqual({ ok: false, reason: 'binary' })
    expect(await readDefinitionFile(root, '.harness/agents/none.md', { maxBytes: 100 })).toEqual({ ok: false, reason: 'missing' })
    expect(await readDefinitionFile(root, '../outside.md', { maxBytes: 100 })).toMatchObject({ ok: false })
    if (!isWindows) {
      await symlink(join(root, '.harness/agents/a.md'), join(root, '.harness/agents/link.md'))
      const spy = spyOpener()
      expect(await readDefinitionFile(root, '.harness/agents/link.md', { maxBytes: 100, openFile: spy.open })).toEqual({ ok: false, reason: 'link' })
      expect(spy.opened).toEqual([])
    }
  })
})
