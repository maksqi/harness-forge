// The builtin plugins (PLUGINS.md 1 and 11), statically imported, in load order: `core-providers`, `core-tools`,
// `core-commands`, `core-mcp`, then `mock` only with `HF_MOCK_PROVIDER=1`. FROZEN after Phase 0. Each module
// default-exports its `definePlugin(...)` module and exports its `manifest` (builtins have no `plugin.json`).
import type { BuiltinPlugin } from '../plugins/types.ts'
import coreCommands, { manifest as coreCommandsManifest } from './core-commands/index.ts'
import coreMcp, { manifest as coreMcpManifest } from './core-mcp/index.ts'
import coreProviders, { manifest as coreProvidersManifest } from './core-providers/index.ts'
import coreTools, { manifest as coreToolsManifest } from './core-tools/index.ts'
import mock, { manifest as mockManifest } from './mock/index.ts'

/** Every builtin, in load order (`BUILTIN_PLUGIN_IDS` of `@harness-forge/shared`). */
export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = Object.freeze([
  { id: 'core-providers', manifest: coreProvidersManifest, module: coreProviders },
  { id: 'core-tools', manifest: coreToolsManifest, module: coreTools },
  { id: 'core-commands', manifest: coreCommandsManifest, module: coreCommands },
  { id: 'core-mcp', manifest: coreMcpManifest, module: coreMcp },
  { id: 'mock', manifest: mockManifest, module: mock },
])

/** The builtins to load: `mock` only when `HF_MOCK_PROVIDER=1` (`env.mockProvider`). */
export function getBuiltinPlugins(options: { mockProvider: boolean }): readonly BuiltinPlugin[] {
  return options.mockProvider ? BUILTIN_PLUGINS : BUILTIN_PLUGINS.filter(plugin => plugin.id !== 'mock')
}
