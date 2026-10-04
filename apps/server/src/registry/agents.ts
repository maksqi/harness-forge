// Agent types of plugins (Phase 10, plugin API 1.4.0, ADR-045): `Registry.agents`. C30 lands the registry empty
// (nothing is registered, `register` answers `not_implemented`, `onChange` is subscribable); W10.7 implements the
// registration (manifest `contributes.agents`, `ctx.agents.register`) and its validation behind the same interface.
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { AgentRegistry, RegistryChange } from './types.ts'
import { notImplementedError } from '../not-implemented.ts'

/** What a definition registry needs from the registry core. */
export interface DefinitionRegistryCore {
  /** The registry's change listeners (`Registry.onChange`). */
  readonly onChange: (listener: (change: RegistryChange) => void) => Disposable
}

/** `listener` for the changes of one kind only. */
export function kindListener(kind: RegistryChange['kind'], listener: (change: RegistryChange) => void): (change: RegistryChange) => void {
  return (change) => {
    if (change.kind === kind)
      listener(change)
  }
}

export function createAgentRegistry(core: DefinitionRegistryCore): AgentRegistry {
  return {
    register: () => {
      throw notImplementedError('Plugin agents')
    },
    get: () => undefined,
    list: () => [],
    owner: () => undefined,
    onChange: listener => core.onChange(kindListener('agent', listener)),
  }
}
