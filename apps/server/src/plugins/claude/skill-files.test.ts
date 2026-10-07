// The plugin skill-file helpers (C43 signatures, W12.1-T9): list and read the supporting files of a plugin skill's
// folder through the workspace guards with the plugin realpath as the root.
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudePluginFiles, writeFileTree } from '../../testing/claude-fixtures.ts'
import { listPluginSkillFiles, readPluginSkillFile } from './skill-files.ts'

let root: string
let outside: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hf-skill-files-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'hf-skill-outside-')))
  await writeFileTree(root, claudePluginFiles('review-kit'))
  await writeFile(join(outside, 'secret.txt'), 'outside the plugin\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('listPluginSkillFiles', () => {
  it('lists the supporting files of the skill folder (SKILL.md left out), relative to it', async () => {
    expect(await listPluginSkillFiles(root, 'skills/pdf')).toEqual(['reference.md', 'scripts/fill.sh'])
  })

  it.skipIf(process.platform === 'win32')('leaves out links, hidden and secret-looking files; a missing or linked folder lists nothing', async () => {
    await writeFile(join(root, 'skills/pdf/.hidden.md'), 'x')
    await writeFile(join(root, 'skills/pdf/.env'), 'TOKEN=x')
    await writeFile(join(root, 'skills/pdf/id_rsa'), 'x')
    await symlink(join(outside, 'secret.txt'), join(root, 'skills/pdf/linked.txt'))
    expect(await listPluginSkillFiles(root, 'skills/pdf')).toEqual(['reference.md', 'scripts/fill.sh'])
    expect(await listPluginSkillFiles(root, 'skills/missing')).toEqual([])
    expect(await listPluginSkillFiles(root, '../outside')).toEqual([])
    await symlink(join(root, 'skills/pdf'), join(root, 'skills/alias'))
    expect(await listPluginSkillFiles(root, 'skills/alias')).toEqual([])
  })

  it('caps the list at LIMITS.skillFilesListedMax files', async () => {
    await mkdir(join(root, 'skills/many'), { recursive: true })
    await writeFile(join(root, 'skills/many/SKILL.md'), '---\ndescription: many\n---\nx\n')
    for (let index = 0; index < LIMITS.skillFilesListedMax + 5; index++)
      await writeFile(join(root, `skills/many/file-${String(index).padStart(3, '0')}.md`), 'x')
    expect(await listPluginSkillFiles(root, 'skills/many')).toHaveLength(LIMITS.skillFilesListedMax)
  })

  it('an aborted signal rejects', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(listPluginSkillFiles(root, 'skills/pdf', controller.signal)).rejects.toThrow('stopped')
  })
})

describe('readPluginSkillFile', () => {
  it('reads a supporting file (scripts/fill.sh, reference.md) and the root skill of a plugin', async () => {
    expect(await readPluginSkillFile(root, 'skills/pdf', 'scripts/fill.sh')).toEqual({
      path: 'scripts/fill.sh',
      content: '#!/bin/sh\nprintf \'filled %s\\n\' "$1"\n',
      truncated: false,
    })
    expect(await readPluginSkillFile(root, 'skills/pdf', './reference.md')).toMatchObject({ path: 'reference.md', truncated: false })
    const single = await realpath(await mkdtemp(join(tmpdir(), 'hf-single-skill-')))
    try {
      await writeFileTree(single, claudePluginFiles('single-skill'))
      expect(await readPluginSkillFile(single, '.', 'reference.md')).toMatchObject({ path: 'reference.md', content: expect.stringContaining('# Glossary') })
    }
    finally {
      await rm(single, { recursive: true, force: true })
    }
  })

  it('cuts a long file at LIMITS.skillFileReadBytes (truncated)', async () => {
    await writeFile(join(root, 'skills/pdf/long.md'), 'é'.repeat(LIMITS.skillFileReadBytes))
    const file = await readPluginSkillFile(root, 'skills/pdf', 'long.md')
    expect(file.truncated).toBe(true)
    expect(Buffer.byteLength(file.content, 'utf8')).toBeLessThanOrEqual(LIMITS.skillFileReadBytes)
    expect(file.content.endsWith('é')).toBe(true)
  })

  it.each([
    ['../../../etc/passwd'],
    ['../SKILL.md'],
    ['/etc/passwd'],
    ['..'],
    ['.env'],
    ['.hidden/notes.md'],
    ['id_rsa'],
    ['a\\b.md'],
    [''],
    ['x'.repeat(513)],
  ])('refuses %j with validation_error', async (file) => {
    await expect(readPluginSkillFile(root, 'skills/pdf', file)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('a missing file is not_found; a binary file is refused', async () => {
    await expect(readPluginSkillFile(root, 'skills/pdf', 'missing.md')).rejects.toMatchObject({ code: 'not_found' })
    await writeFile(join(root, 'skills/pdf/blob.bin'), Buffer.from([1, 2, 0, 3]))
    await expect(readPluginSkillFile(root, 'skills/pdf', 'blob.bin')).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('binary') })
  })

  it.skipIf(process.platform === 'win32')('refuses a link (to a file outside or inside the plugin) and a skill folder reached through a link', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'skills/pdf/linked.txt'))
    await expect(readPluginSkillFile(root, 'skills/pdf', 'linked.txt')).rejects.toMatchObject({ code: 'validation_error' })
    await symlink(join(root, 'skills/pdf/reference.md'), join(root, 'skills/pdf/inner-link.md'))
    await expect(readPluginSkillFile(root, 'skills/pdf', 'inner-link.md')).rejects.toMatchObject({ code: 'validation_error' })
    await symlink(join(root, 'skills/pdf'), join(root, 'skills/alias'))
    await expect(readPluginSkillFile(root, 'skills/alias', 'reference.md')).rejects.toMatchObject({ code: 'validation_error' })
    await expect(readPluginSkillFile(root, '../x', 'reference.md')).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('an aborted signal rejects', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(readPluginSkillFile(root, 'skills/pdf', 'reference.md', controller.signal)).rejects.toThrow('stopped')
  })
})
