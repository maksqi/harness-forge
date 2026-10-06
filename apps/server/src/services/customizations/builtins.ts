// The builtin entries of the catalog (Phase 10, ADR-044): the agent types `explore` and `general` declared by
// `core-agent` (`builtin-plugins/core-agent/agents.ts`, C32), always active, lowest precedence. Builtin commands
// (`/compact`) come from `GET /commands` (`source: 'harness'`) and are not catalog entries; there are no builtin skills.
// Phase 11 (ADR-051; W11.6): the builtin output styles `default`, `explanatory` and `learning`
// (`builtin-plugins/core-agent/styles.ts`, C38; texts from the shared `BUILTIN_OUTPUT_STYLES`), with their labels and
// `keepCodingInstructions`, in menu order. Their names are reserved, so nothing ever shadows a builtin style.
import type { CustomizationEntry } from '@harness-forge/shared'
import type { LoadedDefinition } from './types.ts'
import { BUILTIN_AGENT_DEFINITIONS, builtinAgentDefinition } from '../../builtin-plugins/core-agent/agents.ts'
import { BUILTIN_STYLE_DEFINITIONS, builtinStyleDefinition } from '../../builtin-plugins/core-agent/styles.ts'

/**
 * The builtin catalog entries (`source: 'builtin'`): the agents in `BUILTIN_AGENT_TYPES` order, then the output styles in
 * `BUILTIN_OUTPUT_STYLE_NAMES` order.
 */
export function builtinCatalogEntries(): CustomizationEntry[] {
  const agents = BUILTIN_AGENT_DEFINITIONS.map((definition): CustomizationEntry => ({
    kind: 'agent',
    name: definition.name,
    description: definition.description,
    source: 'builtin',
    enabled: true,
    state: 'active',
    diagnostics: [],
  }))
  const styles = BUILTIN_STYLE_DEFINITIONS.map((definition): CustomizationEntry => ({
    kind: 'style',
    name: definition.name,
    description: definition.description,
    source: 'builtin',
    label: definition.label,
    keepCodingInstructions: definition.keepCodingInstructions,
    enabled: true,
    state: 'active',
    diagnostics: [],
  }))
  return [...agents, ...styles]
}

/**
 * The body of a builtin entry (`load`): an agent with no tool list, no model and no instructions of its own (the child
 * runner keeps the builtin behavior, ADR-043), or a style with its label, flag and text (`default`: an empty body); null
 * for an entry that is not a builtin agent or style.
 */
export function loadBuiltin(entry: CustomizationEntry): LoadedDefinition | null {
  if (entry.source !== 'builtin')
    return null
  if (entry.kind === 'style') {
    const style = builtinStyleDefinition(entry.name)
    if (style === null)
      return null
    return {
      entry,
      definition: {
        kind: 'style',
        fields: {
          name: style.name,
          label: style.label,
          description: style.description,
          keepCodingInstructions: style.keepCodingInstructions,
          content: style.content,
        },
      },
      diagnostics: [],
    }
  }
  if (entry.kind !== 'agent')
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
