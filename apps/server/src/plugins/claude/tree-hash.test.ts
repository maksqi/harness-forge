// The whole-tree trust hash (W12.1-T2): `hf-claude-plugin/v1` over every regular file (UTF-8 path order, mode, size,
// content sha256) and the canonical overlay; a golden hash of a fixed tree; edits, exec bits and the overlay change it,
// the overlay's key order does not; links and special files are problems; the digest cache.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileTree } from '../../testing/claude-fixtures.ts'
import { clearTreeHashCache, compareUtf8, hashPluginTree, scanPluginTree, TREE_HASH_PREFIX, treeFileRecord, treeHashCacheSize } from './tree-hash.ts'

/** A fixed tree: plain files, an executable script, a nested folder and names whose UTF-8 and UTF-16 orders differ. */
const FIXED_TREE = {
  'README.md': { content: '# Fixed\n', mode: 0o644 },
  'commands/review.md': { content: '---\ndescription: Review\n---\nReview $ARGUMENTS.\n', mode: 0o644 },
  'scripts/run.sh': { content: '#!/bin/sh\necho run\n', mode: 0o755 },
  'notes/\u{1F600}.md': { content: 'smile\n', mode: 0o644 },
  'notes/～.md': { content: 'wave\n', mode: 0o644 },
  'notes/b.md': { content: 'b\n', mode: 0o644 },
} as const

/** The golden `hf-claude-plugin/v1` hash of `FIXED_TREE` (without and with the overlay below). */
const GOLDEN = '78524bc74ee5c406123b74598fd6bf94eb3f185a0777982e8fa3ba73fe062d53'
const GOLDEN_WITH_OVERLAY = '838088804dcc218187978a1220eea35871c305a27554dec2e40b5f0a032a89fe'
const OVERLAY = { name: 'fixed', strict: true, version: '1.0.0', overlay: { commands: ['./commands/review.md'], description: 'From the entry.' } }

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hf-tree-hash-')))
  await writeFileTree(root, FIXED_TREE)
  clearTreeHashCache()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  clearTreeHashCache()
})

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

async function hashOf(overlay?: typeof OVERLAY | Record<string, unknown>): Promise<string> {
  const tree = await scanPluginTree(root)
  expect(tree.problem).toBeNull()
  return hashPluginTree(tree, overlay as never)
}

describe('the tree hash', () => {
  it.skipIf(process.platform === 'win32')('is the documented layout over the files in UTF-8 path order (golden)', async () => {
    const tree = await scanPluginTree(root)
    expect(tree.files.map(file => file.path)).toEqual(['README.md', 'commands/review.md', 'notes/b.md', 'notes/～.md', 'notes/\u{1F600}.md', 'scripts/run.sh'])
    expect(tree.folders).toEqual(['commands', 'notes', 'scripts'])
    expect(tree.files.find(file => file.path === 'scripts/run.sh')?.executable).toBe(true)
    // The same bytes built by hand.
    const hash = createHash('sha256')
    hash.update(`${TREE_HASH_PREFIX}\0`)
    for (const path of Object.keys(FIXED_TREE).sort(compareUtf8)) {
      const entry = FIXED_TREE[path as keyof typeof FIXED_TREE]
      hash.update(treeFileRecord(path, entry.mode === 0o755, Buffer.byteLength(entry.content), sha256(entry.content)))
    }
    const expected = hash.digest('hex')
    expect(await hashOf()).toBe(expected)
    expect(treeFileRecord('a/b.sh', true, 3, 'f'.repeat(64))).toBe(['F', 'a/b.sh', '755', '3', 'f'.repeat(64)].join('\u0000'))
    expect({ plain: await hashOf(), overlay: await hashOf(OVERLAY) }).toEqual({ plain: GOLDEN, overlay: GOLDEN_WITH_OVERLAY })
  })

  it.skipIf(process.platform === 'win32')('changes when a script changes, an exec bit flips, a file is added or the overlay changes', async () => {
    const before = await hashOf()
    await writeFile(join(root, 'scripts/run.sh'), '#!/bin/sh\necho changed\n')
    const edited = await hashOf()
    expect(edited).not.toBe(before)
    await chmod(join(root, 'scripts/run.sh'), 0o644)
    const flipped = await hashOf()
    expect(flipped).not.toBe(edited)
    await writeFile(join(root, 'extra.md'), 'x')
    expect(await hashOf()).not.toBe(flipped)
    const withOverlay = await hashOf(OVERLAY)
    expect(await hashOf({ ...OVERLAY, version: '1.0.1' })).not.toBe(withOverlay)
  })

  it('does not depend on the key order of the overlay', async () => {
    const reordered = { overlay: { description: 'From the entry.', commands: ['./commands/review.md'] }, version: '1.0.0', strict: true, name: 'fixed' }
    expect(await hashOf(reordered)).toBe(await hashOf(OVERLAY))
  })

  it('caches file digests by identity and times: an unchanged tree reuses them, an edit is seen', async () => {
    const first = await hashOf()
    expect(treeHashCacheSize()).toBe(Object.keys(FIXED_TREE).length)
    expect(await hashOf()).toBe(first)
    await writeFile(join(root, 'README.md'), '# Fixed!\n')
    expect(await hashOf()).not.toBe(first)
    clearTreeHashCache()
    expect(treeHashCacheSize()).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('a link is a problem of an installed tree; a linked folder ignores links, .git and node_modules', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'hf-tree-outside-')))
    try {
      await writeFile(join(outside, 'x.md'), 'x')
      await symlink(join(outside, 'x.md'), join(root, 'notes/linked.md'))
      const installed = await scanPluginTree(root)
      expect(installed.problem).toBe('The plugin contains a symbolic link (notes/linked.md); links are not allowed.')
      await writeFileTree(root, { '.git/HEAD': { content: 'ref: x\n', mode: 0o644 }, 'node_modules/a/index.js': { content: '', mode: 0o644 } })
      const linked = await scanPluginTree(root, { linked: true })
      expect(linked.problem).toBeNull()
      expect(linked.files.map(file => file.path)).toEqual(['README.md', 'commands/review.md', 'notes/b.md', 'notes/～.md', 'notes/\u{1F600}.md', 'scripts/run.sh'])
    }
    finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
