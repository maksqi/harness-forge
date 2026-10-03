import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { importTarget, probeProjectFile, PROJECT_FILE_IMPORTS_MAX, PROJECT_FILE_TRUNCATED_MARKER, readProjectFile } from './project-file.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A project folder with `files` (relative path -> text or bytes). */
async function project(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await tempFolder()
  for (const [rel, data] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), data)
  }
  return root
}

const MAX = LIMITS.projectFileBytes

describe('project file: precedence', () => {
  it('aGENTS.md wins over CLAUDE.md; CLAUDE.md is the fallback; neither is null', async () => {
    const both = await project({ 'AGENTS.md': 'agents rules', 'CLAUDE.md': 'claude rules' })
    expect(await readProjectFile(both)).toEqual({ name: 'AGENTS.md', content: 'agents rules', truncated: false })
    expect(await probeProjectFile(both)).toBe('AGENTS.md')
    const claude = await project({ 'CLAUDE.md': 'claude rules' })
    expect(await readProjectFile(claude)).toEqual({ name: 'CLAUDE.md', content: 'claude rules', truncated: false })
    expect(await probeProjectFile(claude)).toBe('CLAUDE.md')
    const none = await project({ 'README.md': 'readme', 'sub/AGENTS.md': 'not at the root' })
    expect(await readProjectFile(none)).toBeNull()
    expect(await probeProjectFile(none)).toBeNull()
  })

  it('an AGENTS.md that is a folder, binary or a link out of the root is skipped', async () => {
    const folder = await project({ 'AGENTS.md/inner.txt': 'x', 'CLAUDE.md': 'fallback' })
    expect(await readProjectFile(folder)).toMatchObject({ name: 'CLAUDE.md', content: 'fallback' })
    const binary = await project({ 'AGENTS.md': new Uint8Array([0x61, 0x00, 0x62]), 'CLAUDE.md': 'fallback' })
    expect(await readProjectFile(binary)).toMatchObject({ name: 'CLAUDE.md' })
    expect(await probeProjectFile(binary)).toBe('CLAUDE.md')
    const outside = await project({ 'secret.md': 'outside text' })
    const linked = await project({})
    await symlink(join(outside, 'secret.md'), join(linked, 'AGENTS.md'))
    expect(await readProjectFile(linked)).toBeNull()
    expect(await probeProjectFile(linked)).toBeNull()
    // A link to a file inside the root is followed (the guard resolves it to its target).
    const inside = await project({ 'docs/rules.md': 'linked rules' })
    await symlink(join(inside, 'docs/rules.md'), join(inside, 'AGENTS.md'))
    expect(await readProjectFile(inside)).toMatchObject({ name: 'AGENTS.md', content: 'linked rules' })
  })

  it('reads the file again on every call', async () => {
    const root = await project({ 'AGENTS.md': 'first' })
    expect((await readProjectFile(root))?.content).toBe('first')
    await writeFile(join(root, 'AGENTS.md'), 'second')
    expect((await readProjectFile(root))?.content).toBe('second')
  })
})

describe('project file: @ expansion', () => {
  it('expands a line made only of @relative.md, one level deep, keeping the line ending', async () => {
    const root = await project({
      'CLAUDE.md': '@AGENT.md\n',
      'AGENT.md': '# Rules\nUse tabs.\n@nested.md\n',
      'nested.md': 'never inlined',
    })
    expect(await readProjectFile(root)).toEqual({ name: 'CLAUDE.md', content: '# Rules\nUse tabs.\n@nested.md\n', truncated: false })
  })

  it('accepts spaces around the line and sub folders; adds the line ending after a file without one', async () => {
    const root = await project({
      'AGENTS.md': 'Intro\n  @docs/style.md  \nOutro',
      'docs/style.md': 'Style guide',
    })
    expect((await readProjectFile(root))?.content).toBe('Intro\nStyle guide\nOutro')
    const crlf = await project({ 'AGENTS.md': 'A\r\n@b.md\r\nC', 'b.md': 'B' })
    expect((await readProjectFile(crlf))?.content).toBe('A\r\nB\r\nC')
  })

  it('leaves other lines as written: inline mentions, non-markdown, absolute, missing, outside the root, links out', async () => {
    const outside = await project({ 'outside.md': 'outside text' })
    const root = await project({
      'AGENTS.md': [
        'See @inline.md for more.',
        '@notes.txt',
        `@${join(outside, 'outside.md')}`,
        '@missing.md',
        '@../outside.md',
        '@link-out.md',
        '@~/home.md',
        '@ok.md',
        '',
      ].join('\n'),
      'inline.md': 'never',
      'notes.txt': 'never',
      'ok.md': 'expanded',
    })
    await symlink(join(outside, 'outside.md'), join(root, 'link-out.md'))
    const file = await readProjectFile(root)
    expect(file?.content).toBe([
      'See @inline.md for more.',
      '@notes.txt',
      `@${join(outside, 'outside.md')}`,
      '@missing.md',
      '@../outside.md',
      '@link-out.md',
      '@~/home.md',
      'expanded',
      '',
    ].join('\n'))
    expect(file?.content).not.toContain('outside text')
  })

  it('a binary import stays as written; at most PROJECT_FILE_IMPORTS_MAX lines are expanded', async () => {
    const binary = await project({ 'AGENTS.md': '@bin.md\n', 'bin.md': new Uint8Array([0x00, 0x01]) })
    expect((await readProjectFile(binary))?.content).toBe('@bin.md\n')
    const many = await project({ 'AGENTS.md': '@x.md\n'.repeat(PROJECT_FILE_IMPORTS_MAX + 2), 'x.md': 'X' })
    expect((await readProjectFile(many))?.content).toBe(`${'X\n'.repeat(PROJECT_FILE_IMPORTS_MAX)}@x.md\n@x.md\n`)
  })

  it('importTarget', () => {
    expect(importTarget('@AGENT.md')).toBe('AGENT.md')
    expect(importTarget(' @docs/a.MD \n')).toBe('docs/a.MD')
    expect(importTarget('@a.md b')).toBeNull()
    expect(importTarget('@')).toBeNull()
    expect(importTarget('@a.txt')).toBeNull()
    expect(importTarget('@/etc/a.md')).toBeNull()
    expect(importTarget('@~/a.md')).toBeNull()
    expect(importTarget('@C:/a.md')).toBeNull()
    expect(importTarget('text @a.md')).toBeNull()
  })
})

