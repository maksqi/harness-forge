// The trust pin of a Claude Code plugin outside its load (v1.8.1 maintenance, ADR-053; ARCHITECTURE.md 6.33 "Trust"):
// `verifyClaudePluginTree(record, root)` re-hashes the whole tree right before one of the plugin's processes starts (the
// hook service calls it before every command hook spawn), and `readClaudePluginHooks(id, dir, record)` reads the hooks
// a plugin that waits for trust declares (`GET /hooks` lists them `pending`).
//
// Verify: only a `claude` row is checked (`checked: false` for other formats and for a missing row: a harness plugin's
// pin covers its `plugin.json`, which its registration already holds in memory). The folder must still be the canonical
// folder the plugin loaded from (`realpath(root) === root`). A linked folder (`source: 'link'`) passes while its pin is
// its path pin (`pathPin`, the rule of the host's `isPinned`), else it is hashed with the linked-folder rules; any other
// folder is scanned (a link, a special file or a cap fails) and hashed with the overlay of its marketplace origin, and
// the hash must equal the pin. The file digests are cached by path, size, times, inode and device (`tree-hash.ts`), so
// an unchanged tree costs a `readdir` per folder and an `lstat`, `open` and `fstat` per file. Every failure is `ok:
// false` (fail closed: the caller starts nothing). Contents are never read for anything but their digest, never logged.
//
// The guard (`createClaudeTrustGuard(host, logger)`): what every surface that starts a Claude Code plugin's process uses
// right before the spawn (the hook service before a command hook, the MCP manager before a stdio server connects or
// reconnects, the `!` span runner through `claudeSpanTrust`): `verify(pluginId, root)` reads the row and checks the tree
// (concurrent checks of one plugin and folder share one hash; any failure is false), `changed(pluginId)` loads a changed
// plugin again (`PluginHost.load`, once at a time per plugin), which leaves it `untrusted` until the user trusts it
// again (its registrations go with the old load; `plugin.changed`), and `stop()` waits for both.
import type { HooksConfig } from '@harness-forge/plugin-sdk'
import type { Logger } from '../../logger.ts'
import type { ClaudeEntryOverlay, PluginHost, PluginRecord } from '../types.ts'
import { realpath } from 'node:fs/promises'
import { pathPin } from '../loader.ts'
import { readClaudePluginDirectory } from './reader.ts'
import { hashPluginTree, scanPluginTree } from './tree-hash.ts'

/** What the check reads of a `plugins` row. */
export type ClaudeTreeRecord = Pick<PluginRecord, 'format' | 'source' | 'trustedHash' | 'origin'>

/**
 * Why a tree no longer matches its pin: no pin (`unpinned`), the folder is no longer the canonical folder it loaded from
 * (`moved`), a file, a mode, a link, a special file or the overlay changed (`changed`), a file could not be hashed
 * (`unreadable`).
 */
export type ClaudeTreeMismatch = 'unpinned' | 'moved' | 'changed' | 'unreadable'

/** The answer of `verifyClaudePluginTree`; `checked: false` = not a Claude Code plugin row (nothing to check). */
export type ClaudeTreeVerdict
  = | { readonly ok: true, readonly checked: boolean }
    | { readonly ok: false, readonly reason: ClaudeTreeMismatch }

/**
 * The entry overlay a row's tree hash includes: a marketplace install's, or the server-only `overlay` origin of a
 * re-imported marketplace plugin; null for every other origin.
 */
export function claudeOverlayOf(record: Pick<PluginRecord, 'origin'>): ClaudeEntryOverlay | null {
  return record.origin?.kind === 'marketplace' || record.origin?.kind === 'overlay' ? record.origin.overlay ?? null : null
}

/**
 * Re-checks the whole-tree pin of a loaded Claude Code plugin (see the module comment). `root` is the canonical folder
 * the plugin loaded from (`RegisteredHookCommands.root`). Never throws for the tree; rejects only when `signal` aborts.
 */
export async function verifyClaudePluginTree(record: ClaudeTreeRecord | null, root: string, signal?: AbortSignal): Promise<ClaudeTreeVerdict> {
  if (record === null || record.format !== 'claude')
    return { ok: true, checked: false }
  const pin = record.trustedHash
  if (pin === null || pin === '')
    return { ok: false, reason: 'unpinned' }
  signal?.throwIfAborted()
  let canonical: string
  try {
    canonical = await realpath(root)
  }
  catch {
    signal?.throwIfAborted()
    return { ok: false, reason: 'moved' }
  }
  if (canonical !== root)
    return { ok: false, reason: 'moved' }
  const linked = record.source === 'link'
  if (linked && pin === pathPin(root))
    return { ok: true, checked: true }
  const tree = await scanPluginTree(root, { linked, ...(signal === undefined ? {} : { signal }) })
  if (tree.problem !== null)
    return { ok: false, reason: 'changed' }
  let hash: string
  try {
    hash = await hashPluginTree(tree, claudeOverlayOf(record), signal)
  }
  catch {
    signal?.throwIfAborted()
    return { ok: false, reason: 'unreadable' }
  }
  return hash === pin ? { ok: true, checked: true } : { ok: false, reason: 'changed' }
}

