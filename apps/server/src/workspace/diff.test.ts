import { workspaceDiffSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { computeWorkspaceDiff, toWorkspaceDiff } from './diff.ts'
import { jsonBytes } from './text.ts'

describe('computeWorkspaceDiff', () => {
  it('produces unified hunks with 3 lines of context and the counts of the change', async () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n')
    const after = ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10', '11'].join('\n')
    const diff = await computeWorkspaceDiff(`${before}\n`, `${after}\n`)
    expect(workspaceDiffSchema.parse(diff)).toEqual(diff)
    expect(diff).toEqual({
      hunks: [
        { oldStart: 2, oldLines: 9, newStart: 2, newLines: 10, lines: [' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8', ' 9', ' 10', '+11'] },
      ],
      added: 2,
      removed: 1,
      truncated: false,
    })
  })

  it('diffs a new file as all lines added, and marks a missing final newline', async () => {
    const created = await computeWorkspaceDiff('', 'a\nb\n')
    expect(created).toMatchObject({ added: 2, removed: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }] })
    const noNewline = await computeWorkspaceDiff('a\n', 'a\nb')
    expect(noNewline!.hunks[0]!.lines).toContain('\\ No newline at end of file')
  })

  it('returns no hunks for identical texts', async () => {
    expect(await computeWorkspaceDiff('same\n', 'same\n')).toEqual({ hunks: [], added: 0, removed: 0, truncated: false })
  })

  it('returns null when the diff times out', async () => {
    const lines = (seed: number) => Array.from({ length: 4000 }, (_, index) => `line ${(index * seed) % 997} ${index % seed}`).join('\n')
    expect(await computeWorkspaceDiff(lines(7), lines(13), { timeoutMs: 1 })).toBeNull()
  })
})

describe('toWorkspaceDiff limits', () => {
  it('cuts long lines at 500 characters and drops a trailing \\r for display', () => {
    const diff = toWorkspaceDiff({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${'x'.repeat(800)}`, '+short\r'] }] })
    expect(diff.hunks[0]!.lines[0]).toHaveLength(500)
    expect(diff.hunks[0]!.lines[1]).toBe('+short')
    expect(diff.truncated).toBe(true)
  })

  it('cuts the hunks to about 24 KiB of JSON and keeps the counts of the whole change', () => {
    const hunks = Array.from({ length: 200 }, (_, index) => ({
      oldStart: index * 10 + 1,
      oldLines: 1,
      newStart: index * 10 + 1,
      newLines: 1,
      lines: [`-${'old '.repeat(40)}${index}`, `+${'new '.repeat(40)}${index}`],
    }))
    const diff = toWorkspaceDiff({ hunks })
    expect(diff.truncated).toBe(true)
    expect(diff.added).toBe(200)
    expect(diff.removed).toBe(200)
    expect(diff.hunks.length).toBeLessThan(200)
    expect(jsonBytes(diff)).toBeLessThanOrEqual(24_576)
    expect(workspaceDiffSchema.safeParse(diff).success).toBe(true)
  })

  it('cuts inside a hunk that does not fit, keeping its header', () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `+${'y'.repeat(100)}${index}`)
    const diff = toWorkspaceDiff({ hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1000, lines }] })
    expect(diff.hunks).toHaveLength(1)
    expect(diff.hunks[0]).toMatchObject({ newStart: 1, newLines: 1000 })
    expect(diff.hunks[0]!.lines.length).toBeLessThan(1000)
    expect(diff.truncated).toBe(true)
    expect(jsonBytes(diff)).toBeLessThanOrEqual(24_576)
  })
})
