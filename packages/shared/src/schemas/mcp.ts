// MCP 2.0 DTOs (Phase 14; API.md sections 4.36 … 4.38): OAuth sign-in for remote MCP servers (ADR-059), elicitation
// requests and answers (ADR-060), and MCP prompts / resources (ADR-061). The elicitation form is read only by
// `parseElicitationForm` (`util/mcp-elicitation.ts`); `mcpElicitationFormSchema` is its zod mirror (kept in sync by a
// type-level test). OAuth tokens, codes, code verifiers, client secrets and state values never appear in a DTO: the
// state of a sign-in is `McpAuthInfo`, the state of a client secret a `SecretState`.
import { z } from 'zod'
import {
  elicitationActionSchema,
  elicitationReasonSchema,
  mcpAuthClientKindSchema,
  mcpStatusSchema,
  projectMcpStateSchema,
} from '../enums.ts'
import { CATALOG_NAME_PATTERN, chatIdSchema, elicitationIdSchema, mcpServerIdSchema, projectIdSchema, QUALIFIED_NAME_MAX_CHARS, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import {
  ELICITATION_FIELD_NAME_PATTERN,
  ELICITATION_FIELDS_MAX,
  ELICITATION_MESSAGE_MAX_CHARS,
  ELICITATION_OPTIONS_MAX,
  ELICITATION_TEXT_MAX_CHARS,
  ELICITATION_VALUE_MAX_CHARS,
} from '../util/mcp-elicitation.ts'
import { MCP_PROMPT_NAME_PATTERN } from '../util/mcp-prompts.ts'
import { hasControlChars } from '../util/text.ts'
import { queryIntSchema, secretStateSchema } from './common.ts'

/** Characters of an OAuth client id (`oauth.clientId`). */
export const MCP_OAUTH_CLIENT_ID_MAX_CHARS = 256
/** Characters of the OAuth scopes of a server (`oauth.scopes`, space-separated). */
export const MCP_OAUTH_SCOPES_MAX_CHARS = 1024
/** Characters of an OAuth client secret (`oauth.clientSecret`, personal servers only). */
export const MCP_OAUTH_CLIENT_SECRET_MAX_CHARS = 4096
/** Characters of the URI of an MCP resource. */
export const MCP_RESOURCE_URI_MAX_CHARS = 2048

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/

/** True for an absolute http(s) URL without whitespace or control characters, at most `max` characters. */
function isHttpUrlWithin(value: string, max: number): boolean {
  if (value.length === 0 || value.length > max || /\s/.test(value) || hasControlChars(value) || !URL.canParse(value))
    return false
  const url = new URL(value)
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== ''
}

// ---------- slash command names (ADR-061) ----------

/** An MCP prompt command name without the leading `/` (`MCP_PROMPT_NAME_PATTERN`: `mcp__<serverId>__<prompt>`). */
export const mcpPromptNameSchema = z.string().regex(MCP_PROMPT_NAME_PATTERN, 'MCP prompt commands are "mcp__<server>__<prompt>" (1-59 characters of A-Z, a-z, 0-9, "_" and "-" after "mcp__").')
export type McpPromptName = z.infer<typeof mcpPromptNameSchema>

/**
 * The name of a server-side slash command (`CommandSummary.name`, `metadata.command.name`): a catalog name
 * (`catalogNameSchema`: a bare name or a qualified `<pluginId>:<name>`) or, since Phase 14 (ADR-061), an MCP prompt
 * command name (`mcp__<serverId>__<prompt>`). The two shapes never overlap (catalog names have no `_`).
 */
export const slashCommandNameSchema = z
  .string()
  .max(QUALIFIED_NAME_MAX_CHARS)
  .refine(
    name => CATALOG_NAME_PATTERN.test(name) || MCP_PROMPT_NAME_PATTERN.test(name),
    'Names start with a-z and use up to 64 characters of a-z, 0-9 and "-", are qualified "<pluginId>:<name>" (at most 128 characters), or are MCP prompt commands "mcp__<server>__<prompt>".',
  )
export type SlashCommandName = z.infer<typeof slashCommandNameSchema>

/** The MCP server of a prompt command (`CommandSummary.mcpServer`, ADR-061). */
export const commandMcpServerSchema = z.object({
  id: mcpServerIdSchema,
  /** The server's display name. */
  name: z.string().max(256),
})
export type CommandMcpServer = z.infer<typeof commandMcpServerSchema>

// ---------- OAuth (ADR-059) ----------

const oauthClientIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MCP_OAUTH_CLIENT_ID_MAX_CHARS)
  .regex(PRINTABLE_ASCII, 'Client ids use printable ASCII characters.')
