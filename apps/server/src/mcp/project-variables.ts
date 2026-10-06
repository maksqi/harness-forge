// The stored `.mcp.json` variables of a project (Phase 11, ADR-050; W11.4-T1): encrypted secrets (`deps.secrets`) of the
// scope `project:<projectId>`, one per variable, named `mcp.var.<NAME>`. Values are only ever read here, right before a
// server starts (to expand its `${VAR}` references); the secret store registers every value it reads or writes with
// the redactor. Values never come from `process.env`.
import type { SecretScope } from '../services/secrets/types.ts'
import type { AppDeps } from '../types.ts'
import { HarnessError, LIMITS, MCP_VARIABLE_NAME_PATTERN, PROJECT_ID_PATTERN } from '@harness-forge/shared'
import { like } from 'drizzle-orm'
import { secrets } from '../db/schema.ts'

/** Scope prefix of the project MCP variables (`project:<projectId>`). */
const PROJECT_SCOPE_PREFIX = 'project:'

/** Secret name prefix of a project MCP variable (`mcp.var.<NAME>`). */
export const PROJECT_MCP_VARIABLE_PREFIX = 'mcp.var.'

/** The secret scope of a project's MCP variables. */
export function projectMcpSecretScope(projectId: string): SecretScope {
  return `${PROJECT_SCOPE_PREFIX}${projectId}`
}

/** The secret name of a variable. */
export function projectMcpVariableSecretName(name: string): string {
  return `${PROJECT_MCP_VARIABLE_PREFIX}${name}`
}

/** The variable name of a secret name, or null when it is not a variable. */
export function variableNameOf(secretName: string): string | null {
  if (!secretName.startsWith(PROJECT_MCP_VARIABLE_PREFIX))
    return null
  const name = secretName.slice(PROJECT_MCP_VARIABLE_PREFIX.length)
  return MCP_VARIABLE_NAME_PATTERN.test(name) ? name : null
}

export interface ProjectVariableStore {
  /** The names of the stored variables of a project. */
  readonly names: (projectId: string) => Promise<Set<string>>
  /** The decrypted values of the given names that are stored (each registered with the redactor by the store). */
  readonly values: (projectId: string, names: Iterable<string>) => Promise<Record<string, string>>
  /**
   * Sets (a value) or removes (null) variables; answers the names whose stored value changed. Throws `conflict`
   * (`reason: 'exists'`) when the project would hold more than `LIMITS.projectMcpVariablesMax` variables (nothing is
   * written then). Serialized per project.
   */
  readonly apply: (projectId: string, values: Readonly<Record<string, string | null>>) => Promise<Set<string>>
  /** Deletes every variable of a project (project deletion); answers the count. */
  readonly deleteAll: (projectId: string) => Promise<number>
  /**
   * The ids of the projects that have stored variables: a read of the `secrets.scope` column only (no value is read or
   * decrypted; the store has no scope listing), for the removal of the variables of deleted projects.
   */
  readonly projectIds: () => Promise<string[]>
}

export function createProjectVariableStore(deps: AppDeps): ProjectVariableStore {
  const queues = new Map<string, Promise<unknown>>()

  function serialized<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(projectId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const tail = run.then(() => undefined, () => undefined)
    queues.set(projectId, tail)
    void tail.then(() => {
      if (queues.get(projectId) === tail)
        queues.delete(projectId)
    })
    return run
  }

  async function names(projectId: string): Promise<Set<string>> {
    const result = new Set<string>()
    for (const entry of await deps.secrets.list(projectMcpSecretScope(projectId))) {
      const name = variableNameOf(entry.name)
      if (name !== null)
        result.add(name)
    }
    return result
  }

  async function values(projectId: string, wanted: Iterable<string>): Promise<Record<string, string>> {
    const scope = projectMcpSecretScope(projectId)
    const result: Record<string, string> = Object.create(null) as Record<string, string>
    for (const name of new Set(wanted)) {
      if (!MCP_VARIABLE_NAME_PATTERN.test(name))
        continue
      const value = await deps.secrets.get(scope, projectMcpVariableSecretName(name))
      if (value !== null)
        result[name] = value
    }
    return { ...result }
  }

  return {
    names,
    values,
    apply: (projectId, input) => serialized(projectId, async () => {
      const scope = projectMcpSecretScope(projectId)
      const stored = await names(projectId)
      const next = new Set(stored)
      for (const [name, value] of Object.entries(input)) {
        if (!MCP_VARIABLE_NAME_PATTERN.test(name))
          throw new HarnessError({ code: 'validation_error', message: 'A variable name is not valid.' })
        if (value === null)
          next.delete(name)
        else
          next.add(name)
      }
      if (next.size > LIMITS.projectMcpVariablesMax) {
        throw new HarnessError({
          code: 'conflict',
          message: `A project can store at most ${LIMITS.projectMcpVariablesMax} variables. Remove some first.`,
          details: { reason: 'exists' },
        })
      }
      const changed = new Set<string>()
      for (const [name, value] of Object.entries(input)) {
        const secretName = projectMcpVariableSecretName(name)
        if (value === null) {
          if (await deps.secrets.delete(scope, secretName))
            changed.add(name)
          continue
        }
        const previous = stored.has(name) ? await deps.secrets.get(scope, secretName) : null
        if (previous === value)
          continue
        await deps.secrets.set(scope, secretName, value)
        changed.add(name)
      }
      return changed
    }),
    deleteAll: (projectId) => {
      const scope = projectMcpSecretScope(projectId)
      return serialized(projectId, () => deps.secrets.deleteScope(scope))
    },
    projectIds: async () => {
      const found = await deps.db.selectDistinct({ scope: secrets.scope }).from(secrets).where(like(secrets.scope, `${PROJECT_SCOPE_PREFIX}%`))
      return found.map(row => row.scope.slice(PROJECT_SCOPE_PREFIX.length)).filter(id => PROJECT_ID_PATTERN.test(id)).sort()
    },
  }
}
