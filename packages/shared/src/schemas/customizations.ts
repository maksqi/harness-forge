// Agent customization DTOs (Phase 10, ADR-044 … ADR-047; API.md sections 4.28 and 4.30): the catalog of agents,
// commands, skills and (Phase 11, ADR-051) output styles (`GET /customizations`), the bodies of catalog entries (`GET /customizations/source`), the
// personal definitions (`/customizations/:id`, table `customizations`), the `customization.changed` event, the backup
// file `customizations.json` and Remember (`POST /memory`). Definition files are parsed only by `util/definitions.ts`.
import { z } from 'zod'
import {
  customizationKindSchema,
  customizationSourceSchema,
  customizationStateSchema,
  definitionDiagnosticSchema,
  rememberTargetSchema,
} from '../enums.ts'
import { chatIdSchema, customizationIdSchema, modelRefSchema, pluginIdSchema, projectIdSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { CUSTOMIZATION_KINDS, DEFINITION_LIMITS } from '../util/definitions.ts'
import { utf8ByteLength } from '../util/text.ts'
import { queryBooleanSchema } from './common.ts'
import { projectInstructionsFileSchema, projectSummarySchema } from './projects.ts'
import { settingsSchema } from './system.ts'

const pathSchema = z.string().min(1).max(LIMITS.workspacePathMaxChars)

/**
 * A name as the catalog lists it: valid names follow `AGENT_NAME_PATTERN` / `COMMAND_NAME_PATTERN`; an `invalid` entry
 * may carry the raw name of its file.
 */
const entryNameSchema = z.string().min(1).max(256)

/**
 * A `tools` / `allowed-tools` entry after normalization (harness tool names; `mcp__<server>__*` prefixes): only ever a
 * restriction. Loose on purpose: unknown names are reported as diagnostics, never rejected here.
 */
const toolListEntrySchema = z.string().min(1).max(256)

/** The raw markdown of a definition (frontmatter + body), at most 64 KiB of UTF-8. */
export const definitionContentSchema = z
  .string()
  .min(1)
  .refine(value => utf8ByteLength(value) <= DEFINITION_LIMITS.contentBytes, 'Definitions are limited to 64 KB.')

// ---------- catalog (GET /customizations) ----------

/** The entry that shadows a catalog entry (a higher source, or an earlier file of the same folder). */
export const customizationShadowedBySchema = z.object({
  source: customizationSourceSchema,
  /** Project entries: the project-relative path of the winning file. */
  path: pathSchema.optional(),
  /** Plugin entries: the plugin of the winner. */
  pluginId: pluginIdSchema.optional(),
})
export type CustomizationShadowedBy = z.infer<typeof customizationShadowedBySchema>

/**
 * One definition of the merged catalog (ADR-044): its source, its state and what the frontmatter declares. Bodies are
 * not listed: `GET /customizations/source` (project, plugin and builtin entries) or `GET /customizations/:id` (personal
 * entries).
 */
export const customizationEntrySchema = z.object({
  kind: customizationKindSchema,
  name: entryNameSchema,
  /** The `description`, at most 1024 characters ('' when missing: the entry is then `invalid`). */
  description: z.string().max(DEFINITION_LIMITS.descriptionMaxChars),
  source: customizationSourceSchema,
  /** Personal entries (`source: 'user'`): the row id. */
  id: customizationIdSchema.optional(),
  /** Plugin entries: the contributing plugin. */
  pluginId: pluginIdSchema.optional(),
  /** Project entries: the project-relative path of the file (`.harness/agents/reviewer.md`). */
  path: pathSchema.optional(),
  /** Commands in subfolders: the folder path below the commands folder (`frontend/forms`), a display label only. */
  namespace: z.string().min(1).max(LIMITS.workspacePathMaxChars).optional(),
  /** Commands and (Phase 11) skills: `argument-hint` (at most 100 characters). */
  argumentHint: z.string().max(DEFINITION_LIMITS.argumentHintMaxChars).optional(),
  /** Styles (Phase 11, ADR-051): the display name as written (the `name` is its slug). */
  label: z.string().min(1).max(256).optional(),
  /**
   * Styles (Phase 11): `keep-coding-instructions` (default false: the workspace tool rules and the todo / task hints are
   * left out of the instructions while the style is active).
   */
  keepCodingInstructions: z.boolean().optional(),
  /** Skills (Phase 11, ADR-052): `user-invocable` (default true: the skill runs as `/name [arguments]`). */
  userInvocable: z.boolean().optional(),
  /**
   * Skills (Phase 11): false when `disable-model-invocation: true` (the skill is left out of the skills listing, the
   * `skill` tool and `loadSkill`).
   */
  modelInvocable: z.boolean().optional(),
  /** Agents and commands: the declared `model` (`provider:model`, or `inherit` for agents); absent = the default. */
  modelRef: z.union([modelRefSchema, z.literal('inherit')]).optional(),
  /** Agents: `tools`; commands: `allowed-tools` (normalized); absent = no restriction ("All tools"). */
  tools: z.array(toolListEntrySchema).max(DEFINITION_LIMITS.toolsMax).optional(),
  /** Personal entries: the `enabled` flag; true for every other source (disable a plugin to remove its entries). */
  enabled: z.boolean(),
  state: customizationStateSchema,
  /** `state: 'shadowed'`: the entry that wins the name. */
  shadowedBy: customizationShadowedBySchema.optional(),
  diagnostics: z.array(definitionDiagnosticSchema).max(100),
})
export type CustomizationEntry = z.infer<typeof customizationEntrySchema>

/** Query of `GET /customizations`: the catalog of a project (else the global catalog: builtin, plugin and personal). */
export const customizationsQuerySchema = z.object({
  /** Include the definitions of this project's folder. */
  projectId: projectIdSchema.optional(),
  /** Only this kind. */
  kind: customizationKindSchema.optional(),
  /** Rebuild the catalog of the project now instead of serving the cached one (10 s). */
  refresh: queryBooleanSchema.optional(),
})
export type CustomizationsQuery = z.infer<typeof customizationsQuerySchema>

/** What the catalog read from the project folder. */
export const customizationProjectScanSchema = z.object({
  id: projectIdSchema,
  /** The folder opened; false = no project entries (a `project-unavailable` diagnostic says why). */
  available: z.boolean(),
  /** Why the folder is unavailable (one sentence, safe to show). */
  issue: z.string().max(500).optional(),
  /**
   * The definition folders that exist (`.claude/agents`, `.harness/commands`, ..., Phase 11: `.claude/output-styles`,
   * `.harness/output-styles`), lowest precedence first.
   */
  folders: z.array(z.string().min(1).max(64)).max(8),
  /** When the project part of the catalog was built. */
  scannedAt: timestampSchema,
})
export type CustomizationProjectScan = z.infer<typeof customizationProjectScanSchema>

/** `GET /customizations`: the merged catalog, every source and state (the precedence of ADR-044 applied). */
export const customizationListSchema = z.object({
  /** Kind, then name, then precedence (the active entry first). */
  items: z.array(customizationEntrySchema),
  /** Folder-level diagnostics (`link`, `limit`, `read-failed`, `project-unavailable`). */
  diagnostics: z.array(definitionDiagnosticSchema).max(100),
  /** null without `projectId`. */
  project: customizationProjectScanSchema.nullable(),
  /** When the catalog was built (cached up to 10 s). */
  builtAt: timestampSchema,
})
export type CustomizationList = z.infer<typeof customizationListSchema>

/** Query of `GET /customizations/source`: the body of one project, plugin or builtin entry. */
export const customizationSourceQuerySchema = z.object({
  /** Required for `source: 'project'`. */
  projectId: projectIdSchema.optional(),
  kind: customizationKindSchema,
  name: entryNameSchema,
  source: customizationSourceSchema,
  /** Project entries: the project-relative path of the file (a shadowed file of the same name); default: the winner. */
  path: pathSchema.optional(),
})
export type CustomizationSourceQuery = z.infer<typeof customizationSourceQuerySchema>

/**
 * `GET /customizations/source`: the markdown of an entry (a project file as read, re-validated; a plugin or builtin
 * definition formatted with `formatDefinition`).
 */
export const customizationSourceResultSchema = z.object({
  content: z.string().max(LIMITS.customizationContentBytes),
  /** Project entries: the project-relative path that was read. */
  path: pathSchema.optional(),
})
export type CustomizationSourceResult = z.infer<typeof customizationSourceResultSchema>

// ---------- personal definitions (/customizations/:id) ----------

/** The parsed fields of an agent (zod mirror of `AgentDefinitionFields`). */
export const agentDefinitionFieldsSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Harness tool names; null = every tool the parent's mode allows. */
  tools: z.array(z.string()).readonly().nullable(),
  /** `provider:model`, `inherit`, or null (the default sub-agent model). */
  model: z.string().nullable(),
  instructions: z.string(),
})

