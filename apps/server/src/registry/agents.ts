// Agent types of plugins (Phase 10, plugin API 1.4.0, ADR-045; PLUGINS.md 6 "Declarative agents" and 9 "Agents and
// skills"): `Registry.agents`. Owner: W10.7 (C30 landed the empty registry).
//
// Registered through the manifest (`contributes.agents`, `registerDeclaredContributions`) and `ctx.agents.register`;
// validated by `validateAgentDefinition` (the name pattern, the reserved builtin names `explore` / `general` and the
// alias `general-purpose`, the description, `instructions` <= 64 KiB, tool names, the model ref or `inherit`). A name
// another plugin registered throws `conflict` (first wins). The customization catalog lists them as `source: 'plugin'`
// entries (ADR-044) and drops its caches on their `agent` changes.
import type { AgentDefinition } from '@harness-forge/plugin-sdk'
import type { DefinitionRegistry, DefinitionRegistryCore } from './definitions.ts'
import type { AgentRegistry } from './types.ts'
import { createDefinitionRegistry } from './definitions.ts'
import { validateAgentDefinition } from './validate.ts'

export type { DefinitionRegistryCore } from './definitions.ts'
export { kindListener } from './definitions.ts'

/** `AgentRegistry` plus the host-only `removeOwner`. */
export type PluginAgentRegistry = AgentRegistry & Pick<DefinitionRegistry<AgentDefinition>, 'removeOwner'>

export function createAgentRegistry(core: DefinitionRegistryCore): PluginAgentRegistry {
  return createDefinitionRegistry<AgentDefinition>(core, { kind: 'agent', label: 'agent', validate: (definition, pluginId) => validateAgentDefinition(definition, pluginId) })
}
