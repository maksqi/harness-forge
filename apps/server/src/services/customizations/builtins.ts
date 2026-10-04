// The builtin entries of the catalog (Phase 10, ADR-044): the agent types `explore` and `general` declared by
// `core-agent` (`builtin-plugins/core-agent/agents.ts`, C32), always active, lowest precedence. Builtin commands
// (`/compact`) come from `GET /commands` (`source: 'harness'`) and are not catalog entries; there are no builtin skills.
import type { CustomizationEntry } from '@harness-forge/shared'
import type { LoadedDefinition } from './types.ts'
import { BUILTIN_AGENT_DEFINITIONS, builtinAgentDefinition } from '../../builtin-plugins/core-agent/agents.ts'

/** The builtin catalog entries (`source: 'builtin'`), in `BUILTIN_AGENT_TYPES` order. */
export function builtinCatalogEntries(): CustomizationEntry[] {
  return BUILTIN_AGENT_DEFINITIONS.map(definition => ({
    kind: 'agent',
    name: definition.name,
    description: definition.description,
    source: 'builtin',
    enabled: true,
    state: 'active',
    diagnostics: [],
  }))
}

/**
 * The body of a builtin entry (`load`): the frontmatter fields with no tool list, no model and no instructions of its
 * own (the child runner keeps the builtin behavior, ADR-043); null for an entry that is not a builtin agent.
 */
export function loadBuiltin(entry: CustomizationEntry): LoadedDefinition | null {
  if (entry.source !== 'builtin' || entry.kind !== 'agent')
    return null
  const definition = builtinAgentDefinition(entry.name)
  if (definition === null || definition.name !== entry.name)
    return null
  return {
    entry,
    definition: {
      kind: 'agent',
      fields: { name: definition.name, description: definition.description, tools: null, model: null, instructions: '' },
    },
    diagnostics: [],
  }
}