describe('project file: the 32 KiB cap', () => {
  it('a file of exactly LIMITS.projectFileBytes is whole; one byte more is cut with the marker', async () => {
    const exact = await project({ 'AGENTS.md': 'x'.repeat(MAX) })
    expect(await readProjectFile(exact)).toEqual({ name: 'AGENTS.md', content: 'x'.repeat(MAX), truncated: false })
    const over = await project({ 'AGENTS.md': 'x'.repeat(MAX + 1) })
    expect(await readProjectFile(over)).toEqual({ name: 'AGENTS.md', content: `${'x'.repeat(MAX)}${PROJECT_FILE_TRUNCATED_MARKER}`, truncated: true })
  })

  it('counts the imported text: the total is cut at the cap', async () => {
    const root = await project({ 'AGENTS.md': `${'a'.repeat(100)}\n@big.md\nafter\n`, 'big.md': 'b'.repeat(MAX) })
    const file = await readProjectFile(root)
    expect(file?.truncated).toBe(true)
    expect(file?.content).toBe(`${'a'.repeat(100)}\n${'b'.repeat(MAX - 101)}${PROJECT_FILE_TRUNCATED_MARKER}`)
    expect(file?.content).not.toContain('after')
    // Line endings count too: an import that fills the cap exactly leaves no room for the newline after it.
    const full = await project({ 'AGENTS.md': '@fill.md\n', 'fill.md': 'f'.repeat(MAX) })
    expect(await readProjectFile(full)).toEqual({ name: 'AGENTS.md', content: `${'f'.repeat(MAX)}${PROJECT_FILE_TRUNCATED_MARKER}`, truncated: true })
  })

  it('cuts at a UTF-8 character boundary', async () => {
    // 'é' is two bytes: MAX - 1 ASCII bytes leave one byte, which cannot hold it.
    const root = await project({ 'AGENTS.md': `${'x'.repeat(MAX - 1)}\u00E9\u00E9` })
    const file = await readProjectFile(root)
    expect(file?.truncated).toBe(true)
    expect(file?.content).toBe(`${'x'.repeat(MAX - 1)}${PROJECT_FILE_TRUNCATED_MARKER}`)
    expect(file?.content).not.toContain('\uFFFD')
    // An import read with 9 bytes left: 'ab' + two euro signs (3 bytes each) + 1 byte of the third, which is dropped.
    const imported = await project({ 'AGENTS.md': `${'x'.repeat(MAX - 10)}\n@u.md\n`, 'u.md': 'ab\u20AC\u20AC\u20AC\u20AC' })
    const cutImport = await readProjectFile(imported)
    expect(cutImport?.content).toBe(`${'x'.repeat(MAX - 10)}\nab\u20AC\u20AC${PROJECT_FILE_TRUNCATED_MARKER}`)
    // A line of the main file after a large import: 5 bytes are left, two '\u00E9' fit, the third is split and dropped.
    const after = await project({ 'AGENTS.md': `@a.md\n${'\u00E9'.repeat(100)}`, 'a.md': 'x'.repeat(MAX - 6) })
    const cutLine = await readProjectFile(after)
    expect(cutLine?.content).toBe(`${'x'.repeat(MAX - 6)}\n\u00E9\u00E9${PROJECT_FILE_TRUNCATED_MARKER}`)
    expect(Buffer.byteLength(cutLine!.content.slice(0, -PROJECT_FILE_TRUNCATED_MARKER.length))).toBe(MAX - 1)
  })
})
