// Pure helpers of the project MCP manager (Phase 11, ADR-050; W11.4): the variables a server is missing, the variable
// list of `GET /projects/:id/mcp` and the expansion of a server's `${VAR}` references from the stored values only (the
// shared `serverVariables` / `expandVariables`; the server environment is never read).
import type { McpJsonRemoteServer, McpJsonStdioServer, ProjectMcpVariable } from '@harness-forge/shared'
import type { ProjectMcpServerItem } from '../services/project-config/types.ts'
import { expandVariables, isAllowedMcpUrl, LIMITS, MCP_VARIABLE_NAME_PATTERN, serverVariables } from '@harness-forge/shared'

type ProjectTransport = McpJsonStdioServer | McpJsonRemoteServer

/** A transport with every `${VAR}` reference expanded. */
export type ResolvedProjectTransport
  = | { readonly type: 'stdio', readonly command: string, readonly args: string[], readonly env: Record<string, string> }
    | { readonly type: 'http' | 'sse', readonly url: string, readonly headers: Record<string, string> }

export type ExpandTransportResult
  = | { readonly ok: true, readonly transport: ResolvedProjectTransport }
    | { readonly ok: false, readonly reason: 'missing', readonly missing: readonly string[] }
    | { readonly ok: false, readonly reason: 'invalid-url' }

/** The variable names a server references without a stored value and without a default, in first-use order. */
export function missingVariables(transport: ProjectTransport, stored: ReadonlySet<string>): string[] {
  return serverVariables(transport)
    .filter(ref => ref.defaultValue === null && !stored.has(ref.name))
    .map(ref => ref.name)
}

/** The variable names a server references (with or without a default), in first-use order. */
export function referencedVariables(transport: ProjectTransport): string[] {
  return serverVariables(transport).map(ref => ref.name)
}

/**
 * The variables of `GET /projects/:id/mcp`: every name the servers reference (first-use order over the servers in file
 * order; `hint` = the `:-default` of the first server that references it, `usedBy` = the referencing server ids),
 * followed by the stored names no server references (sorted; `usedBy: []`, so they can be removed). At most
 * `LIMITS.projectMcpVariablesMax`; values are never part of it.
 */
export function projectMcpVariables(items: readonly ProjectMcpServerItem[], stored: ReadonlySet<string>): ProjectMcpVariable[] {
  const byName = new Map<string, { hint: string | null, usedBy: string[] }>()
  for (const item of items) {
    for (const ref of serverVariables(item.server.transport)) {
      let entry = byName.get(ref.name)
      if (entry === undefined) {
        entry = { hint: ref.defaultValue === null ? null : ref.defaultValue.slice(0, LIMITS.projectMcpVariableValueMaxChars), usedBy: [] }
        byName.set(ref.name, entry)
      }
      if (!entry.usedBy.includes(item.server.id) && entry.usedBy.length < LIMITS.projectMcpServersMax)
        entry.usedBy.push(item.server.id)
    }
  }
  const variables: ProjectMcpVariable[] = [...byName].map(([name, entry]) => ({ name, set: stored.has(name), hint: entry.hint, usedBy: entry.usedBy }))
  const unused = [...stored].filter(name => !byName.has(name) && MCP_VARIABLE_NAME_PATTERN.test(name)).sort()
  for (const name of unused)
    variables.push({ name, set: true, hint: null, usedBy: [] })
  return variables.slice(0, LIMITS.projectMcpVariablesMax)
}

/**
 * Expands every reference of a transport (command, args and env values of stdio; URL and header values of http / sse)
 * from `values` only. A reference without a value and without a default is `missing`; an expanded URL that is not an
 * absolute http(s) URL is `invalid-url`.
 */
export function expandTransport(transport: ProjectTransport, values: Readonly<Record<string, string>>): ExpandTransportResult {
  const missing = new Set<string>()
  const expand = (template: string): string => {
    const result = expandVariables(template, values)
    if (result.ok)
      return result.value
    for (const name of result.missing)
      missing.add(name)
    return ''
  }
  const expandMap = (map: Readonly<Record<string, string>>): Record<string, string> => {
    const out: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [key, value] of Object.entries(map))
      out[key] = expand(value)
    return { ...out }
  }
  let resolved: ResolvedProjectTransport
  if (transport.type === 'stdio') {
    resolved = { type: 'stdio', command: expand(transport.command), args: transport.args.map(expand), env: expandMap(transport.env) }
  }
  else {
    resolved = { type: transport.type, url: expand(transport.url), headers: expandMap(transport.headers) }
  }
  if (missing.size > 0)
    return { ok: false, reason: 'missing', missing: [...missing] }
  if (resolved.type !== 'stdio' && !isAllowedMcpUrl(resolved.url))
    return { ok: false, reason: 'invalid-url' }
  return { ok: true, transport: resolved }
}