/** The parsed fields of a command (zod mirror of `CommandDefinitionFields`). */
export const commandDefinitionFieldsSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().nullable(),
  /** `provider:model` or null (the chat's model). */
  model: z.string().nullable(),
  /** Tool names that narrow the turn; null = no restriction. */
  allowedTools: z.array(z.string()).readonly().nullable(),
  /** The prompt template (`$ARGUMENTS`, `$1` … `$9`, `{{input}}`). */
  body: z.string(),
})

/** The parsed fields of a skill (zod mirror of `SkillDefinitionFields`). */
export const skillDefinitionFieldsSchema = z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
  /** Phase 11 (ADR-052): `user-invocable`; absent = true (the skill runs as `/name [arguments]`). */
  userInvocable: z.boolean().optional(),
  /** Phase 11: not `disable-model-invocation`; absent = true (the model may load the skill). */
  modelInvocable: z.boolean().optional(),
  /** Phase 11: `argument-hint` of a user-invocable skill; absent = none. */
  argumentHint: z.string().optional(),
})

/** The parsed fields of an output style (Phase 11, ADR-051; zod mirror of `StyleDefinitionFields`). */
export const styleDefinitionFieldsSchema = z.object({
  /** The slug (`AGENT_NAME_PATTERN`). */
  name: z.string(),
  /** The name as written. */
  label: z.string(),
  description: z.string(),
  /** `keep-coding-instructions` (default false). */
  keepCodingInstructions: z.boolean(),
  /** The style body: added first to the main agent's instructions. */
  content: z.string(),
})

