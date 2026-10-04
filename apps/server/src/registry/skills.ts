// Skills of plugins (Phase 10, plugin API 1.4.0, ADR-045): `Registry.skills`. C30 lands the registry empty (nothing is
// registered, `register` answers `not_implemented`, `onChange` is subscribable); W10.7 implements the registration
// (manifest `contributes.skills`, `ctx.skills.register`) and its validation behind the same interface.
import type { DefinitionRegistryCore } from './agents.ts'
import type { SkillRegistry } from './types.ts'
import { notImplementedError } from '../not-implemented.ts'
import { kindListener } from './agents.ts'

export function createSkillRegistry(core: DefinitionRegistryCore): SkillRegistry {
  return {
    register: () => {
      throw notImplementedError('Plugin skills')
    },
    get: () => undefined,
    list: () => [],
    owner: () => undefined,
    onChange: listener => core.onChange(kindListener('skill', listener)),
  }
}
