// MCP resource routes (API.md 5.39, ADR-061). Owner: W14.2. Thin: validate, read the MCP managers' resource members
// (`mcp/resources.ts` behind them), map to the response.
//
// - `GET /mcp/resources?projectId&q&limit`: the resources of the connected global servers and, with `projectId`, of
//   that project's connected servers (a project server shadows a global one with the same id; resource templates are
//   not listed); ranked by `q` against the name, the title and the URI with the shared `scorePath` (the best of the
//   three; ties: the shorter name, the server, the URI; the empty query keeps the servers' order); answers `{ items,
//   truncated, unavailable }` (`unavailable`: the servers of the scope that are not connected, with their status;
//   `truncated`: more matched than `limit`, or a server listed more than `LIMITS.mcpResourcesMax`). `mention` is
//   `formatResourceMention(serverId, uri)` (the URI scheme in lower case; a resource whose URI cannot be a mention is
//   left out). `404` unknown project. Never starts a sign-in and never waits for a server that is not connected (the
//   project's approved servers start as for a run and are listed by a later query).
// - `POST /mcp/resources/attach` (`201`, body `{ serverId, uri, projectId? }`): the server is the project's server of
//   that id when the project has one (approved; `shadowed`, listed or not connected), else the global server; reads the
//   resource once and stores it through the upload path (`files.upload`; `mcpResourceUpload`: at most
//   `LIMITS.mcpResourceReadBytes`, else `413` — a listed size above it is refused before the read; text as `text/plain`
//   or the server's `text/*`, several text contents joined; binary only images and PDF, else `400`); answers the
//   upload's `FileRef`. `404` unknown server, project or resource (a pending project server is not the project's: the
//   global server of that id answers), `409` `needs-auth` when the server must be signed in first, `502`
//   `provider_unreachable` when it is not connected (or disabled).
// - Resource contents and URIs are untrusted and never logged at `info` (a `debug` line carries the server id, the size
//   and the duration).
import type { McpResourceEntry, McpResourceList } from '@harness-forge/shared'
import type { McpListing, McpResourceInfo, ProjectMcpListing } from '../../mcp/types.ts'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, formatResourceMention, LIMITS, mcpResourceAttachBodySchema, mcpResourceQuerySchema, scorePath } from '@harness-forge/shared'
import { Hono } from 'hono'
import { mcpResourceUpload, resourceTooLarge } from '../../mcp/resources.ts'
import { validate } from '../validate.ts'

/** Characters of a server name in an entry (`mcpResourceEntrySchema`). */
const SERVER_NAME_MAX_CHARS = 256

/** The resource listings of a scope: the global one (without the shadowed servers) and the project's. */
interface ScopeListings {
  readonly global: McpListing<McpResourceInfo>
  readonly project: ProjectMcpListing<McpResourceInfo> | null
}

/** A ranked candidate of the list. */
interface Candidate {
  readonly entry: McpResourceEntry
  readonly index: number
  readonly score: number
}

/** The URI with its scheme in lower case (schemes are case-insensitive; mentions use the canonical form). */
function canonicalScheme(uri: string): string {
  const colon = uri.indexOf(':')
  return colon <= 0 ? uri : `${uri.slice(0, colon).toLowerCase()}${uri.slice(colon)}`
}

function capped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** A listed resource as an entry of the answer, or null when its URI cannot be a mention. */
export function resourceEntry(info: McpResourceInfo, scope: 'global' | 'project'): McpResourceEntry | null {
  const mention = formatResourceMention(info.serverId, canonicalScheme(info.uri))
  if (mention === null)
    return null
  return {
    serverId: info.serverId,
    serverName: capped(info.serverName, SERVER_NAME_MAX_CHARS),
    scope,
    uri: info.uri,
    name: info.name,
    ...(info.title === null ? {} : { title: info.title }),
    ...(info.description === null ? {} : { description: info.description }),
    ...(info.mimeType === null ? {} : { mimeType: info.mimeType }),
    ...(info.size === null ? {} : { size: info.size }),
    mention,
  }
}

