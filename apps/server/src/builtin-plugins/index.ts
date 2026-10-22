// The builtin plugins (PLUGINS.md 1 and 11), statically imported, in load order: `core-providers`, `core-tools`,
// `core-search` (Phase 14, ADR-063), `core-commands`, `core-mcp`, `core-workspace` (Phase 7, ADR-032), `core-agent`
// (Phase 9, ADR-041 / ADR-043), then `mock` only with `HF_MOCK_PROVIDER=1`. FROZEN after Phase 0 (opened for C14 in
// P7-0b, for C27 in P9-0b, for C38 in P11-0b, for C45 in P12-0b and for C50 in P14-0b: the list is unchanged in Phases
// 11 and 12; the builtin output styles live in `core-agent/styles.ts`, the mock models `mock:hooks` in `mock/hooks.ts`
// and `mock:prompt-hook` in `mock/prompt-hook.ts`; Phase 14 adds `core-search` after `core-tools`). Each module
// default-exports its `definePlugin(...)` module and exports its `manifest` (builtins have no `plugin.json`), except
// `core-search`, whose module is built by `createCoreSearchPlugin({ safeFetch })` (its backend requests go through the
// plugin-source fetch, with the test-only remote when `HF_TEST_REMOTE_URL` is honored). No builtin registers an output
// style or a command hook through `ctx`.
import type { BuiltinPluginId } from '@harness-forge/shared'
import type { Env } from '../env.ts'
import type { BuiltinPlugin } from '../plugins/types.ts'
import { createPluginSourceFetch } from '../security/ssrf.ts'
import coreAgent, { manifest as coreAgentManifest } from './core-agent/index.ts'
import coreCommands, { manifest as coreCommandsManifest } from './core-commands/index.ts'
import coreMcp, { manifest as coreMcpManifest } from './core-mcp/index.ts'
import coreProviders, { manifest as coreProvidersManifest } from './core-providers/index.ts'
import { CORE_SEARCH_PLUGIN_ID, manifest as coreSearchManifest, createCoreSearchPlugin } from './core-search/index.ts'
import coreTools, { manifest as coreToolsManifest } from './core-tools/index.ts'
import coreWorkspace, { manifest as coreWorkspaceManifest } from './core-workspace/index.ts'
import mock, { manifest as mockManifest } from './mock/index.ts'

/**
 * The id of `core-search` as a `BuiltinPluginId`. Local adapter of CCR C50-1: `BUILTIN_PLUGIN_IDS` of
 * `@harness-forge/shared` (frozen) does not list `core-search` yet; once it does (after `core-tools`), the cast is a no-op.
 */
const CORE_SEARCH_ID = CORE_SEARCH_PLUGIN_ID as string as BuiltinPluginId

/** Options of `getBuiltinPlugins` (`env` satisfies them; `testRemoteUrl` absent = the real hosts). */
export type BuiltinPluginsOptions = Pick<Env, 'mockProvider'> & Partial<Pick<Env, 'testRemoteUrl'>>

/**
 * The `core-search` builtin whose backend requests go through `createPluginSourceFetch({ testRemoteUrl })` (https only;
 * every request rerouted to the loopback fake remote when `testRemoteUrl` is set, i.e. `HF_TEST_REMOTE_URL` honored
 * with `HF_MOCK_PROVIDER=1`).
 */
export function coreSearchBuiltin(options: Partial<Pick<Env, 'testRemoteUrl'>> = {}): BuiltinPlugin {
  const safeFetch = createPluginSourceFetch({ testRemoteUrl: options.testRemoteUrl ?? null })
  return { id: CORE_SEARCH_ID, manifest: coreSearchManifest, module: createCoreSearchPlugin({ safeFetch }) }
}

/**
 * Every builtin, in load order (`BUILTIN_PLUGIN_IDS` of `@harness-forge/shared` plus `core-search` after `core-tools`,
 * CCR C50-1); `core-search` with the plugin-source fetch of the real hosts.
 */
export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = Object.freeze([
  { id: 'core-providers', manifest: coreProvidersManifest, module: coreProviders },
  { id: 'core-tools', manifest: coreToolsManifest, module: coreTools },
  coreSearchBuiltin(),
  { id: 'core-commands', manifest: coreCommandsManifest, module: coreCommands },
  { id: 'core-mcp', manifest: coreMcpManifest, module: coreMcp },
  { id: 'core-workspace', manifest: coreWorkspaceManifest, module: coreWorkspace },
  { id: 'core-agent', manifest: coreAgentManifest, module: coreAgent },
  { id: 'mock', manifest: mockManifest, module: mock },
])

/**
 * The builtins to load (`main.ts` and `createTestApp()` pass `env`): `mock` only when `HF_MOCK_PROVIDER=1`
 * (`mockProvider`); `core-search` built with the test remote when `testRemoteUrl` is set (Phase 14).
 */
export function getBuiltinPlugins(options: BuiltinPluginsOptions): readonly BuiltinPlugin[] {
  const remote = options.testRemoteUrl ?? null
  const plugins = remote === null
    ? BUILTIN_PLUGINS
    : BUILTIN_PLUGINS.map(plugin => (plugin.id === CORE_SEARCH_ID ? coreSearchBuiltin({ testRemoteUrl: remote }) : plugin))
  return options.mockProvider ? plugins : plugins.filter(plugin => plugin.id !== 'mock')
}
