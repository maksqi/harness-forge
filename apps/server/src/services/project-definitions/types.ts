// Frozen interface of the project definition file editor (Phase 12, ADR-056; API.md 4.35 / 5.36, ARCHITECTURE.md 6.36):
// read, write and delete the agent, command, skill and output style files of a project's `.claude` / `.harness` folders,
// the `hooks` key of its four settings files and the `mcpServers` key of its `.mcp.json`. Implementation:
// `createProjectDefinitionsService(deps)` in `services/project-definitions/index.ts` (C43 stub: every member answers
// `not_implemented`; W12.4 implements `paths`, `settings-file` and the read / write / remove). Consumers: the
// `projectDefinitions` routes (W12.4). The service keeps no state (no boot or shutdown step). Test double:
// `createFakeProjectDefinitionsService` (`testing/fake-project-definitions.ts`), installed with `createTestApp({
// projectDefinitions: 'fake' })`.
//
// Saving never approves anything: a hook, a `.mcp.json` server or a command with `!` spans that a save creates or changes
// is pending until the user approves it (the write result's `trust.pending`). Every path is one of
// `projectDefinitionPathKind` and resolves through `resolveWorkspacePath(…, { allowMissing: true })` with the relative
// path unchanged (no link anywhere on it; `.git` and secret-looking names refused), checked again inside the per-file
// lock; writes go through `writeWithoutRecording` (not journaled; `workspace.changed { source: 'user', chatId: null }`),
// with `expectedSha256` compared under the lock (409 `stale`). No fresh auth and no idle rule (a save is allowed while a
// chat of the project runs). Nothing is ever written outside `.claude/`, `.harness/` and `.mcp.json`. File contents
// are never logged.
import type { ProjectDefinitionFile, ProjectDefinitionWriteBody, ProjectDefinitionWriteResult } from '@harness-forge/shared'

/** Project definition files (ADR-056). Errors are `HarnessError`s the routes pass through (API.md 2 / 5.36). */
export interface ProjectDefinitionsService {
  /**
   * `GET /projects/:id/definitions/file?path`: the file as it is on disk (`exists: false` with `content` and `sha256`
   * null when missing) with the diagnostics of its parser (`parseDefinition`, `readHooksConfig`, `parseMcpJson`).
   * Throws `validation_error` (not an editable path, a path the guard refuses), `not_found` (unknown project, or its
   * folder is unavailable).
   */
  readonly read: (projectId: string, path: string, signal?: AbortSignal) => Promise<ProjectDefinitionFile>
  /**
   * `PUT /projects/:id/definitions/file` (body validated by the route with `projectDefinitionWriteBodySchema`): a
   * definition's raw markdown, a settings file's `hooks` key (every other key and the key order kept; null removes it)
   * or `.mcp.json`'s `mcpServers` key. Throws `validation_error` (an `error` diagnostic, with `details.diagnostics`; a
   * guarded path), `not_found` (unknown project), `conflict` `stale` (the file's sha256 is not `expectedSha256`, or it
   * exists while `expectedSha256` is null).
   */
  readonly write: (projectId: string, body: ProjectDefinitionWriteBody) => Promise<ProjectDefinitionWriteResult>
  /**
   * `DELETE /projects/:id/definitions/file?path&expectedSha256`: a markdown definition (a skill folder left empty is
   * removed). Throws `validation_error`, `not_found` (unknown project or file), `conflict` `stale`.
   */
  readonly remove: (projectId: string, path: string, expectedSha256: string) => Promise<void>
}
