/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` and `${user_config.KEY}` are literal plugin content */
// The trust pin outside the load (v1.8.1, ADR-053): `verifyClaudePluginTree` re-hashes a loaded plugin's whole tree
// against its pin (edits, exec bits, new files, links, the overlay, a moved folder and a missing pin fail; a linked folder
// pinned by its path passes; other formats are not checked), `readClaudePluginHooks` reads the hooks an untrusted plugin
// declares as written in its files, and the guard shares concurrent checks, loads a changed plugin once and fails closed.
import type { PluginDetail } from '@harness-forge/shared'
import type { ClaudeEntryOverlay, PluginRecord } from '../types.ts'
import type { ClaudeTreeRecord } from './trust.ts'
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSilentLogger } from '../../logger.ts'
import { claudePluginFiles, writeFileTree } from '../../testing/claude-fixtures.ts'
import { pathPin } from '../loader.ts'
import { clearTreeHashCache, hashPluginTree, scanPluginTree } from './tree-hash.ts'
import { claudeSpanTrust, createClaudeTrustGuard, readClaudePluginHooks, verifyClaudePluginTree } from './trust.ts'

const posix = process.platform !== 'win32'
const OVERLAY: ClaudeEntryOverlay = { name: 'uid-mark', strict: true, version: '1.0.0', overlay: { description: 'From the entry.' } }

let base: string
let root: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-claude-trust-')))
  root = join(base, 'uid-mark')
  await writeFileTree(root, claudePluginFiles('uid-mark'))
  clearTreeHashCache()
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
  clearTreeHashCache()
})

async function treeHash(folder: string, overlay: ClaudeEntryOverlay | null = null, linked = false): Promise<string> {
  const tree = await scanPluginTree(folder, { linked })
  expect(tree.problem).toBeNull()
  return hashPluginTree(tree, overlay)
}

function claudeRecord(fields: Partial<ClaudeTreeRecord> = {}): ClaudeTreeRecord {
  return { format: 'claude', source: 'copy', trustedHash: null, origin: null, ...fields }
}

function marketplaceOrigin(overlay: ClaudeEntryOverlay): ClaudeTreeRecord['origin'] {
  return { kind: 'marketplace', marketplaceId: 'mkt_0199a8f0000070008000000000000001', marketplace: 'acme-tools', plugin: 'uid-mark', sourceKind: 'relative', overlay } as ClaudeTreeRecord['origin']
}

describe('verifyClaudePluginTree', () => {
  it('checks only Claude Code rows: a harness row and a missing row pass unchecked', async () => {
    expect(await verifyClaudePluginTree(null, root)).toEqual({ ok: true, checked: false })
    expect(await verifyClaudePluginTree(claudeRecord({ format: 'harness', trustedHash: 'a'.repeat(64) }), root)).toEqual({ ok: true, checked: false })
  })

  it('an unchanged tree passes; no pin, a stale pin and a moved or missing folder fail', async () => {
    const pin = await treeHash(root)
    expect(await verifyClaudePluginTree(claudeRecord({ trustedHash: pin }), root)).toEqual({ ok: true, checked: true })
    // Hashing again is served from the digest cache and gives the same answer.
    expect(await verifyClaudePluginTree(claudeRecord({ trustedHash: pin }), root)).toEqual({ ok: true, checked: true })
    expect(await verifyClaudePluginTree(claudeRecord(), root)).toEqual({ ok: false, reason: 'unpinned' })
    expect(await verifyClaudePluginTree(claudeRecord({ trustedHash: 'b'.repeat(64) }), root)).toEqual({ ok: false, reason: 'changed' })
    if (posix) {
      // A path through a link is not the canonical folder the plugin loaded from.
      await symlink(root, join(base, 'alias'))
      expect(await verifyClaudePluginTree(claudeRecord({ trustedHash: pin }), join(base, 'alias'))).toEqual({ ok: false, reason: 'moved' })
    }
    expect(await verifyClaudePluginTree(claudeRecord({ trustedHash: pin }), join(base, 'gone'))).toEqual({ ok: false, reason: 'moved' })
  })

  it.skipIf(!posix)('an edited script, a flipped exec bit, a new file or a link in the tree fail', async () => {
    const pin = await treeHash(root)
    const record = claudeRecord({ trustedHash: pin })
    const script = join(root, 'scripts/mark.sh')
    const original = await readFile(script, 'utf8')

    await writeFile(script, `${original}echo changed\n`)
    expect(await verifyClaudePluginTree(record, root)).toEqual({ ok: false, reason: 'changed' })
    await writeFile(script, original)
    expect(await verifyClaudePluginTree(record, root)).toEqual({ ok: true, checked: true })

    await chmod(script, 0o644)
    expect(await verifyClaudePluginTree(record, root)).toEqual({ ok: false, reason: 'changed' })
    await chmod(script, 0o755)

    await writeFile(join(root, 'scripts/extra.sh'), 'echo extra\n')
    expect(await verifyClaudePluginTree(record, root)).toEqual({ ok: false, reason: 'changed' })
    await rm(join(root, 'scripts/extra.sh'))
    expect(await verifyClaudePluginTree(record, root)).toEqual({ ok: true, checked: true })

    await symlink(script, join(root, 'scripts/link.sh'))
    expect(await verifyClaudePluginTree(record, root)).toEqual({ ok: false, reason: 'changed' })
  })

  it('the marketplace entry overlay is part of the pin', async () => {
    const pin = await treeHash(root, OVERLAY)
    expect(await verifyClaudePluginTree(claudeRecord({ trustedHash: pin, origin: marketplaceOrigin(OVERLAY) }), root)).toEqual({ ok: true, checked: true })
    expect(await verifyClaudePluginTree(claudeRecord({ trustedHash: pin }), root)).toEqual({ ok: false, reason: 'changed' })
    const other = { ...OVERLAY, overlay: { description: 'Edited entry.' } }
    expect(await verifyClaudePluginTree(claudeRecord({ trustedHash: pin, origin: marketplaceOrigin(other) }), root)).toEqual({ ok: false, reason: 'changed' })
    // The server-only origin of a re-imported marketplace plugin carries the overlay too.
    expect(await verifyClaudePluginTree(claudeRecord({ trustedHash: pin, origin: { kind: 'overlay', overlay: OVERLAY } }), root)).toEqual({ ok: true, checked: true })
  })

  it.skipIf(!posix)('a linked folder pinned by its path passes after an edit; pinned by a hash it is checked', async () => {
    const linked = claudeRecord({ source: 'link', trustedHash: pathPin(root) })
    await writeFile(join(root, 'scripts/mark.sh'), '#!/bin/sh\necho edited\n')
    expect(await verifyClaudePluginTree(linked, root)).toEqual({ ok: true, checked: true })
    const byHash = claudeRecord({ source: 'link', trustedHash: await treeHash(root, null, true) })
    expect(await verifyClaudePluginTree(byHash, root)).toEqual({ ok: true, checked: true })
    await writeFile(join(root, 'scripts/mark.sh'), '#!/bin/sh\necho edited again\n')
    expect(await verifyClaudePluginTree(byHash, root)).toEqual({ ok: false, reason: 'changed' })
  })

  it('rejects when its signal aborts', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(verifyClaudePluginTree(claudeRecord({ trustedHash: 'c'.repeat(64) }), root, controller.signal)).rejects.toThrow('stop')
  })
})

describe('readClaudePluginHooks', () => {
  it('reads the merged hooks of a plugin as written; null when the folder does not read as that plugin', async () => {
    expect(await readClaudePluginHooks('uid-mark', root, null)).toEqual({
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh' }] }],
    })
    // The folder of another plugin id: the host would not load it either.
    expect(await readClaudePluginHooks('other-id', root, null)).toBeNull()
    expect(await readClaudePluginHooks('uid-mark', join(base, 'gone'), null)).toBeNull()
  })

  it('keeps every ${user_config.KEY} of an exec-form handler as a reference', async () => {
    const kit = join(base, 'option-kit')
    await writeFileTree(kit, {
      '.claude-plugin/plugin.json': { content: JSON.stringify({ name: 'option-kit', userConfig: { API_TOKEN: { type: 'string', title: 'Token', sensitive: true } } }), mode: 0o644 },
      'hooks/hooks.json': { content: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh', args: ['${CLAUDE_PLUGIN_ROOT}/stop.sh', '--token=${user_config.API_TOKEN}'] }] }] } }), mode: 0o644 },
      'stop.sh': { content: '#!/bin/sh\nexit 0\n', mode: 0o755 },
    })
    expect(await readClaudePluginHooks('option-kit', kit, { source: 'copy', origin: null })).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: 'sh', args: ['${CLAUDE_PLUGIN_ROOT}/stop.sh', '--token=${user_config.API_TOKEN}'] }] }],
    })
  })
})

describe('createClaudeTrustGuard', () => {
  function fakeHost(record: () => Promise<ClaudeTreeRecord | null>) {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const host = {
      record: vi.fn(async () => (await record()) as PluginRecord | null),
      load: vi.fn(async () => {
        await gate
        return { state: 'untrusted' } as PluginDetail
      }),
    }
    return { host, release: () => release() }
  }

  it('shares concurrent checks, answers false for a changed tree or a failed read, and loads a changed plugin once', async () => {
    const pin = await treeHash(root)
    const { host, release } = fakeHost(async () => claudeRecord({ trustedHash: pin }))
    const guard = createClaudeTrustGuard(host, createSilentLogger())
    expect(await Promise.all([guard.verify('uid-mark', root), guard.verify('uid-mark', root)])).toEqual([true, true])
    expect(host.record).toHaveBeenCalledTimes(1)

    await writeFile(join(root, 'README.md'), 'new file\n')
    expect(await guard.verify('uid-mark', root)).toBe(false)
    guard.changed('uid-mark')
    guard.changed('uid-mark')
    expect(host.load).toHaveBeenCalledTimes(1)
    release()
    await guard.stop()
    // Stopped: nothing is checked or loaded any more.
    expect(await guard.verify('uid-mark', root)).toBe(false)
    guard.changed('uid-mark')
    expect(host.load).toHaveBeenCalledTimes(1)

    const failing = createClaudeTrustGuard({ record: async () => Promise.reject(new Error('db gone')), load: host.load }, createSilentLogger())
    expect(await failing.verify('uid-mark', root)).toBe(false)
    await failing.stop()
  })

  it('a harness plugin passes; the span trust reports a changed plugin and rejects on abort', async () => {
    const { host, release } = fakeHost(async () => claudeRecord({ format: 'harness' }))
    release()
    const guard = createClaudeTrustGuard(host, createSilentLogger())
    expect(await guard.verify('demo', root)).toBe(true)
    await guard.stop()

    const changed = fakeHost(async () => claudeRecord({ trustedHash: 'd'.repeat(64) }))
    changed.release()
    const spans = claudeSpanTrust(changed.host, createSilentLogger(), 'uid-mark', root)
    expect(spans.pluginId).toBe('uid-mark')
    expect(await spans.verify(new AbortController().signal)).toBe(false)
    expect(changed.host.load).toHaveBeenCalledWith('uid-mark')
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(spans.verify(controller.signal)).rejects.toThrow('stopped')
  })
})