const oauthScopesSchema = z
  .string()
  .trim()
  .max(MCP_OAUTH_SCOPES_MAX_CHARS)
  .refine(value => !hasControlChars(value), 'Scopes cannot contain control characters.')
const oauthClientSecretSchema = z
  .string()
  .min(1)
  .max(MCP_OAUTH_CLIENT_SECRET_MAX_CHARS)
  .regex(PRINTABLE_ASCII, 'Client secrets use printable ASCII characters.')

/**
 * The OAuth settings of a remote MCP server (`oauth` of a `.mcp.json` server, of a plugin declaration and of a personal
 * server; ADR-059): a pre-registered `clientId` (omitted = dynamic client registration at the authorization server)
 * and the `scopes` to ask for (space-separated; omitted = the scopes the server names in `WWW-Authenticate`, else
 * none).
 */
export const mcpOAuthConfigSchema = z.strictObject({
  clientId: oauthClientIdSchema.optional(),
  scopes: oauthScopesSchema.optional(),
})
export type McpOAuthConfig = z.infer<typeof mcpOAuthConfigSchema>

/**
 * `oauth` of a personal http / sse server in `POST /mcp`: `mcpOAuthConfigSchema` + a write-only `clientSecret` of a
 * confidential client (personal servers only; needs `clientId`; stored encrypted as `oauth.clientSecret` of secret scope
 * `mcp:<id>`, answered only as a `SecretState`).
 */
export const mcpOAuthInputSchema = mcpOAuthConfigSchema
  .extend({ clientSecret: oauthClientSecretSchema.optional() })
  .refine(value => value.clientSecret === undefined || value.clientId !== undefined, { message: 'A client secret needs a client id.', path: ['clientSecret'] })
export type McpOAuthInput = z.infer<typeof mcpOAuthInputSchema>

/**
 * `oauth` of a personal http / sse server in `PATCH /mcp/:id` (the transport is replaced): `clientSecret: null` keeps
 * the stored secret, an omitted `clientSecret` removes it; an omitted `oauth` removes the OAuth settings. Stored tokens
 * survive a change of the name, the policy or the scopes, and are dropped when the URL, the transport type or the
 * client id changes (server rule).
 */
export const mcpOAuthUpdateSchema = mcpOAuthConfigSchema
  .extend({ clientSecret: oauthClientSecretSchema.nullable().optional() })
  .refine(value => value.clientSecret === undefined || value.clientId !== undefined, { message: 'A client secret needs a client id.', path: ['clientSecret'] })
export type McpOAuthUpdate = z.infer<typeof mcpOAuthUpdateSchema>

/**
 * The sign-in state of an http / sse MCP server (`McpServer.auth`, `ProjectMcpServer.auth`; ADR-059). `null` in those
 * DTOs = the server does not use OAuth (stdio, a server with an `Authorization` header, or one that never asked for a
 * sign-in). Never a token or a code.
 */
