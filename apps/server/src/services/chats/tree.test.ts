import type { TreeRow } from './tree.ts'
import { describe, expect, it } from 'vitest'
import { branchesOf, buildTree, latestLeafUnder, pathTo, rememberedLeafUnder, resolveLeaf, siblingsOf } from './tree.ts'

function row(id: string, parentId: string | null, seq: number, role: TreeRow['role'] = 'user', selectedChildId?: string | null): TreeRow {
  return { id, parentId, seq, role, ...(selectedChildId === undefined ? {} : { selectedChildId }) }
}

/**
 * ARCHITECTURE.md 6.8: A (0) -> RA (1) -> B (2) -> RB (3); A2 (4, an edit of A: a second first message) -> RA2 (5);
 * RA' (6, a regenerated reply to A) -> C (7).
 */
const ROWS: TreeRow[] = [
  row('A', null, 0),
  row('RA', 'A', 1, 'assistant'),
  row('B', 'RA', 2),
  row('RB', 'B', 3, 'assistant'),
  row('A2', null, 4),
  row('RA2', 'A2', 5, 'assistant'),
  row('RA3', 'A', 6, 'assistant'),
  row('C', 'RA3', 7),
]

describe('buildTree', () => {
  it('orders rows by seq and groups siblings by parent in seq order; first messages are siblings', () => {
    const tree = buildTree([...ROWS].reverse())
    expect(tree.rows.map(entry => entry.id)).toEqual(['A', 'RA', 'B', 'RB', 'A2', 'RA2', 'RA3', 'C'])
    expect(siblingsOf(tree, 'A')).toEqual(['A', 'A2'])
    expect(siblingsOf(tree, 'A2')).toEqual(['A', 'A2'])
    expect(siblingsOf(tree, 'RA3')).toEqual(['RA', 'RA3'])
    expect(siblingsOf(tree, 'B')).toEqual(['B'])
    expect(siblingsOf(tree, 'nope')).toEqual([])
    expect(tree.parentOf.get('C')).toBe('RA3')
  })

  it('treats a parent outside the chat, a later parent, a self-parent and a cycle as no parent', () => {
    const tree = buildTree([
      row('a', 'b', 0),
      row('b', 'a', 1),
      row('c', 'elsewhere', 2),
      row('d', 'd', 3),
      row('e', 'f', 4),
      row('f', 'e', 5),
    ])
    expect(Object.fromEntries(tree.parentOf)).toEqual({ a: null, b: 'a', c: null, d: null, e: null, f: 'e' })
    expect(siblingsOf(tree, 'a')).toEqual(['a', 'c', 'd', 'e'])
    // Every walk ends.
    expect(pathTo(tree, 'b')).toEqual(['a', 'b'])
    expect(pathTo(tree, 'f')).toEqual(['e', 'f'])
    expect(pathTo(tree, 'd')).toEqual(['d'])
    expect(latestLeafUnder(tree, 'a')).toBe('b')
    expect(latestLeafUnder(tree, 'e')).toBe('f')
  })
})

describe('pathTo', () => {
  it('walks from the first message to the leaf', () => {
    const tree = buildTree(ROWS)
    expect(pathTo(tree, 'RB')).toEqual(['A', 'RA', 'B', 'RB'])
    expect(pathTo(tree, 'C')).toEqual(['A', 'RA3', 'C'])
    expect(pathTo(tree, 'RA2')).toEqual(['A2', 'RA2'])
    expect(pathTo(tree, 'A')).toEqual(['A'])
  })

  it('is empty for null and for an id outside the chat', () => {
    const tree = buildTree(ROWS)
    expect(pathTo(tree, null)).toEqual([])
    expect(pathTo(tree, 'nope')).toEqual([])
    expect(pathTo(buildTree([]), null)).toEqual([])
  })
})

describe('branchesOf', () => {
  it('lists the path messages that have other versions with their index', () => {
    const tree = buildTree(ROWS)
    expect(branchesOf(tree, pathTo(tree, 'RA2'))).toEqual({ A2: { siblings: ['A', 'A2'], index: 1 } })
    expect(branchesOf(tree, pathTo(tree, 'RB'))).toEqual({
      A: { siblings: ['A', 'A2'], index: 0 },
      RA: { siblings: ['RA', 'RA3'], index: 0 },
    })
    expect(branchesOf(tree, pathTo(tree, 'C'))).toEqual({
      A: { siblings: ['A', 'A2'], index: 0 },
      RA3: { siblings: ['RA', 'RA3'], index: 1 },
    })
  })

  it('is empty for a linear chat and skips unknown ids', () => {
    const tree = buildTree([row('a', null, 0), row('b', 'a', 1, 'assistant')])
    expect(branchesOf(tree, ['a', 'b', 'x'])).toEqual({})
  })
})

describe('latestLeafUnder', () => {
  it('is the highest seq in the subtree of the message', () => {
    const tree = buildTree(ROWS)
    expect(latestLeafUnder(tree, 'A')).toBe('C')
    expect(latestLeafUnder(tree, 'RA')).toBe('RB')
    expect(latestLeafUnder(tree, 'A2')).toBe('RA2')
    expect(latestLeafUnder(tree, 'RB')).toBe('RB')
    expect(latestLeafUnder(tree, 'nope')).toBeNull()
  })

  it('does not leave the subtree for later messages elsewhere', () => {
    const tree = buildTree([row('a', null, 0), row('b', 'a', 1), row('x', null, 2), row('c', 'b', 3), row('y', 'x', 4)])
    expect(latestLeafUnder(tree, 'a')).toBe('c')
    expect(latestLeafUnder(tree, 'x')).toBe('y')
  })
})

