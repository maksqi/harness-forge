// Link between the builtin `core-mcp` and the MCP manager of the same app. Builtin modules are static imports without
// access to `deps`, so the manager publishes a bridge keyed by the `core-mcp` plugin data directory
// (`<HF_DATA_DIR>/plugins/.data/core-mcp`, which is `ctx.plugin.dataDir` of that plugin). `core-mcp`'s `setup(ctx)`
// attaches its context: the manager declares the stored servers through `ctx.mcp.register`, so they are contributions
// of `core-mcp` and are removed with it when it is disabled, reloaded or the server stops.
import type { Disposable, PluginContext } from '@harness-forge/plugin-sdk'
import { resolve } from 'node:path'

export interface CoreMcpBridge {
  /** Declares the stored MCP servers through `ctx` and keeps it for later changes until `ctx.signal` aborts. */
  readonly attach: (ctx: PluginContext) => Promise<void>
}

const bridges = new Map<string, CoreMcpBridge>()

/** Publishes the bridge of one app; disposing removes it (only if it is still the published one). */
export function registerCoreMcpBridge(coreMcpDataDir: string, bridge: CoreMcpBridge): Disposable {
  const key = resolve(coreMcpDataDir)
  bridges.set(key, bridge)
  return {
    dispose: () => {
      if (bridges.get(key) === bridge)
        bridges.delete(key)
    },
  }
}

/** The bridge of the app whose `core-mcp` data directory is `coreMcpDataDir` (`ctx.plugin.dataDir`). */
export function coreMcpBridgeFor(coreMcpDataDir: string): CoreMcpBridge | undefined {
  return bridges.get(resolve(coreMcpDataDir))
}
