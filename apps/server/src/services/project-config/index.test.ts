// Smoke tests of the project config reader stub (Phase 11, C36-T3): the final signatures; the folder is opened, nothing
// in it is read yet. W11.3 replaces the stub and these expectations with the real ones.
import type { TrustHashItem } from '@harness-forge/shared'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trustHashInput } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { emptyProjectConfigSnapshot, trustSha256 } from './index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

const HOOK: TrustHashItem = { kind: 'hook', event: 'PreToolUse', matcher: 'Bash', command: 'sh .claude/hooks/guard.sh', timeoutSec: null, refs: [{ path: '.claude/hooks/guard.sh', sha256: 'c'.repeat(64) }] }

describe('project config reader stub (P11-0b)', () => {
  it('snapshot opens the folder and lists nothing; an unknown project is unavailable; an aborted signal rejects', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const t = await createTestApp({ builtins: [], workspaceRoots: [root] })
    cleanups.push(() => t.close())
    const project = await t.deps.projects.create({ name: 'Demo', path: root, newFolder: 'demo' })

    const snapshot = await t.deps.projectConfig.snapshot(project.id, { refresh: true })
    expect(snapshot).toMatchObject({
      projectId: project.id,
      available: true,
      issue: null,
      root: join(root, 'demo'),
      settingsFiles: [],
      mcpFile: false,
      hooks: [],
      mcpServers: [],
      hookDiagnostics: [],
      mcpDiagnostics: [],
    })
    expect(snapshot.scannedAt).toBeGreaterThan(0)

    const unknown = await t.deps.projectConfig.snapshot('prj_ZZZZZZZZZZZZZZZZ')
    expect(unknown).toMatchObject({ available: false, root: null, hooks: [], mcpServers: [] })
    expect(unknown.issue).toEqual(expect.any(String))

    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(t.deps.projectConfig.snapshot(project.id, { signal: aborted.signal })).rejects.toThrow('stopped')

    // Fail closed: the stub knows no item, so nothing verifies.
    expect(await t.deps.projectConfig.verify(project.id, { kind: 'hook', sha256: trustSha256(HOOK), hashItem: HOOK })).toBe(false)
    await expect(t.deps.projectConfig.verify(project.id, { kind: 'hook', sha256: trustSha256(HOOK), hashItem: HOOK }, aborted.signal)).rejects.toThrow('stopped')
    expect(t.deps.projectConfig.invalidate(project.id)).toBeUndefined()
    expect(t.deps.projectConfig.invalidate(null)).toBeUndefined()
    expect(t.deps.projectConfig.stop()).toBeUndefined()
  })

  it('trustSha256 is the sha256 (lowercase hex) of the shared canonical trustHashInput', () => {
    const hash = trustSha256(HOOK)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(createHash('sha256').update(trustHashInput(HOOK), 'utf8').digest('hex'))
    // A referenced file that changed is another hash.
    expect(trustSha256({ ...HOOK, refs: [{ path: '.claude/hooks/guard.sh', sha256: 'd'.repeat(64) }] })).not.toBe(hash)
    expect(emptyProjectConfigSnapshot('prj_AAAAAAAAAAAAAAAA', { available: false, issue: 'gone', root: null }, 5)).toMatchObject({ scannedAt: 5, issue: 'gone', hooks: [] })
  })
})
