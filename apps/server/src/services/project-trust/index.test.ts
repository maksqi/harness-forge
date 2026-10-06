// Smoke tests of the project trust stub (Phase 11, C36-T4): the final signatures over the `project_trust` table; no
// items yet. W11.3 replaces the stub and these expectations with the real ones.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectTrust } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('project trust stub (P11-0b)', () => {
  it('approved answers the stored hashes per project; list has no items and counts them orphaned; deleting a project drops them', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const t = await createTestApp({ builtins: [], workspaceRoots: [root] })
    cleanups.push(() => t.close())
    const project = await t.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })
    const other = await t.deps.projects.create({ name: 'Other', path: root, newFolder: 'other' })
    await t.db.insert(projectTrust).values([
      { projectId: project.id, sha256: 'a'.repeat(64), kind: 'hook', label: 'sh guard.sh' },
      { projectId: project.id, sha256: 'b'.repeat(64), kind: 'mcp', label: 'github' },
    ])

    expect(await t.deps.projectTrust.approved(project.id)).toEqual(new Set(['a'.repeat(64), 'b'.repeat(64)]))
    expect(await t.deps.projectTrust.approved(other.id)).toEqual(new Set())
    expect(await t.deps.projectTrust.approved('prj_ZZZZZZZZZZZZZZZZ')).toEqual(new Set())

    const list = await t.deps.projectTrust.list(project.id)
    expect(list).toMatchObject({ items: [], orphaned: 2, available: true })
    expect(list.scannedAt).toBeGreaterThan(0)
    await expect(t.deps.projectTrust.list('prj_ZZZZZZZZZZZZZZZZ')).rejects.toMatchObject({ code: 'not_found' })
    expect(await t.deps.projectTrust.pending(project.id)).toBe(0)

    await expect(t.deps.projectTrust.approve(project.id, [{ kind: 'hook', sha256: 'c'.repeat(64) }])).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(t.deps.projectTrust.revoke(project.id, 'a'.repeat(64))).rejects.toMatchObject({ code: 'not_implemented' })

    // The rows go with their project (foreign key, ON DELETE CASCADE).
    await t.deps.projects.remove(project.id)
    expect(await t.deps.projectTrust.approved(project.id)).toEqual(new Set())
    expect(await t.db.select().from(projectTrust)).toEqual([])
  })
})