describe('resolveLeaf', () => {
  it('keeps a stored leaf of the chat (also one with children, during a run)', () => {
    const tree = buildTree(ROWS)
    expect(resolveLeaf(tree, 'RB')).toBe('RB')
    expect(resolveLeaf(tree, 'A')).toBe('A')
  })

  it('falls back to the most recent message, or null for an empty chat', () => {
    expect(resolveLeaf(buildTree(ROWS), null)).toBe('C')
    expect(resolveLeaf(buildTree(ROWS), 'deleted')).toBe('C')
    expect(resolveLeaf(buildTree([]), null)).toBeNull()
    expect(resolveLeaf(buildTree([]), 'x')).toBeNull()
  })
})

describe('rememberedLeafUnder (ADR-030)', () => {
  /**
   * A (0) -> RA (1) -> B (2) -> RB (3); under RA a newer version B2 (4) -> RB2 (5); under B a newer reply RB' (6).
   * Latest under A is RB' (6); the remembered path A -> RA -> B -> RB was shown last.
   */
  function versions(pointers: Record<string, string | null | undefined>): TreeRow[] {
    return [
      row('A', null, 0, 'user', pointers.A),
      row('RA', 'A', 1, 'assistant', pointers.RA),
      row('B', 'RA', 2, 'user', pointers.B),
      row('RB', 'B', 3, 'assistant', pointers.RB),
      row('B2', 'RA', 4, 'user', pointers.B2),
      row('RB2', 'B2', 5, 'assistant', pointers.RB2),
      row('RB3', 'B', 6, 'assistant', pointers.RB3),
    ]
  }

  it('follows valid pointers down to the path shown last, where the latest leaf differs', () => {
    const tree = buildTree(versions({ A: 'RA', RA: 'B', B: 'RB' }))
    expect(latestLeafUnder(tree, 'A')).toBe('RB3')
    expect(rememberedLeafUnder(tree, 'A')).toBe('RB')
    expect(rememberedLeafUnder(tree, 'RA')).toBe('RB')
    expect(rememberedLeafUnder(tree, 'B')).toBe('RB')
    // A pointer below the start is followed from any message of the path; a leaf is its own remembered leaf.
    expect(rememberedLeafUnder(tree, 'RB')).toBe('RB')
    const deeper = buildTree(versions({ RA: 'B2' }))
    expect(rememberedLeafUnder(deeper, 'A')).toBe('RB2')
  })

  it('ignores a pointer that names no child of its message (a deleted version, a grandchild, another chat)', () => {
    for (const invalid of ['gone', 'RB', 'A', 'RA']) {
      const tree = buildTree(versions({ A: 'RA', RA: invalid }))
      // RA has two children (B, B2) and an unusable pointer: the latest leaf under RA wins.
      expect(rememberedLeafUnder(tree, 'A'), invalid).toBe('RB3')
    }
    // Under B the pointer is invalid too: the latest leaf under B (RB3), not the latest under A.
    expect(rememberedLeafUnder(buildTree(versions({ RA: 'B', B: 'RB2' })), 'A')).toBe('RB3')
  })

  it('without a pointer takes the only child, else the latest leaf under the node', () => {
    const tree = buildTree(versions({}))
    expect(rememberedLeafUnder(tree, 'A')).toBe('RB3')
    expect(rememberedLeafUnder(tree, 'B2')).toBe('RB2')
    // null and a missing field mean the same.
    expect(rememberedLeafUnder(buildTree(versions({ A: null, RA: null })), 'A')).toBe('RB3')
    // A pointer stops being needed where the path has one child: A -> RA is walked without one.
    expect(rememberedLeafUnder(buildTree(versions({ RA: 'B', B: 'RB' })), 'A')).toBe('RB')
  })

  it('is null for an id outside the chat; the first messages are reached only from themselves', () => {
    const tree = buildTree([...versions({ A: 'RA', RA: 'B', B: 'RB' }), row('A2', null, 7, 'user', 'RA2'), row('RA2', 'A2', 8, 'assistant')])
    expect(rememberedLeafUnder(tree, 'nope')).toBeNull()
    expect(rememberedLeafUnder(buildTree([]), 'A')).toBeNull()
    expect(rememberedLeafUnder(tree, 'A2')).toBe('RA2')
    expect(rememberedLeafUnder(tree, 'A')).toBe('RB')
  })

  it('never follows a pointer to an older message or out of a cycle (bad data ends the walk)', () => {
    // b's stored parent is c (later): b is a first message; a pointer from c back to b is not a child of c.
    const tree = buildTree([row('a', null, 0, 'user', 'b'), row('b', 'c', 1, 'user', 'a'), row('c', 'a', 2, 'user', 'b')])
    expect(rememberedLeafUnder(tree, 'a')).toBe('c')
    expect(rememberedLeafUnder(tree, 'b')).toBe('b')
  })
})
