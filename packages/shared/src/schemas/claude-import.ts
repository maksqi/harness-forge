// Import from a Claude Code home folder (Phase 12, ADR-055; API.md section 4.34): the DTO side of
// `util/claude-import.ts`. The server builds the authoritative plan (an upload of browser-filtered files or a zip, or a
// scan of `HF_CLAUDE_HOME`) and keeps it in memory (`cip_` ids, 10 minutes); the browser gets the items without their
// payloads (contents, env and header values never leave the server) and applies a selection by item key.
import { z } from 'zod'
import { ENV_VAR_NAME_PATTERN, importPlanIdSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import {
  CLAUDE_IMPORT_ACTIONS,
  CLAUDE_IMPORT_KINDS,
  CLAUDE_IMPORT_STATUSES,
  CLAUDE_IMPORT_WARNINGS,
} from '../util/claude-import.ts'
import { hasControlChars } from '../util/text.ts'

const pathSchema = z.string().min(1).max(LIMITS.workspacePathMaxChars)

// ---------- enums ----------

/** Kind of an import item (`CLAUDE_IMPORT_KINDS`, type `ClaudeImportKind`). */
export const claudeImportKindSchema = z.enum(CLAUDE_IMPORT_KINDS)

/**
 * Status of an import item against the current state (`CLAUDE_IMPORT_STATUSES`, type `ClaudeImportStatus`): `new`,
 * `update` (same kind and name, other content; default skip), `unchanged`, `conflict` (a builtin or reserved name, or an
 * MCP server id with another transport: rename / overwrite / skip), `unsupported` (listed, never applied) or `invalid`
 * (the file does not parse).
 */
export const claudeImportStatusSchema = z.enum(CLAUDE_IMPORT_STATUSES)

/** What apply does with an item (`CLAUDE_IMPORT_ACTIONS`, type `ClaudeImportAction`). */
export const claudeImportActionSchema = z.enum(CLAUDE_IMPORT_ACTIONS)

/** A preview warning of an item (`CLAUDE_IMPORT_WARNINGS`, type `ClaudeImportWarning`). */
export const claudeImportWarningSchema = z.enum(CLAUDE_IMPORT_WARNINGS)

/** Where a plan was built from: an upload (`POST /claude-import/upload`) or a server scan (`POST /claude-import/scan`). */
export const claudeImportSourceSchema = z.enum(['upload', 'scan'])
export type ClaudeImportSource = z.infer<typeof claudeImportSourceSchema>

/** What apply did with an item. */
export const claudeImportOutcomeSchema = z.enum(['created', 'updated', 'unchanged', 'skipped', 'failed'])
export type ClaudeImportOutcome = z.infer<typeof claudeImportOutcomeSchema>

// ---------- home folder (GET /claude-import/home) ----------

/**
 * `GET /claude-import/home`: whether the server can scan a Claude Code folder (`HF_CLAUDE_HOME`, default `~/.claude` of
 * the server user). `reason`: `disabled` (`HF_CLAUDE_HOME=0`, the Docker default), `missing` (no such folder) or
 * `unreadable`; `path` is the folder that would be scanned (null when disabled).
 */
export const claudeImportHomeSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['disabled', 'missing', 'unreadable']).optional(),
  path: pathSchema.nullable(),
})
export type ClaudeImportHome = z.infer<typeof claudeImportHomeSchema>

// ---------- plan ----------

/** A problem of an item or of the whole plan: one English sentence that never quotes a value or a file's contents. */
export const claudeImportDiagnosticSchema = z.object({
  level: z.enum(['error', 'warning', 'info']),
  code: z.string().min(1).max(64),
  message: z.string().max(1000),
})
export type ClaudeImportDiagnosticDto = z.infer<typeof claudeImportDiagnosticSchema>

/** One item of an import plan (`ClaudeImportPlanItem` without its server-side payload). */
export const claudeImportPlanItemSchema = z.object({
  /** Stable within the plan (`claudeImportItemKey`). */
  key: z.string().min(1).max(512),
  kind: claudeImportKindSchema,
  name: z.string().min(1).max(256),
  /** The file the item came from (relative to the `.claude` folder, or `.claude.json`) and, for per-project servers, the project key. */
  source: z.object({ file: pathSchema, project: pathSchema.optional() }),
  status: claudeImportStatusSchema,
  /** The actions the user may pick (empty for `unchanged`, `unsupported` and `invalid`). */
  actions: z.array(claudeImportActionSchema).max(CLAUDE_IMPORT_ACTIONS.length),
  defaultAction: claudeImportActionSchema,
  /** Suggested name for `rename`. */
  renameTo: z.string().min(1).max(128).optional(),
  /** One line for the preview (never values). */
  summary: z.string().max(LIMITS.claudeImportSummaryMaxChars),
  warnings: z.array(claudeImportWarningSchema).max(CLAUDE_IMPORT_WARNINGS.length),
  diagnostics: z.array(claudeImportDiagnosticSchema).max(50),
  /** `${VAR}` names an MCP server needs without a value from `settings.json` `env` (names only). */
  variables: z.array(z.string().regex(ENV_VAR_NAME_PATTERN)).max(50).optional(),
  /** A command hook, a `!` command or a stdio MCP server: imported turned off unless `enable` is sent (apply is fresh). */
  executable: z.boolean(),
})
export type ClaudeImportPlanItemDto = z.infer<typeof claudeImportPlanItemSchema>