const customizationBaseShape = {
  id: customizationIdSchema,
  /** The parsed name (`AGENT_NAME_PATTERN` for agents, skills and styles, `COMMAND_NAME_PATTERN` for commands). */
  name: z.string().min(1).max(64),
  description: z.string().max(DEFINITION_LIMITS.descriptionMaxChars),
  /** The stored markdown (frontmatter + body), exactly as saved. */
  content: z.string().max(LIMITS.customizationContentBytes),
  /** Off = listed `state: 'off'`, never used. */
  enabled: z.boolean(),
  /** Warnings and infos of the stored content (it has no `error`: such content is refused with `400`). */
  diagnostics: z.array(definitionDiagnosticSchema).max(100),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}

/**
 * A personal agent, command, skill or (Phase 11) output style (`GET /customizations/:id`, create / update answers),
 * discriminated on `kind`; `fields` holds the parsed frontmatter and body (null when the stored content no longer
 * parses).
 */
export const customizationSchema = z.discriminatedUnion('kind', [
  z.object({ ...customizationBaseShape, kind: z.literal('agent'), fields: agentDefinitionFieldsSchema.nullable() }),
  z.object({ ...customizationBaseShape, kind: z.literal('command'), fields: commandDefinitionFieldsSchema.nullable() }),
  z.object({ ...customizationBaseShape, kind: z.literal('skill'), fields: skillDefinitionFieldsSchema.nullable() }),
  z.object({ ...customizationBaseShape, kind: z.literal('style'), fields: styleDefinitionFieldsSchema.nullable() }),
])
export type Customization = z.infer<typeof customizationSchema>