/** The best `scorePath` of the query against the entry's name, title and URI, or null when none matches. */
function scoreOf(query: string, entry: McpResourceEntry): number | null {
  let best: number | null = null
  for (const field of [entry.name, entry.title ?? '', entry.uri]) {
    if (field === '')
      continue
    const match = scorePath(query, field)
    if (match !== null && (best === null || match.score > best))
      best = match.score
  }
  return best
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The answer of `GET /mcp/resources` for the listings of a scope (see the module comment): the entries of the global
 * servers the project does not shadow, then the project's, ranked by `query`, at most `limit`.
 */
export function rankResources(listings: ScopeListings, query: string, limit: number): McpResourceList {
  const shadowed = listings.project?.shadowed ?? new Set<string>()
  const entries: McpResourceEntry[] = []
  for (const info of listings.global.items) {
    const entry = shadowed.has(info.serverId) ? null : resourceEntry(info, 'global')
    if (entry !== null)
      entries.push(entry)
  }
  for (const info of listings.project?.items ?? []) {
    const entry = resourceEntry(info, 'project')
    if (entry !== null)
      entries.push(entry)
  }
  const unavailable: McpResourceList['unavailable'] = []
  const named = new Set<string>()
  for (const item of [...listings.global.unavailable.filter(item => !shadowed.has(item.serverId)), ...(listings.project?.unavailable ?? [])]) {
    if (named.has(item.serverId))
      continue
    named.add(item.serverId)
    unavailable.push({ serverId: item.serverId, status: item.status })
  }
  const max = Math.max(0, Math.min(Math.floor(limit), LIMITS.pageLimitMax))
  const q = query.trim()
  let candidates: Candidate[]
  if (q === '') {
    candidates = entries.map((entry, index) => ({ entry, index, score: 0 }))
  }
  else {
    candidates = []
    entries.forEach((entry, index) => {
      const score = scoreOf(q, entry)
      if (score !== null)
        candidates.push({ entry, index, score })
    })
    candidates.sort((left, right) => right.score - left.score
      || left.entry.name.length - right.entry.name.length
      || compareText(left.entry.serverId, right.entry.serverId)
      || compareText(left.entry.uri, right.entry.uri)
      || left.index - right.index)
  }
  const truncated = candidates.length > max || listings.global.truncated || (listings.project?.truncated ?? false)
  return { items: candidates.slice(0, max).map(candidate => candidate.entry), truncated, unavailable }
}

/** True when the project's listing knows a server of that id (approved: listed, not connected or shadowing). */
function projectHas(listing: ProjectMcpListing<McpResourceInfo>, serverId: string): boolean {
  return listing.shadowed.has(serverId)
    || listing.items.some(item => item.serverId === serverId)
    || listing.unavailable.some(item => item.serverId === serverId)
}

export function createMcpResourcesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['mcpResources.list'].path, validate('query', mcpResourceQuerySchema), async (c) => {
    const { projectId, q, limit } = c.req.valid('query')
    const signal = c.req.raw.signal
    // `projectMcp.resources` answers `not_found` for an unknown project (404).
    const project = projectId === undefined ? null : await deps.projectMcp.resources(projectId, { signal, waitMs: 0 })
    const global = await deps.mcp.resources()
    const body: McpResourceList = rankResources({ global, project }, q, limit)
    return c.json(body)
  })

  app.post(apiRoutes['mcpResources.attach'].path, validate('json', mcpResourceAttachBodySchema), async (c) => {
    const { serverId, uri, projectId } = c.req.valid('json')
    const signal = c.req.raw.signal
    const maxBytes = LIMITS.mcpResourceReadBytes
    const startedAt = Date.now()
    const project = projectId === undefined ? null : await deps.projectMcp.resources(projectId, { signal, waitMs: 0 })
    const scopeProject = project !== null && projectId !== undefined && projectHas(project, serverId) ? projectId : null
    const listing = scopeProject !== null && project !== null ? project : await deps.mcp.resources()
    const listed = listing.items.find(item => item.serverId === serverId && item.uri === uri)
    // A size the server declares above the limit is refused before anything is read.
    if (listed !== undefined && listed.size !== null && listed.size > maxBytes)
      throw resourceTooLarge(maxBytes)
    const contents = scopeProject !== null
      ? await deps.projectMcp.readResource(scopeProject, serverId, uri, signal)
      : await deps.mcp.readResource(serverId, uri, signal)
    const upload = mcpResourceUpload(contents, { uri, name: listed?.name ?? null, maxBytes })
    const ref = await deps.files.upload(new File([upload.bytes], upload.name, upload.mime === '' ? {} : { type: upload.mime }))
    c.get('logger').debug('MCP resource attached', { serverId, scope: scopeProject === null ? 'global' : 'project', bytes: ref.size, ms: Date.now() - startedAt })
    return c.json(ref, 201)
  })

  return app
}