/** `POST /claude-import/upload` and `POST /claude-import/scan`: the plan, held by the server until it expires. */
export const claudeImportPlanSchema = z.object({
  id: importPlanIdSchema,
  source: claudeImportSourceSchema,
  /** What was read, for display (the scanned folder, or the name of the uploaded folder or zip). */
  root: z.string().max(LIMITS.workspacePathMaxChars),
  createdAt: timestampSchema,
  /** After this the plan is gone (`POST /claude-import/apply` answers `404`). */
  expiresAt: timestampSchema,
  /** Sorted by kind, then name. */
  items: z.array(claudeImportPlanItemSchema).max(LIMITS.claudeImportItemsMax),
  /** Collected files that were not used (too large, binary, not allowlisted, over a cap). */
  skipped: z.array(z.object({ path: pathSchema, reason: z.string().max(300) })).max(LIMITS.claudeImportSkippedMax),
  diagnostics: z.array(claudeImportDiagnosticSchema).max(200),
})
export type ClaudeImportPlan = z.infer<typeof claudeImportPlanSchema>

/**
 * Multipart parts of `POST /claude-import/upload` (at most 32 MiB in total): one zip of a `.claude` folder in the part
 * `file`, or the folder's files in parts named `files` (each part's file name is its path relative to the `.claude`
 * folder; the browser sends only paths `isClaudeHomeImportPath` accepts), plus `~/.claude.json` in the optional part
 * `claudeJson`. Never both `file` and `files`.
 */
export const CLAUDE_IMPORT_UPLOAD_PARTS = { zip: 'file', files: 'files', claudeJson: 'claudeJson' } as const

/** Multipart string fields of `POST /claude-import/upload` next to the file parts (not part of this schema). */
export const claudeImportUploadFormSchema = z.object({
  /** The name of the picked folder or zip, shown as the plan's `root`. */
  label: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine(value => !hasControlChars(value), 'Control characters are not allowed.')
    .optional(),
})
export type ClaudeImportUploadForm = z.infer<typeof claudeImportUploadFormSchema>

// ---------- apply ----------

/** One picked item of `POST /claude-import/apply`. */
export const claudeImportApplyItemSchema = z.strictObject({
  key: z.string().min(1).max(512),
  action: claudeImportActionSchema,
  /** `rename`: the new name (checked like a created definition or MCP server id). */
  renameTo: z.string().trim().min(1).max(128).optional(),
  /** Executable items (command hooks, `!` commands, stdio servers): import them turned on (default off). */
  enable: z.boolean().optional(),
})
export type ClaudeImportApplyItem = z.infer<typeof claudeImportApplyItemSchema>

/**
 * Body of `POST /claude-import/apply` (strict; fresh auth): the plan and the picked items. Items not sent are skipped. An
 * expired or unknown plan is `404`. `variables` supply `${VAR}` values of imported MCP servers per item key (never read
 * from the server environment).
 */
export const claudeImportApplyBodySchema = z
  .strictObject({
    planId: importPlanIdSchema,
    items: z.array(claudeImportApplyItemSchema).min(1).max(LIMITS.claudeImportItemsMax),
    /** `CLAUDE.md`: append to the global instructions (default) or replace them. */
    instructions: z.enum(['append', 'replace']).optional(),
    variables: z
      .record(
        z.string().min(1).max(512),
        z.record(z.string().regex(ENV_VAR_NAME_PATTERN, 'Invalid variable name.'), z.string().max(LIMITS.projectMcpVariableValueMaxChars)),
      )
      .optional(),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>()
    body.items.forEach((item, index) => {
      if (seen.has(item.key))
        ctx.addIssue({ code: 'custom', path: ['items', index, 'key'], message: `The item "${item.key.slice(0, 64)}" is sent more than once.` })
      seen.add(item.key)
      if (item.action === 'rename' && item.renameTo === undefined)
        ctx.addIssue({ code: 'custom', path: ['items', index, 'renameTo'], message: '"rename" needs "renameTo".' })
    })
  })
export type ClaudeImportApplyBody = z.infer<typeof claudeImportApplyBodySchema>

/** What apply did, per item and in total. */
export const claudeImportApplyResultSchema = z.object({
  results: z
    .array(
      z.object({
        key: z.string().min(1).max(512),
        outcome: claudeImportOutcomeSchema,
        /** The created or updated row (`cus_`, `hok_`, `srl_` id, an MCP server id). */
        id: z.string().min(1).max(64).optional(),
        /** Why it failed or was skipped (one sentence, never a value). */
        message: z.string().max(500).optional(),
      }),
    )
    .max(LIMITS.claudeImportItemsMax),
  counts: z.object({
    created: z.int().min(0),
    updated: z.int().min(0),
    unchanged: z.int().min(0),
    skipped: z.int().min(0),
    failed: z.int().min(0),
  }),
  warnings: z.array(z.string().max(300)).max(100),
})
export type ClaudeImportApplyResult = z.infer<typeof claudeImportApplyResultSchema>
