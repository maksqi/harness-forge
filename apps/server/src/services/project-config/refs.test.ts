// Guarded reads and reference hashing of project items (Phase 11, W11.3-T1): links, sizes, secret names, the shared
// command rule (W11.5 computes the same hash) and the paths verify re-derives from an item.
import type { TrustHashItem } from '@harness-forge/shared'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRUST_LIMITS, trustHashInput } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commandTrustRefPaths,
  commandTrustSubject,
  hashTrustRefs,
  mcpRefPaths,
  readProjectConfigFile,
  readProjectFileBytes,
  refPathsOf,
  trustSha256,
} from './refs.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function put(root: string, rel: string, content: string | Buffer): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}

function sha(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('readProjectFileBytes / readProjectConfigFile', () => {
  it('reads a regular file and refuses links, folders, missing and oversized files with a reason', async () => {
    const root = await project()
    await put(root, '.claude/settings.json', '{"hooks":{}}')
    await put(root, 'elsewhere/settings.json', '{"hooks":{}}')
    await mkdir(join(root, '.harness'))
    await symlink(join(root, 'elsewhere/settings.json'), join(root, '.harness/settings.json'))
    await mkdir(join(root, '.harness/settings.local.json'))
    await put(root, 'big.json', 'x'.repeat(101))

    expect(await readProjectConfigFile(root, '.claude/settings.json', 1024)).toEqual({ ok: true, text: '{"hooks":{}}' })
    expect(await readProjectConfigFile(root, '.harness/settings.json', 1024)).toEqual({ ok: false, reason: 'link' })
    expect(await readProjectConfigFile(root, '.harness/settings.local.json', 1024)).toEqual({ ok: false, reason: 'not-file' })
    expect(await readProjectConfigFile(root, '.claude/settings.local.json', 1024)).toEqual({ ok: false, reason: 'missing' })
    expect(await readProjectConfigFile(root, 'big.json', 100)).toEqual({ ok: false, reason: 'too-large' })
    expect((await readProjectFileBytes(root, 'big.json', 101)).ok).toBe(true)
  })

  it('refuses a file below a linked folder and a dangling link', async () => {
    const root = await project()
    await put(root, 'real/settings.json', '{}')
    await symlink(join(root, 'real'), join(root, '.claude'))
    await symlink(join(root, 'nowhere.json'), join(root, '.mcp.json'))
    expect(await readProjectConfigFile(root, '.claude/settings.json', 1024)).toEqual({ ok: false, reason: 'link' })
    expect(await readProjectConfigFile(root, '.mcp.json', 1024)).toEqual({ ok: false, reason: 'link' })
  })

  it('refuses a link that leaves the project folder', async () => {
    const root = await project()
    const outside = await project()
    await put(outside, 'settings.json', '{}')
    await mkdir(join(root, '.claude'))
    await symlink(join(outside, 'settings.json'), join(root, '.claude/settings.json'))
    expect(await readProjectConfigFile(root, '.claude/settings.json', 1024)).toEqual({ ok: false, reason: 'link' })
  })
})

describe('hashTrustRefs', () => {
  it('hashes regular files; null for missing, linked, secret-looking and oversized files', async () => {
    const root = await project()
    await put(root, '.claude/hooks/check.sh', 'echo ok\n')
    await put(root, 'scripts/real.sh', 'echo real\n')
    await symlink(join(root, 'scripts/real.sh'), join(root, 'scripts/linked.sh'))
    await put(root, 'scripts/.env', 'TOKEN=1')
    await put(root, 'scripts/big.sh', Buffer.alloc(TRUST_LIMITS.refFileBytes + 1, 0x61))
    await put(root, 'scripts/exact.sh', Buffer.alloc(TRUST_LIMITS.refFileBytes, 0x61))

    const refs = await hashTrustRefs(root, ['.claude/hooks/check.sh', 'scripts/missing.sh', 'scripts/linked.sh', 'scripts/.env', 'scripts/big.sh', 'scripts/exact.sh'])
    expect(refs).toEqual([
      { path: '.claude/hooks/check.sh', sha256: sha('echo ok\n') },
      { path: 'scripts/missing.sh', sha256: null },
      { path: 'scripts/linked.sh', sha256: null },
      { path: 'scripts/.env', sha256: null },
      { path: 'scripts/big.sh', sha256: null },
      { path: 'scripts/exact.sh', sha256: sha(Buffer.alloc(TRUST_LIMITS.refFileBytes, 0x61)) },
    ])
  })

  it('keeps at most 8 unique paths in order, shares a memo and rejects only on abort', async () => {
    const root = await project()
    const paths = Array.from({ length: 10 }, (_, index) => `s/${index}.sh`)
    const refs = await hashTrustRefs(root, ['s/0.sh', ...paths])
    expect(refs.map(ref => ref.path)).toEqual(paths.slice(0, 8))

    const memo = new Map<string, Promise<string | null>>()
    await put(root, 's/0.sh', 'one')
    await hashTrustRefs(root, ['s/0.sh'], { memo })
    await put(root, 's/0.sh', 'two')
    // The memo of one build answers the first read again.
    expect(await hashTrustRefs(root, ['s/0.sh'], { memo })).toEqual([{ path: 's/0.sh', sha256: sha('one') }])
    expect(await hashTrustRefs(root, ['s/0.sh'])).toEqual([{ path: 's/0.sh', sha256: sha('two') }])

    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(hashTrustRefs(root, ['s/0.sh'], aborted.signal)).rejects.toThrow('stopped')
  })
})

describe('the command trust rule (shared with the command resolution, W11.5)', () => {
  it('commandTrustRefPaths: the refs of each span in order, first seen kept, at most 8', () => {
    expect(commandTrustRefPaths(['sh scripts/a.sh && sh scripts/b.sh', 'sh scripts/a.sh', 'git status --short'])).toEqual(['scripts/a.sh', 'scripts/b.sh'])
    const many = Array.from({ length: 12 }, (_, index) => `sh scripts/s${index}.sh`)
    expect(commandTrustRefPaths(many)).toHaveLength(TRUST_LIMITS.refFilesMax)
  })

  it('commandTrustSubject hashes { kind: command, name, spans, refs } with the referenced files', async () => {
    const root = await project()
    await put(root, 'scripts/count.sh', 'echo 1\n')
    const spans = ['sh scripts/count.sh', 'git status --short']
    const subject = await commandTrustSubject(root, 'status', spans)
    const hashItem: TrustHashItem = { kind: 'command', name: 'status', spans, refs: [{ path: 'scripts/count.sh', sha256: sha('echo 1\n') }] }
    expect(subject).toEqual({ kind: 'command', sha256: createHash('sha256').update(trustHashInput(hashItem), 'utf8').digest('hex'), hashItem })
    expect(subject.sha256).toBe(trustSha256(hashItem))

    await put(root, 'scripts/count.sh', 'echo 2\n')
    expect((await commandTrustSubject(root, 'status', spans)).sha256).not.toBe(subject.sha256)
  })

  it('refPathsOf re-derives the paths from the item fields of every kind', () => {
    expect(refPathsOf({ kind: 'hook', event: 'PreToolUse', matcher: null, command: 'sh "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh', timeoutSec: null, refs: [] })).toEqual(['.claude/hooks/x.sh'])
    expect(refPathsOf({ kind: 'mcp', name: 'local', server: { command: ' node ', args: ['./servers/mcp.mjs', '--flag'] }, refs: [] })).toEqual(['servers/mcp.mjs'])
    expect(refPathsOf({ kind: 'mcp', name: 'remote', server: { type: 'http', url: 'https://example.invalid/mcp' }, refs: [] })).toEqual([])
    expect(refPathsOf({ kind: 'command', name: 'x', spans: ['sh scripts/a.sh'], refs: [] })).toEqual(['scripts/a.sh'])
    expect(mcpRefPaths(null)).toEqual([])
    expect(mcpRefPaths({ command: 'node', args: [1, './a.mjs'] })).toEqual(['a.mjs'])
  })
})
