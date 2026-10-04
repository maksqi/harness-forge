// The builtin agent types of the catalog (Phase 10, ADR-044 / ADR-045; ARCHITECTURE.md 6.25): `explore` and
// `general`, the `source: 'builtin'` agent entries of `GET /customizations` (always active, listed first in the "Agent
// types" block of the instructions). Their names are reserved (`isReservedAgentName`), and `general-purpose` (Claude
// Code's name) is an alias of `general`. The child runner keeps their behavior (ADR-043): `explore` gets the read-only
// tools only, `general` every tool that runs without approval in the parent's mode.
//
// P10-0b (C32): FROZEN after Gate P10-0b with the `core-agent` manifest. The descriptions are what the model and the
// Customize page read (at most `LIMITS.listedDescriptionMaxChars` characters, so the block never cuts them).
import type { BuiltinAgentType } from '@harness-forge/shared'
import { AGENT_TYPE_ALIASES } from '@harness-forge/shared'

/** One builtin agent type. */
export interface BuiltinAgentDefinition {
  /** The type name (`task.type`). */
  readonly name: BuiltinAgentType
  /** One or two sentences: what the agent does and when to pick it. */
  readonly description: string
  /** True: the child gets only the read-only tools (`explore`); false: the tools that run without approval. */
  readonly readOnly: boolean
}

/** The builtin agent types in listing order (`BUILTIN_AGENT_TYPES`). */
export const BUILTIN_AGENT_DEFINITIONS: readonly BuiltinAgentDefinition[] = Object.freeze([
  Object.freeze({
    name: 'explore',
    description: 'Searches and reads the project with read-only tools and reports what it found. Use it for broad searches and questions about the code.',
    readOnly: true,
  }),
  Object.freeze({
    name: 'general',
    description: 'A general-purpose agent with every tool that runs without approval in the current permission mode. Use it for independent sub-tasks that also change files or run commands.',
    readOnly: false,
  }),
] satisfies BuiltinAgentDefinition[])

/** The builtin agent of `name` (the alias `general-purpose` included), or null. */
export function builtinAgentDefinition(name: string): BuiltinAgentDefinition | null {
  const resolved = Object.hasOwn(AGENT_TYPE_ALIASES, name) ? AGENT_TYPE_ALIASES[name] : name
  return BUILTIN_AGENT_DEFINITIONS.find(definition => definition.name === resolved) ?? null
}
