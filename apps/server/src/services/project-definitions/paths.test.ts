// The paths of the project definition editor (Phase 12, W12.4-T1): only the editable paths, no `.git` or secret-looking
// segment, and the path must resolve to itself (no link anywhere on it), checked again inside the lock.
import type { HarnessError } from '@harness-forge/shared'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  definitionParseOptions,
  definitionTarget,
  markdownDefinitionTarget,
  resolveDefinitionPath,
  resolveDefinitionPathAgain,
  skillFolderOf,
} from './paths.ts'

let base: string
let root: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function refusal(promise: Promise<unknown> | (() => unknown)): Promise<HarnessError> {
  try {
    if (typeof promise === 'function')
      promise()
    else
      await promise
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a refusal')
}

describe('definitionTarget', () => {
  it.each([
    ['.claude/agents/reviewer.md', 'agent'],
    ['.harness/agents/reviewer.md', 'agent'],
    ['.claude/commands/deploy.md', 'command'],
    ['.claude/commands/db/migrate.md', 'command'],
    ['.harness/commands/a/b/c/deep.md', 'command'],
    ['.claude/skills/pdf/SKILL.md', 'skill'],
    ['.harness/output-styles/terse.md', 'style'],
    ['.claude/settings.json', 'settings'],
    ['.claude/settings.local.json', 'settings'],
    ['.harness/settings.json', 'settings'],
    ['.harness/settings.local.json', 'settings'],
    ['.mcp.json', 'mcp'],
  ] as const)('%s is a %s', (path, kind) => {
    expect(definitionTarget(path)).toEqual({ path, kind })
  })

  it.each([
    '../x',
    '../.claude/agents/x.md',
    '.git/config',
    '.env',
    '/etc/passwd',
    '.claude/agents/../../x.md',
    '.claude/agents/./x.md',
    '.claude/agents/x.txt',
    '.claude/agents/sub/x.md',
    '.claude/skills/pdf/README.md',
    '.claude/commands/a/b/c/d/too-deep.md',
    '.claude/hooks/check.sh',
    '.claude/settings.yaml',
    'sub/.claude/agents/x.md',
    '.claude\\agents\\x.md',
    '.claude/agents/x.md\n',
    '',
  ])('refuses %j (400 on path)', async (path) => {
    const error = await refusal(() => definitionTarget(path))
    expect(error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
  })

  it('refuses a .git segment and secret-looking names that the path shape allows', async () => {
    for (const path of ['.claude/commands/.git/x.md', '.claude/commands/.GIT/x.md', '.claude/commands/secrets.md', '.claude/commands/.env.md', '.claude/skills/id_rsa/SKILL.md']) {
      const error = await refusal(() => definitionTarget(path))
      expect(error.code, path).toBe('validation_error')
    }
  })

  it('markdownDefinitionTarget refuses settings files and .mcp.json', async () => {
    expect(markdownDefinitionTarget('.claude/skills/pdf/SKILL.md').kind).toBe('skill')
    for (const path of ['.claude/settings.json', '.harness/settings.local.json', '.mcp.json'])
      expect((await refusal(() => markdownDefinitionTarget(path))).message).toBe('Only agent, command, skill and output style files can be deleted.')
  })

  it('parse options and the skill folder', () => {
    expect(definitionParseOptions(definitionTarget('.claude/commands/db/migrate.md'))).toEqual({ fileName: 'migrate.md' })
    expect(definitionParseOptions(definitionTarget('.claude/skills/pdf/SKILL.md'))).toEqual({ folderName: 'pdf' })
    expect(skillFolderOf(definitionTarget('.claude/skills/pdf/SKILL.md'))).toBe('.claude/skills/pdf')
    expect(skillFolderOf(definitionTarget('.claude/agents/a.md'))).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('resolveDefinitionPath', () => {
  it('resolves an existing and a missing path to themselves', async () => {
    await mkdir(join(root, '.claude', 'agents'), { recursive: true })
    await writeFile(join(root, '.claude', 'agents', 'a.md'), 'x')
    expect(await resolveDefinitionPath(root, '.claude/agents/a.md')).toEqual({ absolute: join(root, '.claude', 'agents', 'a.md'), rel: '.claude/agents/a.md', exists: true })
    expect(await resolveDefinitionPath(root, '.harness/skills/pdf/SKILL.md')).toEqual({ absolute: join(root, '.harness', 'skills', 'pdf', 'SKILL.md'), rel: '.harness/skills/pdf/SKILL.md', exists: false })
  })

  it('refuses a linked .claude folder (inside and outside the project), a linked file and a dangling link', async () => {
    await mkdir(join(root, 'real', 'agents'), { recursive: true })
    await writeFile(join(root, 'real', 'agents', 'a.md'), 'x')
    await symlink(join(root, 'real'), join(root, '.claude'))
    for (const path of ['.claude/agents/a.md', '.claude/agents/new.md', '.claude/settings.json'])
      expect((await refusal(resolveDefinitionPath(root, path))).code, path).toBe('validation_error')

    const outside = join(base, 'outside')
    await mkdir(join(outside, 'agents'), { recursive: true })
    await symlink(outside, join(root, '.harness'))
    expect((await refusal(resolveDefinitionPath(root, '.harness/agents/a.md'))).message).toContain('outside the project folder')

    await rm(join(root, '.claude'))
    await mkdir(join(root, '.claude', 'agents'), { recursive: true })
    await symlink(join(root, 'real', 'agents', 'a.md'), join(root, '.claude', 'agents', 'linked.md'))
    expect((await refusal(resolveDefinitionPath(root, '.claude/agents/linked.md'))).message).toContain('symbolic link')
    await symlink(join(root, 'nowhere.md'), join(root, '.claude', 'agents', 'dangling.md'))
    expect((await refusal(resolveDefinitionPath(root, '.claude/agents/dangling.md'))).code).toBe('validation_error')
    await symlink(join(root, 'real', 'agents', 'a.md'), join(root, '.mcp.json'))
    expect((await refusal(resolveDefinitionPath(root, '.mcp.json'))).code).toBe('validation_error')
  })

  it('refuses a file where a folder is expected', async () => {
    await writeFile(join(root, '.claude'), 'not a folder')
    expect((await refusal(resolveDefinitionPath(root, '.claude/agents/a.md'))).code).toBe('validation_error')
  })

  it('resolveDefinitionPathAgain: a folder replaced by a link after the first check is refused', async () => {
    await mkdir(join(root, '.claude', 'agents'), { recursive: true })
    const first = await resolveDefinitionPath(root, '.claude/agents/a.md')
    expect(await resolveDefinitionPathAgain(root, '.claude/agents/a.md', first)).toMatchObject({ rel: '.claude/agents/a.md', exists: false })

    await rename(join(root, '.claude'), join(root, 'moved'))
    await symlink(join(root, 'moved'), join(root, '.claude'))
    expect((await refusal(resolveDefinitionPathAgain(root, '.claude/agents/a.md', first))).message).toContain('symbolic link')
  })
})
