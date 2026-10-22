// The pending OAuth sign-ins of MCP servers (Phase 14, ADR-059; W14.1-T3; ARCHITECTURE.md 6.39). Memory only, keyed by
// the random `state` of the flow:
// - one flow per server (`key`): a new start replaces the old flow;
// - at most `LIMITS.mcpOAuthFlowsMax` (20): the oldest flow is dropped;
// - each flow lives `LIMITS.mcpOAuthFlowMs` (10 minutes): an expired flow is gone (its timer drops it, and `take`
//   refuses it even before the timer ran);
// - single use: `take` removes the flow, so a replayed callback finds nothing (409 `stale` at the service).
// The service drops flows on `key.rotated`, on the deletion of their server or project and at shutdown (`clear`). The
// timers are `unref()`-ed and cleared with their flow. A flow holds the code verifier, the client and the
// authorization-server pin: never logged, never answered.
import { LIMITS } from '@harness-forge/shared'

/** What the store needs of a flow. */
export interface FlowEntry {
  /** The random `state` of the authorization request (the map key). */
  readonly state: string
  /** The server the flow is for (one flow per key). */
  readonly key: string
  /** Epoch ms after which the flow is gone. */
  readonly expiresAt: number
}

export interface FlowStoreOptions {
  /** Default `LIMITS.mcpOAuthFlowsMax`. */
  readonly max?: number
  /** Clock (epoch ms; default `Date.now`). */
  readonly now?: () => number
  /** Called after a flow left the store for any reason (taken, replaced, evicted, expired, dropped, cleared). */
  readonly onRemoved?: () => void
}

export interface FlowStore<T extends FlowEntry> {
  /** Adds a flow: replaces the flow of the same key, then drops the oldest flows above the cap. */
  readonly add: (flow: T) => void
  /** Removes and answers the flow of `state` (single use); null when unknown, used or expired. */
  readonly take: (state: string) => T | null
  /** The pending flow of a server (not removed), or null. */
  readonly byKey: (key: string) => T | null
  /** Drops the flow of a server; true when there was one. */
  readonly dropKey: (key: string) => boolean
  /** Drops every flow `predicate` selects; answers how many. */
  readonly dropWhere: (predicate: (flow: T) => boolean) => number
  /** The pending flows (oldest first; expired ones are left out). */
  readonly list: () => T[]
  /** Drops every flow and timer. */
  readonly clear: () => void
  readonly size: () => number
}

export function createFlowStore<T extends FlowEntry>(options: FlowStoreOptions = {}): FlowStore<T> {
  const max = Math.max(1, options.max ?? LIMITS.mcpOAuthFlowsMax)
  const now = options.now ?? Date.now
  /** By state, in insertion order (the oldest first). */
  const flows = new Map<string, T>()
  const byServer = new Map<string, string>()
  const timers = new Map<string, NodeJS.Timeout>()

  function remove(state: string): T | null {
    const flow = flows.get(state)
    if (flow === undefined)
      return null
    flows.delete(state)
    if (byServer.get(flow.key) === state)
      byServer.delete(flow.key)
    const timer = timers.get(state)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(state)
    }
    options.onRemoved?.()
    return flow
  }

  function expired(flow: T): boolean {
    return now() >= flow.expiresAt
  }

  return {
    add: (flow) => {
      const previous = byServer.get(flow.key)
      if (previous !== undefined)
        remove(previous)
      remove(flow.state)
      flows.set(flow.state, flow)
      byServer.set(flow.key, flow.state)
      const timer = setTimeout(() => {
        timers.delete(flow.state)
        if (flows.get(flow.state) === flow)
          remove(flow.state)
      }, Math.max(0, flow.expiresAt - now()))
      timer.unref?.()
      timers.set(flow.state, timer)
      while (flows.size > max) {
        const oldest = flows.keys().next().value
        if (oldest === undefined)
          break
        remove(oldest)
      }
    },
    take: (state) => {
      const flow = remove(state)
      return flow === null || expired(flow) ? null : flow
    },
    byKey: (key) => {
      const state = byServer.get(key)
      const flow = state === undefined ? undefined : flows.get(state)
      return flow === undefined || expired(flow) ? null : flow
    },
    dropKey: (key) => {
      const state = byServer.get(key)
      return state !== undefined && remove(state) !== null
    },
    dropWhere: (predicate) => {
      let count = 0
      for (const flow of [...flows.values()]) {
        if (predicate(flow) && remove(flow.state) !== null)
          count += 1
      }
      return count
    },
    list: () => [...flows.values()].filter(flow => !expired(flow)),
    clear: () => {
      for (const state of [...flows.keys()])
        remove(state)
    },
    size: () => flows.size,
  }
}