export const mcpAuthInfoSchema = z.object({
  /** Tokens are stored for the server (they may still be refused: the status is `needs-auth` then). */
  signedIn: z.boolean(),
  /** When the access token expires (a refresh token renews it without the user); null = unknown or not signed in. */
  expiresAt: timestampSchema.nullable(),
  /** The scopes granted by the authorization server (space-separated); null = unknown or not signed in. */
  scope: z.string().max(MCP_OAUTH_SCOPES_MAX_CHARS).nullable(),
  /** How the OAuth client was obtained; null = not signed in yet. */
  client: mcpAuthClientKindSchema.nullable(),
  /** The authorization server's issuer (an https URL); null = unknown or not signed in. */
  issuer: z.string().max(2048).nullable(),
})
export type McpAuthInfo = z.infer<typeof mcpAuthInfoSchema>

/**
 * The OAuth settings of a personal or plugin http / sse server in its DTO (`McpServer.transport.oauth`; null = none
 * configured: dynamic client registration when the server asks for a sign-in). The client secret is write-only.
 */
export const mcpServerOAuthSchema = z.object({
  clientId: z.string().max(MCP_OAUTH_CLIENT_ID_MAX_CHARS).nullable(),
  /** Personal servers: the write-only `oauth.clientSecret` (never set for plugin and project servers). */
  clientSecret: secretStateSchema,
  scopes: z.string().max(MCP_OAUTH_SCOPES_MAX_CHARS).nullable(),
})
export type McpServerOAuth = z.infer<typeof mcpServerOAuthSchema>

/**
 * True for a safe in-app return path of a sign-in: `/`-relative (`/plugins?tab=mcp`), not protocol-relative (`//`), no
 * backslash, whitespace or control character, at most `LIMITS.mcpReturnToMaxChars` characters.
 */
export function isSafeReturnTo(value: string): boolean {
  return value.length > 0
    && value.length <= LIMITS.mcpReturnToMaxChars
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\\')
    && !/\s/.test(value)
    && !hasControlChars(value)
}

/** A sign-in return path (`isSafeReturnTo`). */
export const mcpReturnToSchema = z.string().refine(isSafeReturnTo, 'Expected an app path such as "/plugins?tab=mcp" (starts with one "/", at most 512 characters).')

/**
 * Body of `POST /mcp/:id/oauth` and `POST /projects/:id/mcp/:serverId/oauth` (sign in; no fresh auth): where the
 * callback page navigates afterwards (default: the page that lists the server).
 */
export const mcpAuthStartBodySchema = z.strictObject({
  returnTo: mcpReturnToSchema.optional(),
})
export type McpAuthStartBody = z.infer<typeof mcpAuthStartBodySchema>

/**
 * Answer of a sign-in start: the browser navigates to `authorizationUrl` in the same tab; null = the stored tokens still
 * work (or were refreshed) and the server reconnected, nothing to do.
 */
export const mcpAuthStartSchema = z.object({
  /** The authorization server's authorize URL with PKCE S256, `state`, `resource` and `redirect_uri` (http(s) only). */
  authorizationUrl: z.string().refine(value => isHttpUrlWithin(value, 8192), 'Expected an http(s) URL.').nullable(),
  /** `<request Origin>/oauth/callback`: what the authorization server redirects to (shown in the server settings). */
  redirectUri: z.string().refine(value => isHttpUrlWithin(value, 2048), 'Expected an http(s) URL.'),
  /** When the pending flow expires (`LIMITS.mcpOAuthFlowMs` after the start); the answer time when nothing is pending. */
  expiresAt: timestampSchema,
})
export type McpAuthStart = z.infer<typeof mcpAuthStartSchema>

/**
 * Body of `POST /mcp/oauth/callback` (session + Origin check; posted by the SPA page `/oauth/callback` with the query of
 * the authorization server's redirect): `state` and exactly one of `code` (success) or `error` (RFC 6749 4.1.2.1).
 * Never logged; the code is exchanged once and never stored.
 */