/**
 * Body of `POST /customizations`: the markdown is parsed by the server with `parseDefinition` (an `error` diagnostic is
 * `400` with the diagnostics in `details.diagnostics`; a name taken by the same kind is `409` `exists`; a builtin or
 * reserved name is `400`; more than 200 of a kind is `409`).
 */
export const customizationCreateSchema = z.strictObject({
  kind: customizationKindSchema,
  content: definitionContentSchema,
  /** Default true. */
  enabled: z.boolean().optional(),
})
export type CustomizationCreate = z.infer<typeof customizationCreateSchema>

/** Body of `PATCH /customizations/:id`: at least one key; new `content` is parsed like a create (the kind stays). */
export const customizationUpdateSchema = z
  .strictObject({
    content: definitionContentSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(value => value.content !== undefined || value.enabled !== undefined, 'Send "content" or "enabled".')
export type CustomizationUpdate = z.infer<typeof customizationUpdateSchema>

/** `/customizations/:id`. */
export const customizationParamsSchema = z.object({ id: customizationIdSchema })
export type CustomizationParams = z.infer<typeof customizationParamsSchema>

/**
 * Data of `customization.changed` (ADR-044): the catalog changed. `id` = a personal definition was created, updated or
 * deleted; `projectId` = the definition files of a project changed (or were re-read); neither = refetch everything
 * (plugin agents or skills changed).
 */
export const customizationChangedDataSchema = z.object({
  kind: customizationKindSchema.optional(),
  id: customizationIdSchema.optional(),
  projectId: projectIdSchema.optional(),
})
export type CustomizationChangedData = z.infer<typeof customizationChangedDataSchema>

// ---------- backup (customizations.json) ----------

/**
 * One personal definition in a backup (no ids, no timestamps; no secrets: definitions never hold any). Phase 11: personal
 * output styles travel here too; a personal command with `` !`cmd` `` spans is restored turned off (ADR-052).
 */
export const backupCustomizationSchema = z.object({
  kind: customizationKindSchema,
  name: z.string().min(1).max(64),
  content: definitionContentSchema,
  enabled: z.boolean(),
})
export type BackupCustomization = z.infer<typeof backupCustomizationSchema>

/**
 * `customizations.json` of a backup zip: every personal definition. Personal hooks, project approvals and project MCP
 * variables are never in a backup (Phase 11).
 */
export const backupCustomizationsSchema = z.object({
  items: z.array(backupCustomizationSchema).max(CUSTOMIZATION_KINDS.length * LIMITS.customizationsPerKindMax),
})
export type BackupCustomizations = z.infer<typeof backupCustomizationsSchema>

// ---------- Remember (POST /memory, ADR-047) ----------

/**
 * Body of `POST /memory` (strict): the text becomes one line `- <text>` (control characters other than line breaks are
 * removed). The project targets need `chatId` of a chat with a project (the project is taken from the chat).
 */
export const rememberBodySchema = z
  .strictObject({
    target: rememberTargetSchema,
    /** 1..2000 characters after trimming. */
    text: z.string().trim().min(1).max(LIMITS.rememberTextMaxChars),
    chatId: chatIdSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.target !== 'global' && body.chatId === undefined)
      ctx.addIssue({ code: 'custom', path: ['chatId'], message: 'Project targets need the chat of a project ("chatId").' })
  })
export type RememberBody = z.infer<typeof rememberBodySchema>

/** Response of `POST /memory`. */
export const rememberResultSchema = z.object({
  target: rememberTargetSchema,
  /** `project-file`: the file that was written. */
  file: projectInstructionsFileSchema.optional(),
  /** `project-file`: the file was created (the project had neither `AGENTS.md` nor `CLAUDE.md`). */
  created: z.boolean().optional(),
  /** Project targets: the project after the change. */
  project: projectSummarySchema.optional(),
  /** `global`: the settings after the change. */
  settings: settingsSchema.optional(),
})
export type RememberResult = z.infer<typeof rememberResultSchema>
