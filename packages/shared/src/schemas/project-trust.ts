// Project trust and project MCP DTOs (Phase 11, ADR-049 / ADR-050; API.md section 4.32): the executable items of a
// project folder and their approvals (`/projects/:id/trust`, table `project_trust`), the servers of a project's
// `.mcp.json` and their variables (`/projects/:id/mcp`, secret scope `project:<projectId>`), and the
// `project-trust.changed` / `project-mcp.changed` events. The canonical hash input of an item is `trustHashInput`
// (`util/trust.ts`); `.mcp.json` is parsed only by `util/mcp-config.ts`. Approvals and variables are never in backups.
import { z } from 'zod'
import {
  hookEventSchema,
  hookHandlerTypeSchema,
  projectMcpStateSchema,
  projectMcpTransportSchema,
  trustItemKindSchema,
  trustStateSchema,
  trustWarningSchema,
} from '../enums.ts'
import { harnessErrorInitSchema } from '../errors.ts'
import { mcpServerIdSchema, projectIdSchema, sha256HexSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { MCP_VARIABLE_NAME_PATTERN } from '../util/mcp-config.ts'

const projectPathSchema = z.string().min(1).max(LIMITS.workspacePathMaxChars)
const shortTextSchema = z.string().max(200)

/** A `.mcp.json` variable name (`${NAME}`): `^[A-Za-z_]\w{0,63}$`. */
export const mcpVariableNameSchema = z.string().regex(MCP_VARIABLE_NAME_PATTERN, 'Variable names use 1-64 characters of A-Z, a-z, 0-9 and "_", not starting with a digit.')
export type McpVariableName = z.infer<typeof mcpVariableNameSchema>

// ---------- trust items (GET /projects/:id/trust) ----------

/** A script file an item names, hashed into its trust hash (null = missing, unreadable or larger than 1 MiB). */
export const trustRefSchema = z.object({
  /** Project-relative. */
  path: projectPathSchema,
  sha256: sha256HexSchema.nullable(),
})

/**
 * What a hook item runs: exactly what its settings file says. Phase 12 (ADR-057): a prompt hook (`type: 'prompt'`,
 * `command` is '') shows its prompt and model; the handler fields are present only when the file sets them (items with
 * one of them hash as trust item v2, every other item keeps its v1 hash).
 */
export const trustHookDetailSchema = z.object({
  event: hookEventSchema,
  matcher: z.string().max(LIMITS.hookMatcherMaxChars).nullable(),
  command: z.string().max(LIMITS.hookCommandMaxChars),
  /** Seconds; null = the default (60 s; prompt hooks 30 s). */
  timeout: z.int().min(1).nullable(),
  /** Phase 12: the handler type; absent = `command`. */
  type: hookHandlerTypeSchema.optional(),
  /** Phase 12: exec-form arguments of a command hook. */
  args: z.array(z.string().max(LIMITS.hookCommandMaxChars)).max(64).optional(),
  /** Phase 12: a detached command hook. */
  async: z.boolean().optional(),
  /** Phase 12: the `if` rule (tool events). */
  if: z.string().max(512).optional(),
  /** Phase 12: the prompt of a prompt hook. */
  prompt: z.string().max(LIMITS.promptHookPromptMaxChars).optional(),
  /** Phase 12: the model of a prompt hook, as written. */
  model: z.string().max(64 + 1 + 256).optional(),
  /** Phase 12: `continueOnBlock` of a prompt hook. */
  continueOnBlock: z.boolean().optional(),
  /** Phase 12: the activity label. */
  statusMessage: z.string().max(200).optional(),
})
export type TrustHookDetail = z.infer<typeof trustHookDetailSchema>

/**
 * What a `.mcp.json` server item starts or connects to, unexpanded (`${VAR}` references kept): the command and
 * arguments (stdio) or the URL (http / sse), and only the NAMES of its environment variables and headers (values may
 * hold secrets and are never shown).
 */
export const trustMcpDetailSchema = z.object({
  /** The name in `.mcp.json`. */
  name: z.string().min(1).max(256),
  /** The harness server id (`mcpServerIdFromName`). */
  id: mcpServerIdSchema,
  transport: projectMcpTransportSchema,
  /** stdio. */
  command: z.string().max(4096).optional(),
  /** stdio. */
  args: z.array(z.string().max(4096)).max(64).optional(),
  /** http / sse. */
  url: z.string().max(4096).optional(),
  envNames: z.array(z.string().min(1).max(128)).max(64),
  headerNames: z.array(z.string().min(1).max(256)).max(32),
  /** The `${VAR}` names it references. */
  variables: z.array(mcpVariableNameSchema).max(LIMITS.projectMcpVariablesMax),
})
export type TrustMcpDetail = z.infer<typeof trustMcpDetailSchema>

/** What a command file item runs: its `` !`cmd` `` spans, in order (arguments are never substituted into them). */
export const trustCommandDetailSchema = z.object({
  /** The command name (`/name`). */
  name: z.string().min(1).max(64),
  spans: z.array(z.string().max(LIMITS.hookCommandMaxChars)).max(LIMITS.commandShellSpansMax),
})
export type TrustCommandDetail = z.infer<typeof trustCommandDetailSchema>

const trustItemBaseShape = {
  /** sha256 of `trustHashInput(item)`: the item and the script files it names. */
  sha256: sha256HexSchema,
  state: trustStateSchema,
  /**
   * A pending item whose kind and label match an approved row whose hash the current scan no longer finds (the item
   * changed since it was approved: "Changed" instead of "New"); absent or false otherwise.
   */
  changed: z.boolean().optional(),
  /** A short label for the list (the command, the server name, `/name`). */
  label: shortTextSchema,
  /** The project-relative file the item comes from (`.claude/settings.json`, `.mcp.json`, `.harness/commands/x.md`). */
  path: projectPathSchema,
  refs: z.array(trustRefSchema).max(LIMITS.trustRefFilesMax),
  warnings: z.array(trustWarningSchema).max(trustWarningSchema.options.length),
}

/**
 * An executable item of a project folder (ADR-049), discriminated on `kind`; `detail` shows exactly what would run. An
 * item runs only while its current `sha256` is approved; any change of the item or of a script file it names gives a
 * new hash (pending again).
 */
export const trustItemSchema = z.discriminatedUnion('kind', [
  z.object({ ...trustItemBaseShape, kind: z.literal('hook'), detail: trustHookDetailSchema }),
  z.object({ ...trustItemBaseShape, kind: z.literal('mcp'), detail: trustMcpDetailSchema }),
  z.object({ ...trustItemBaseShape, kind: z.literal('command'), detail: trustCommandDetailSchema }),
])
export type TrustItem = z.infer<typeof trustItemSchema>

/** `GET /projects/:id/trust` (also the answer of approve and revoke): the items of a fresh scan of the folder. */
export const projectTrustListSchema = z.object({
  items: z.array(trustItemSchema).max(LIMITS.trustItemsMax),
  /** Approved hashes no current item has (kept until revoked; they never run anything). */
  orphaned: z.int().min(0),
  scannedAt: timestampSchema,
  /** The folder opened; false = no items (`issue` says why). */
  available: z.boolean(),
  issue: z.string().max(500).optional(),
})
export type ProjectTrustList = z.infer<typeof projectTrustListSchema>

/** One item to approve: its kind and the hash the user reviewed. */
export const trustApprovalSchema = z.strictObject({
  kind: trustItemKindSchema,
  sha256: sha256HexSchema,
})
export type TrustApproval = z.infer<typeof trustApprovalSchema>

/**
 * Body of `POST /projects/:id/trust` (fresh auth): approves the reviewed hashes, 1..50 per request (there is no
 * "approve all"). The server re-scans the folder first; a hash that is not current (the item changed, or another kind)
 * is `409` `stale` and nothing is approved.
 */
export const projectTrustApproveBodySchema = z.strictObject({
  items: z
    .array(trustApprovalSchema)
    .min(1)
    .max(LIMITS.trustApproveItemsMax)
    .refine(items => new Set(items.map(item => item.sha256)).size === items.length, 'Hashes must be unique.'),
})
export type ProjectTrustApproveBody = z.infer<typeof projectTrustApproveBodySchema>

/** `/projects/:id/trust/:sha256` (revoke; idempotent). */
export const projectTrustItemParamsSchema = z.object({ id: projectIdSchema, sha256: sha256HexSchema })
export type ProjectTrustItemParams = z.infer<typeof projectTrustItemParamsSchema>

/**
 * Data of `project-trust.changed` (ADR-049): the approvals of a project changed (approve, revoke, project deleted) or a
 * scan found other items; `pending` = the items that wait for a review now (the trust chip count).
 */
export const projectTrustChangedDataSchema = z.object({
  projectId: projectIdSchema,
  pending: z.int().min(0),
})
export type ProjectTrustChangedData = z.infer<typeof projectTrustChangedDataSchema>

// ---------- project MCP servers (GET /projects/:id/mcp) ----------

/**
 * A server of the project's `.mcp.json` (ADR-050). Tools are offered only in the project's chats; a server whose id
 * equals a global server's id shadows that server there (`shadows`).
 */
export const projectMcpServerSchema = z.object({
  id: mcpServerIdSchema,
  /** The name in `.mcp.json`. */
  name: z.string().min(1).max(256),
  transport: projectMcpTransportSchema,
  state: projectMcpStateSchema,
  /** The trust hash of the server item (`POST /projects/:id/trust` approves it). */
  sha256: sha256HexSchema,
  /** `state: 'error'`: why (redacted). */
  error: harnessErrorInitSchema.optional(),
  /** Registered tool names (`mcp__<id>__<tool>`), while connected or last known. */
  tools: z.array(z.string().min(1).max(256)).max(LIMITS.projectMcpToolsMax),
  /** The id of the global MCP server this one shadows in the project's chats. */
  shadows: mcpServerIdSchema.optional(),
  /** `${VAR}` names without a stored value and without a default (state `needs-variables`). */
  missingVariables: z.array(mcpVariableNameSchema).max(LIMITS.projectMcpVariablesMax),
})
export type ProjectMcpServer = z.infer<typeof projectMcpServerSchema>

/** A variable of the project's servers. Values are never answered: only whether one is stored. */
export const projectMcpVariableSchema = z.object({
  name: mcpVariableNameSchema,
  /** A value is stored for the project (encrypted, secret scope `project:<projectId>`). */
  set: z.boolean(),
  /** The `:-default` of the first reference (shown as a placeholder); null = none. */
  hint: z.string().max(LIMITS.projectMcpVariableValueMaxChars).nullable(),
  /** The ids of the servers that reference it. */
  usedBy: z.array(mcpServerIdSchema).max(LIMITS.projectMcpServersMax),
})
export type ProjectMcpVariable = z.infer<typeof projectMcpVariableSchema>

/** `GET /projects/:id/mcp` (also the answer of `PUT /projects/:id/mcp/variables`). */
export const projectMcpListSchema = z.object({
  items: z.array(projectMcpServerSchema).max(LIMITS.projectMcpServersMax),
  variables: z.array(projectMcpVariableSchema).max(LIMITS.projectMcpVariablesMax),
})
export type ProjectMcpList = z.infer<typeof projectMcpListSchema>

/**
 * Body of `PUT /projects/:id/mcp/variables` (fresh auth: a value can change what an approved stdio server runs): a value
 * sets a variable (1..4096 characters, stored encrypted), null removes it; at most 50 keys. Variables never come from
 * the server environment. Servers that use a changed variable restart.
 */
export const projectMcpVariablesBodySchema = z.strictObject({
  values: z
    .record(mcpVariableNameSchema, z.string().min(1).max(LIMITS.projectMcpVariableValueMaxChars).nullable())
    .refine(values => Object.keys(values).length <= LIMITS.projectMcpVariablesMax, `At most ${LIMITS.projectMcpVariablesMax} variables.`),
})
export type ProjectMcpVariablesBody = z.infer<typeof projectMcpVariablesBodySchema>

/** `/projects/:id/mcp/:serverId/reconnect`. */
export const projectMcpServerParamsSchema = z.object({ id: projectIdSchema, serverId: mcpServerIdSchema })
export type ProjectMcpServerParams = z.infer<typeof projectMcpServerParamsSchema>

/** Data of `project-mcp.changed` (ADR-050): the servers of a project after a state change (connected, stopped, ...). */
export const projectMcpChangedDataSchema = z.object({
  projectId: projectIdSchema,
  servers: z.array(projectMcpServerSchema).max(LIMITS.projectMcpServersMax),
})
export type ProjectMcpChangedData = z.infer<typeof projectMcpChangedDataSchema>