export const mcpAuthCallbackBodySchema = z
  .strictObject({
    state: z.string().min(16).max(256).regex(PRINTABLE_ASCII, 'Invalid state.'),
    code: z.string().min(1).max(4096).regex(PRINTABLE_ASCII, 'Invalid code.').optional(),
    /** RFC 9207 `iss` of the redirect, checked against the flow's authorization server. */
    iss: z.string().min(1).max(2048).regex(PRINTABLE_ASCII, 'Invalid issuer.').optional(),
    error: z.string().min(1).max(256).regex(PRINTABLE_ASCII, 'Invalid error code.').optional(),
    errorDescription: z.string().max(1000).refine(value => !hasControlChars(value), 'Invalid error description.').optional(),
  })
  .refine(value => (value.code === undefined) !== (value.error === undefined), { message: 'Send exactly one of "code" or "error".', path: ['code'] })
export type McpAuthCallbackBody = z.infer<typeof mcpAuthCallbackBodySchema>

/** The server a sign-in was for (`McpAuthCallbackResult.target`). */
export const mcpAuthTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global'), serverId: mcpServerIdSchema }),
  z.object({ kind: z.literal('project'), projectId: projectIdSchema, serverId: mcpServerIdSchema }),
])
export type McpAuthTarget = z.infer<typeof mcpAuthTargetSchema>

/** A personal / plugin server status or a project server state (`McpStatus | ProjectMcpState`). */
export const mcpServerStateAnySchema = z.union([mcpStatusSchema, projectMcpStateSchema])
export type McpServerStateAny = z.infer<typeof mcpServerStateAnySchema>

/** Answer of `POST /mcp/oauth/callback`: the server, its status after the sign-in, and where to go next. */
export const mcpAuthCallbackResultSchema = z.object({
  target: mcpAuthTargetSchema,
  /** `McpStatus` of a global server, `ProjectMcpState` of a project server (normally `connected`). */
  status: mcpServerStateAnySchema,
  /** The `returnTo` of the start; null = the default page. */
  returnTo: mcpReturnToSchema.nullable(),
})
export type McpAuthCallbackResult = z.infer<typeof mcpAuthCallbackResultSchema>

// ---------- elicitation (ADR-060) ----------

/** An option of an enum or multi-select field (`ElicitationOption`). */
export const mcpElicitationOptionSchema = z.object({
  value: z.string().max(ELICITATION_VALUE_MAX_CHARS),
  /** The option's title, or the value when it has none. */
  label: z.string().max(ELICITATION_TEXT_MAX_CHARS),
})
export type McpElicitationOption = z.infer<typeof mcpElicitationOptionSchema>

/** An answer value: a string, a number, a boolean, or the values of a multi-select. */
export const mcpElicitationValueSchema = z.union([
  z.string().max(ELICITATION_VALUE_MAX_CHARS),
  z.number(),
  z.boolean(),
  z.array(z.string().max(ELICITATION_VALUE_MAX_CHARS)).max(ELICITATION_OPTIONS_MAX),
])
export type McpElicitationValue = z.infer<typeof mcpElicitationValueSchema>

/** One field of a normalized elicitation form (zod mirror of `ElicitationField`, `util/mcp-elicitation.ts`). */
export const mcpElicitationFieldSchema = z.object({
  name: z.string().regex(ELICITATION_FIELD_NAME_PATTERN),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'enum', 'multi-enum']),
  title: z.string().max(ELICITATION_TEXT_MAX_CHARS).nullable(),
  description: z.string().max(ELICITATION_TEXT_MAX_CHARS).nullable(),
  required: z.boolean(),
  default: mcpElicitationValueSchema.optional(),
  /** `string` only. */
  format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
  minLength: z.int().min(0).optional(),
  maxLength: z.int().min(0).optional(),
  /** `number` / `integer` only. */
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  /** `enum` / `multi-enum` only. */
  options: z.array(mcpElicitationOptionSchema).max(ELICITATION_OPTIONS_MAX).optional(),
  /** `multi-enum` only. */
  minItems: z.int().min(0).optional(),
  maxItems: z.int().min(0).optional(),
})
export type McpElicitationField = z.infer<typeof mcpElicitationFieldSchema>