/**
 * The merged hooks object a Claude Code plugin folder declares, read as the host reads the plugin (its id, the overlay
 * of its marketplace origin, the linked-folder rules): every handler as written in its files, nothing substituted (a
 * `${user_config.KEY}` stays a reference; a shell-form handler using one is refused by the shared reader). Null when the
 * folder does not read as that plugin (the plugin would not load). Never throws; rejects only when `signal` aborts.
 */
export async function readClaudePluginHooks(id: string, dir: string, record: Pick<PluginRecord, 'source' | 'origin'> | null, signal?: AbortSignal): Promise<HooksConfig | null> {
  const overlay = record === null ? null : claudeOverlayOf(record)
  const read = await readClaudePluginDirectory(dir, {
    expectedId: id,
    nameHint: id,
    ...(overlay === null ? {} : { overlay }),
    linked: record?.source === 'link',
    ...(signal === undefined ? {} : { signal }),
  })
  if (read.claude === null || read.directory.problem !== null)
    return null
  return read.claude.hooks.config
}

// ---------- the guard ----------

/** What the guard needs of the plugin host. */
export type ClaudeTrustHost = Pick<PluginHost, 'record' | 'load'>

/** The verify-before-spawn of Claude Code plugin processes (see the module comment). */
export interface ClaudeTrustGuard {
  /**
   * The plugin may still run files from `root` (a Claude Code row: its tree still hashes to its pin; any other format or
   * a missing row: true). Resolves false on any failure; rejects only when `signal` aborts.
   */
  readonly verify: (pluginId: string, root: string, signal?: AbortSignal) => Promise<boolean>
  /** The plugin's files changed after it was trusted: loads it again (once at a time per plugin). Never throws. */
  readonly changed: (pluginId: string) => void
  /** Waits for the checks and loads in flight; no load starts afterwards. Never rejects. */
  readonly stop: () => Promise<void>
}

/** Settles when `promise` does, or rejects with `signal`'s reason once it aborts. */
function raced<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined)
    return promise
  if (signal.aborted)
    return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export function createClaudeTrustGuard(host: ClaudeTrustHost, logger: Logger): ClaudeTrustGuard {
  const stopController = new AbortController()
  const checks = new Map<string, Promise<boolean>>()
  const loading = new Map<string, Promise<void>>()

  async function check(pluginId: string, root: string): Promise<boolean> {
    try {
      const verdict = await verifyClaudePluginTree(await host.record(pluginId), root, stopController.signal)
      if (!verdict.ok)
        logger.info('a plugin\'s files changed after it was trusted; its process does not start', { pluginId, reason: verdict.reason })
      return verdict.ok
    }
    catch (error) {
      if (!stopController.signal.aborted)
        logger.warn('the trust of a plugin could not be checked; its process does not start', { pluginId, err: error })
      return false
    }
  }

  return {
    verify: (pluginId, root, signal) => {
      if (stopController.signal.aborted)
        return Promise.resolve(false)
      const key = `${pluginId}\0${root}`
      let shared = checks.get(key)
      if (shared === undefined) {
        const started = check(pluginId, root)
        shared = started
        checks.set(key, started)
        void started.finally(() => {
          if (checks.get(key) === started)
            checks.delete(key)
        })
      }
      return raced(shared, signal)
    },
    changed: (pluginId) => {
      if (stopController.signal.aborted || loading.has(pluginId))
        return
      const load = (async () => {
        try {
          const detail = await host.load(pluginId)
          logger.info('a plugin whose files changed after it was trusted was loaded again', { pluginId, state: detail.state })
        }
        catch (error) {
          logger.warn('a plugin whose files changed could not be loaded again', { pluginId, err: error })
        }
      })()
      loading.set(pluginId, load)
      void load.finally(() => loading.delete(pluginId))
    },
    stop: async () => {
      stopController.abort(new DOMException('The trust guard stopped.', 'AbortError'))
      await Promise.allSettled([...checks.values(), ...loading.values()])
    },
  }
}

/** The trust check of one plugin's `!` spans (`ExpandCommandPlanInput.pluginTrust`, `chat/inline/`). */
export interface PluginSpanTrust {
  readonly pluginId: string
  /** The plugin may still run its spans (its tree still has its pin); false = refuse them. Rejects only on abort. */
  readonly verify: (signal: AbortSignal) => Promise<boolean>
}

/**
 * The span trust of a Claude Code plugin command: `guard.verify` for the plugin and its folder; a mismatch reports the
 * plugin (`guard.changed`). A guard of its own when none is given.
 */
export function claudeSpanTrust(host: ClaudeTrustHost, logger: Logger, pluginId: string, root: string, guard: ClaudeTrustGuard = createClaudeTrustGuard(host, logger)): PluginSpanTrust {
  return {
    pluginId,
    verify: async (signal) => {
      const ok = await guard.verify(pluginId, root, signal)
      if (!ok)
        guard.changed(pluginId)
      return ok
    },
  }
}
