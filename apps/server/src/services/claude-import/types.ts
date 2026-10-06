// Frozen interface of the home-folder import (Phase 12, ADR-055; API.md 4.34 / 5.35, ARCHITECTURE.md 6.35): copy a
// Claude Code setup (agents, commands, skills, output styles, `settings.json` hooks and permissions, `CLAUDE.md`, the MCP
// servers of `.claude.json`) once into personal sources. Implementation: `createClaudeImportService(deps)` in
// `services/claude-import/index.ts` (C43 stub: `home()` is real, the rest answers `not_implemented`; W12.3 implements
// the collectors, the baseline, the plans and apply). Consumers: the `claudeImport` routes (`home` through this service
// since P12-0b; scan, upload and apply W12.3) and shutdown (`stopDeps`: `stop()` first, the plans dropped). Test
// double: `createFakeClaudeImportService` (`testing/fake-claude-import.ts`), installed with `createTestApp({
// claudeImport: 'fake' })`.
//
// Only an allowlist is read (`isClaudeHomeImportPath`, `util/claude-import.ts`): `agents/*.md`, `commands/**/*.md` (≤ 3
// levels), `skills/<name>/SKILL.md`, `output-styles/*.md`, `settings.json`, `CLAUDE.md`, `.claude.json` (inside the
// folder, or next to a folder named `.claude`; reduced to its MCP maps by `extractClaudeJsonMcpServers` before anything
// reads it); never `.credentials.json`, `projects/`, histories, `todos/`, `shell-snapshots/`, `statsig/`, `plugins/` or
// `settings.local.json`. The planner is the shared `planClaudeImport` (pure), run on the server: the plan (`cip_` id,
// `LIMITS.claudeImportPlanTtlMs`, at most `LIMITS.claudeImportPlansMax`) keeps the payloads (file contents, hook handlers, MCP server objects with their
// env and header values, the `settings.json` `env` values) in memory; DTOs, logs and errors carry names and summaries
// only. `${VAR}` of an imported MCP server resolves from the apply body's `variables`, then the imported `env`, then the
// default, **never `process.env`**. Imported command hooks, `!` commands and stdio servers arrive turned off unless the
// user enables them in the (fresh-auth) apply. Logging: `info` = the source, counts and duration; the root path only at
// `debug`; never a content, a command, a prompt or a value.
import type {
  ClaudeImportApplyBody,
  ClaudeImportApplyResult,
  ClaudeImportHome,
  ClaudeImportPlan,
} from '@harness-forge/shared'
import type { SensitiveOperationOptions } from '../../types.ts'

/** One file of a folder upload (a multipart part named `files`). */
export interface ClaudeImportUploadFile {
  /** The part's file name: the POSIX path relative to the `.claude` folder (`agents/reviewer.md`). */
  readonly path: string
  readonly file: Blob
}

/**
 * The multipart body of `POST /claude-import/upload` as the route parsed it (at most 32 MiB in total;
 * `CLAUDE_IMPORT_UPLOAD_PARTS`): one zip of a `.claude` folder, or the folder's files, plus the optional `~/.claude.json`.
 * The route refuses a body that is not `multipart/form-data`; the service refuses both `zip` and `files`, neither, and
 * re-checks every path with `isClaudeHomeImportPath` (anything else is skipped, never read).
 */
export interface ClaudeImportUploadInput {
  /** `ClaudeImportUploadForm.label`: the name of the picked folder or zip, shown as the plan's `root`. */
  readonly label?: string
  /** The part `file`: one zip (read with the install zip guards: only allowlisted entries inflated, one top folder stripped). */
  readonly zip?: Blob
  /** The parts `files`. */
  readonly files?: readonly ClaudeImportUploadFile[]
  /** The part `claudeJson`: `~/.claude.json`. */
  readonly claudeJson?: Blob
}

/** The home-folder import. Errors are `HarnessError`s the routes pass through (API.md 2 / 5.35). */
export interface ClaudeImportService {
  /**
   * `GET /claude-import/home`: whether `scan` can read `env.claudeHome` (`HF_CLAUDE_HOME`): `{ available: false, reason:
   * 'disabled', path: null }` when it is off (`0`); else one `stat` of the folder (links followed), never a file read:
   * a directory is available, nothing there (or a file) is `missing`, a refused `stat` is `unreadable`; `path` is the
   * configured folder.
   */
  readonly home: () => Promise<ClaudeImportHome>
  /**
   * `POST /claude-import/scan`: calls `options.requireFreshAuth()` first when given (the route table marks the route
   * fresh too); reads the allowlist of `env.claudeHome` (links followed to regular files outside the data directory,
   * caps of `CLAUDE_HOME_LIMITS`, a 10 s deadline), plans against the current state and keeps the plan. Throws `conflict`
   * `disabled` when the scan is off, `not_found` when the folder is missing.
   */
  readonly scan: (options?: SensitiveOperationOptions) => Promise<ClaudeImportPlan>
  /**
   * `POST /claude-import/upload`: plans the uploaded files or zip against the current state and keeps the plan; nothing
   * else changes. Throws `validation_error` (both or neither of `zip` / `files`, an unreadable zip) and
   * `payload_too_large`.
   */
  readonly upload: (input: ClaudeImportUploadInput) => Promise<ClaudeImportPlan>
  /**
   * `POST /claude-import/apply` (body validated by the route with `claudeImportApplyBodySchema`): calls
   * `options.requireFreshAuth()` first when given; re-checks the picked items against the current state and applies
   * them in one pass (`customizations.importDefinitions`, `hooks.importPersonal`, the global MCP servers, shell rules,
   * tool overrides and settings): exactly one `customization.changed` and one `hooks.changed`. The plan is dropped.
   * Throws `not_found` for an unknown or expired plan ("The import plan expired. Read the folder again."),
   * `validation_error` for an unknown item key, an action the item does not offer or an invalid rename.
   */
  readonly apply: (body: ClaudeImportApplyBody, options?: SensitiveOperationOptions) => Promise<ClaudeImportApplyResult>
  /**
   * Shutdown (`stopDeps`, the first step): drops every plan and aborts the scans in flight. Plans are also dropped on
   * apply, on expiry and on `key.rotated`. Idempotent; never rejects.
   */
  readonly stop: () => Promise<void>
}