/**
 * A normalized elicitation form (zod mirror of `ElicitationForm`, the result of `parseElicitationForm`): at most
 * `ELICITATION_FIELDS_MAX` (20) flat fields of the supported subset.
 */
export const mcpElicitationFormSchema = z.object({
  fields: z.array(mcpElicitationFieldSchema).max(ELICITATION_FIELDS_MAX),
})
export type McpElicitationForm = z.infer<typeof mcpElicitationFormSchema>

/**
 * A pending elicitation request shown as a form card under the running MCP tool row (the tool part's preliminary output,
 * `McpToolProgress`). `message` and every title / description are untrusted plain text (never Markdown or HTML).
 */
export const mcpElicitationSchema = z.object({
  id: elicitationIdSchema,
  serverId: mcpServerIdSchema,
  /** The server's display name ("Share only what you would give {server}."). */
  serverName: z.string().max(256),
  /** The request message (`elicitationMessageText`: control characters removed, at most 2000 characters). */
  message: z.string().max(ELICITATION_MESSAGE_MAX_CHARS),
  form: mcpElicitationFormSchema,
  /** When the wait ends with `cancel` (`timeout`); `LIMITS.mcpElicitationWaitMs` after the request. */
  expiresAt: timestampSchema,
})
export type McpElicitation = z.infer<typeof mcpElicitationSchema>

/**
 * The preliminary output of a running MCP tool call (ADR-060): `input-required` while an elicitation waits for the user
 * (re-sent every 25 s as a keep-alive, replayed by the run resume buffer after a reload), then `running` again. The
 * final output is the tool's result; it never contains the values the user entered.
 */
export const mcpToolProgressSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('input-required'), elicitation: mcpElicitationSchema }),
  z.object({ status: z.literal('running') }),
])
export type McpToolProgress = z.infer<typeof mcpToolProgressSchema>

/**
 * What the stored (final) output of an MCP tool call keeps of each elicitation of the call: the request message, the
 * field NAMES, the action and the reason. The values the user entered are never stored.
 */
export const mcpElicitationRecordSchema = z.object({
  id: elicitationIdSchema,
  message: z.string().max(ELICITATION_MESSAGE_MAX_CHARS),
  fields: z.array(z.string().regex(ELICITATION_FIELD_NAME_PATTERN)).max(ELICITATION_FIELDS_MAX),
  action: elicitationActionSchema,
  reason: elicitationReasonSchema,
})
export type McpElicitationRecord = z.infer<typeof mcpElicitationRecordSchema>

/** `/chat/:id/elicitations/:elicitationId`. */
export const chatElicitationParamsSchema = z.object({ id: chatIdSchema, elicitationId: elicitationIdSchema })
export type ChatElicitationParams = z.infer<typeof chatElicitationParamsSchema>

/**
 * Body of `POST /chat/:id/elicitations/:elicitationId`: the user's answer. `content` (field name -> value) only with
 * `accept`; the server validates it against the form (`validateElicitationAnswer`, `400` with field issues) and never
 * stores or logs the values.
 */
export const mcpElicitationAnswerBodySchema = z
  .strictObject({
    action: elicitationActionSchema,
    content: z
      .record(z.string().regex(ELICITATION_FIELD_NAME_PATTERN), mcpElicitationValueSchema)
      .refine(content => Object.keys(content).length <= ELICITATION_FIELDS_MAX, `At most ${ELICITATION_FIELDS_MAX} fields.`)
      .optional(),
  })
  .refine(value => value.content === undefined || value.action === 'accept', { message: '"content" is only allowed with "accept".', path: ['content'] })
export type McpElicitationAnswerBody = z.infer<typeof mcpElicitationAnswerBodySchema>

/** Answer of `POST /chat/:id/elicitations/:elicitationId`: the action the MCP server received. */
export const mcpElicitationAnswerResultSchema = z.object({
  action: elicitationActionSchema,
})
export type McpElicitationAnswerResult = z.infer<typeof mcpElicitationAnswerResultSchema>

