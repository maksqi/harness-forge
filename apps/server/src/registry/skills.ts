// Skills of plugins (Phase 10, plugin API 1.4.0, ADR-045; PLUGINS.md 6 "Declarative skills" and 9 "Agents and
// skills"): `Registry.skills`. Owner: W10.7 (C30 landed the empty registry).
//
// Registered through the manifest (`contributes.skills`, `registerDeclaredContributions`) and `ctx.skills.register`;
// validated by `validateSkillDefinition` (the name pattern, the description, `content` <= 64 KiB). A name another plugin
// registered throws `conflict` (first wins). The customization catalog lists them as `source: 'plugin'` entries
// (ADR-044) and drops its caches on their `skill` changes; the `skill` tool loads their `content`.
import type { SkillDefinition } from '@harness-forge/plugin-sdk'
import type { DefinitionRegistry, DefinitionRegistryCore } from './definitions.ts'
import type { SkillRegistry } from './types.ts'
import { createDefinitionRegistry } from './definitions.ts'
import { validateSkillDefinition } from './validate.ts'

/** `SkillRegistry` plus the host-only `removeOwner`. */
export type PluginSkillRegistry = SkillRegistry & Pick<DefinitionRegistry<SkillDefinition>, 'removeOwner'>

export function createSkillRegistry(core: DefinitionRegistryCore): PluginSkillRegistry {
  return createDefinitionRegistry<SkillDefinition>(core, { kind: 'skill', label: 'skill', validate: validateSkillDefinition })
}
