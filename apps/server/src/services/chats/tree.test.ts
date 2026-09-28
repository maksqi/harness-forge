import type { TreeRow } from './tree.ts'
import { describe, expect, it } from 'vitest'
import { branchesOf, buildTree, latestLeafUnder, pathTo, resolveLeaf, siblingsOf } from './tree.ts'

function row(id: string, parentId: string | null, seq: number, role: TreeRow['role'] = 'user'): TreeRow {
  return { id, parentId, seq, role }
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
