// Test double of `ProjectDefinitionsService` (Phase 12, C43-T9), so the project definition routes and the web contract
// can be tested without project folders:
//
//   const t = await createTestApp({ projectDefinitions: 'fake' })   // or overrides: { projectDefinitions: createFakeProjectDefinitionsService() }
//   const fake = t.deps.projectDefinitions as FakeProjectDefinitionsService
//   fake.files.set(projectDefinitionFileKey(projectId, '.claude/agents/reviewer.md'), '---\nname: reviewer\n…')
//   const file = await fake.read(projectId, '.claude/agents/reviewer.md')        // exists, content, sha256
//   await fake.write(projectId, { path: file.path, expectedSha256: file.sha256, content: '…' })
//
// Files live in memory by `projectDefinitionFileKey(projectId, path)`; every project id exists unless listed in
// `missingProjects` (404). Paths must be editable (`projectDefinitionPathKind`, else 400). Writes compare
// `expectedSha256` (null = the file must not exist) and answer 409 `stale` on a mismatch; a settings file keeps every key
// other than `hooks` (key order kept; null removes it) and `.mcp.json` every key other than `mcpServers`, written as
// `JSON.stringify(value, null, 2)` + a newline; only markdown definitions can be deleted. No parsing: `diagnostics` is
// always empty and `trust.pending` answers `pending`. Every save and delete emits `workspace.changed { projectId, chatId:
// null, batchId: null, source: 'user', paths }` on `options.events`. Every call is counted.
import type { ProjectDefinitionFile, ProjectDefinitionWriteBody, ProjectDefinitionWriteResult } from '@harness-forge/shared'
import type { EventBus } from '../services/events/types.ts'
import type { ProjectDefinitionsService } from '../services/project-definitions/types.ts'
import { createHash } from 'node:crypto'
import { HarnessError, isMarkdownDefinitionKind, projectDefinitionPathKind } from '@harness-forge/shared'

/** The key of a file in `FakeProjectDefinitionsService.files`. */
export function projectDefinitionFileKey(projectId: string, path: string): string {
  return `${projectId}:${path}`
}

export interface FakeProjectDefinitionsServiceOptions {
  /** Files by `projectDefinitionFileKey(projectId, path)`. */
  files?: Readonly<Record<string, string>>
  /** The `trust.pending` a write answers (default 0). */
  pending?: number
  /** Receives `workspace.changed` (default: no events). */
  events?: Pick<EventBus, 'emit'>
}

export interface FakeProjectDefinitionsService extends ProjectDefinitionsService {
  /** Files by `projectDefinitionFileKey(projectId, path)`; tests may edit them. */
  readonly files: Map<string, string>
  /** Project ids that answer `not_found`. */
  readonly missingProjects: Set<string>
  /** The `trust.pending` a write answers; tests may change it. */
  pending: number
  /** Number of calls of each member. */
  readonly calls: Record<keyof ProjectDefinitionsService, number>
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function invalidPath(): HarnessError {
  const message = 'Use a definition file under .claude/ or .harness/, a settings file or .mcp.json.'
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['path'], message, code: 'custom' }] } })
}

function stale(): HarnessError {
  return new HarnessError({ code: 'conflict', message: 'The file changed on disk. Load it again or overwrite it.', details: { reason: 'stale' } })
}

/** `text` (a JSON object, or nothing) with `key` set to `value` (null removes it), every other key kept in order. */
function spliceKey(text: string | undefined, key: string, value: Record<string, unknown> | null): string {
  let object: Record<string, unknown> = {}
  if (text !== undefined && text.trim() !== '') {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      object = parsed as Record<string, unknown>
  }
  if (value === null)
    delete object[key]
  else
    object[key] = value
  return `${JSON.stringify(object, null, 2)}\n`
}

export function createFakeProjectDefinitionsService(options: FakeProjectDefinitionsServiceOptions = {}): FakeProjectDefinitionsService {
  const files = new Map(Object.entries(options.files ?? {}))
  const missingProjects = new Set<string>()
  const calls: Record<keyof ProjectDefinitionsService, number> = { read: 0, write: 0, remove: 0 }

  function checkProject(projectId: string): void {
    if (missingProjects.has(projectId))
      throw new HarnessError({ code: 'not_found', message: `Project ${projectId} not found.` })
  }

  function changed(projectId: string, path: string): void {
    options.events?.emit('workspace.changed', { projectId, chatId: null, batchId: null, source: 'user', paths: [path] })
  }

  const service: FakeProjectDefinitionsService = {
    files,
    missingProjects,
    pending: options.pending ?? 0,
    calls,
    read: async (projectId, path, signal): Promise<ProjectDefinitionFile> => {
      calls.read += 1
      signal?.throwIfAborted()
      const kind = projectDefinitionPathKind(path)
      if (kind === null)
        throw invalidPath()
      checkProject(projectId)
      const content = files.get(projectDefinitionFileKey(projectId, path))
      return content === undefined
        ? { path, kind, exists: false, content: null, sha256: null, diagnostics: [] }
        : { path, kind, exists: true, content, sha256: sha256(content), diagnostics: [] }
    },
    write: async (projectId, body: ProjectDefinitionWriteBody): Promise<ProjectDefinitionWriteResult> => {
      calls.write += 1
      if (projectDefinitionPathKind(body.path) === null)
        throw invalidPath()
      checkProject(projectId)
      const key = projectDefinitionFileKey(projectId, body.path)
      const current = files.get(key)
      if ((current === undefined ? null : sha256(current)) !== body.expectedSha256)
        throw stale()
      const content = 'content' in body ? body.content : 'hooks' in body ? spliceKey(current, 'hooks', body.hooks) : spliceKey(current, 'mcpServers', body.mcpServers)
      files.set(key, content)
      changed(projectId, body.path)
      return { path: body.path, sha256: sha256(content), created: current === undefined, diagnostics: [], trust: { pending: service.pending } }
    },
    remove: async (projectId, path, expectedSha256) => {
      calls.remove += 1
      const kind = projectDefinitionPathKind(path)
      if (kind === null || !isMarkdownDefinitionKind(kind))
        throw invalidPath()
      checkProject(projectId)
      const key = projectDefinitionFileKey(projectId, path)
      const current = files.get(key)
      if (current === undefined)
        throw new HarnessError({ code: 'not_found', message: `The file ${path} was not found.` })
      if (sha256(current) !== expectedSha256)
        throw stale()
      files.delete(key)
      changed(projectId, path)
    },
  }
  return service
}