// ---------- resources (ADR-061) ----------

/** The URI of an MCP resource: a URI scheme (`file:`, `repo:`, `https:` …), no whitespace or control characters. */
export const mcpResourceUriSchema = z
  .string()
  .min(1)
  .max(MCP_RESOURCE_URI_MAX_CHARS)
  .regex(/^[a-z][\d+.a-z-]*:\S*$/i, 'Expected a resource URI with a scheme (no whitespace).')
  .refine(value => !hasControlChars(value), 'Resource URIs cannot contain control characters.')

/**
 * Query of `GET /mcp/resources` (the `@` menu): the resources of the connected global servers and, with `projectId`,
 * of that project's connected servers (a project server shadows a global one with the same id). `q` filters by name,
 * title and URI (empty = the first entries).
 */
export const mcpResourceQuerySchema = z.object({
  projectId: projectIdSchema.optional(),
  /** At most `LIMITS.mentionQueryMaxChars` (256) characters; default ''. */
  q: z.string().max(LIMITS.mentionQueryMaxChars).default(''),
  /** 1..100; default 50. */
  limit: queryIntSchema(1, LIMITS.pageLimitMax).default(LIMITS.mentionResultsMax),
})
export type McpResourceQuery = z.infer<typeof mcpResourceQuerySchema>

/** Where a listed resource's server is configured. */
export const mcpResourceScopeSchema = z.enum(['global', 'project'])
export type McpResourceScope = z.infer<typeof mcpResourceScopeSchema>

/** One MCP resource of the `@` menu (resource templates are not listed). Untrusted text: shown as plain text. */
export const mcpResourceEntrySchema = z.object({
  serverId: mcpServerIdSchema,
  serverName: z.string().max(256),
  scope: mcpResourceScopeSchema,
  uri: z.string().max(MCP_RESOURCE_URI_MAX_CHARS),
  name: z.string().max(256),
  title: z.string().max(256).optional(),
  description: z.string().max(1000).optional(),
  mimeType: z.string().max(256).optional(),
  /** Bytes, when the server says. */
  size: z.int().min(0).optional(),
  /** The composer text of the mention (`formatResourceMention`: `@<serverId>:<uri>`; display only). */
  mention: z.string().max(1 + 32 + 1 + MCP_RESOURCE_URI_MAX_CHARS),
})
export type McpResourceEntry = z.infer<typeof mcpResourceEntrySchema>

/** A server whose resources could not be listed (not connected, needs a sign-in, failed). */
export const mcpResourceUnavailableSchema = z.object({
  serverId: mcpServerIdSchema,
  status: mcpServerStateAnySchema,
})
export type McpResourceUnavailable = z.infer<typeof mcpResourceUnavailableSchema>

/** Answer of `GET /mcp/resources`: the best matches first, at most `limit`. */
export const mcpResourceListSchema = z.object({
  items: z.array(mcpResourceEntrySchema).max(LIMITS.pageLimitMax),
  /** More resources matched than `limit`, or a server listed more than `LIMITS.mcpResourcesMax`. */
  truncated: z.boolean(),
  /** Servers of the scope whose resources are missing from the list, with their status. */
  unavailable: z.array(mcpResourceUnavailableSchema),
})
export type McpResourceList = z.infer<typeof mcpResourceListSchema>

/**
 * Body of `POST /mcp/resources/attach` (`201`, answers the `FileRef` of the upload): reads the resource once and stores
 * it as an upload (at most `LIMITS.mcpResourceReadBytes`, else `413`; text as `text/plain` or the server's `text/*`,
 * binary only images and PDF). `projectId` selects the project's server of that id.
 */
export const mcpResourceAttachBodySchema = z.strictObject({
  serverId: mcpServerIdSchema,
  uri: mcpResourceUriSchema,
  projectId: projectIdSchema.optional(),
})
export type McpResourceAttachBody = z.infer<typeof mcpResourceAttachBodySchema>
