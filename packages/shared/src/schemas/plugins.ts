// Plugin DTOs: list, detail, settings, logs, install and trust, drafts, files and build (API.md sections 4.10-4.13).
// Phase 12 (ADR-053 / ADR-054): the plugin format, the origin of marketplace and GitHub installs, the Claude Code plugin
// info of inspections and details, and the `github` / `marketplace` install sources (API.md section 4.33).
import { z } from 'zod'
import {
  logLevelSchema,
  marketplaceEntrySourceKindSchema,
  pluginFormatSchema,
  pluginKindSchema,
  pluginSourceSchema,
  pluginStateSchema,
  pluginTemplateIdSchema,
} from '../enums.ts'
import { harnessErrorInitSchema } from '../errors.ts'
import {
  catalogNameSchema,
  marketplaceIdSchema,
  modelIdSchema,
  pluginIdSchema,
  providerIdSchema,
  sha256HexSchema,
  timestampSchema,
  toolNameSchema,
} from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { hasControlChars, utf8ByteLength } from '../util/text.ts'
import { parseHttpUrl } from '../util/url.ts'
import { iconRefSchema, queryBooleanSchema, queryIntSchema, secretStateSchema } from './common.ts'
import { claudeDiagnosticSchema, commitShaSchema, githubRepoSchema, gitRefSchema, marketplaceNameSchema, repoSubpathSchema } from './marketplaces.ts'
import { declarativeProviderSchema, fieldKeySchema, modelInfoSchema } from './plugin-data.ts'
import { pluginManifestBaseSchema } from './plugin-manifest.ts'
import { settingsKeySchema, settingsSchemaSchema } from './plugin-settings.ts'
import { credentialValuesSchema } from './providers.ts'

// ---------- list and detail (4.10) ----------

/**
 * What a plugin contributes. Phase 12 (ADR-053): the commands, agents, skills and output styles of Claude Code plugins
 * have qualified names (`<pluginId>:<name>`, `catalogNameSchema`); harness plugins keep bare names.
 */
export const pluginContributionsSchema = z.object({
  providers: z.array(providerIdSchema),
  /** Contributed models (manifest + `ctx.models.register`). */
  models: z.int().min(0),
  tools: z.array(toolNameSchema),
  /** Declared MCP server ids. */
  mcpServers: z.array(z.string()),
  commands: z.array(catalogNameSchema),
  /** `HookMap` keys with at least one handler (code hooks, `ctx.hooks.on`). */
  hooks: z.array(z.string()),
  /** Agent types (manifest + `ctx.agents.register`; plugin API 1.4.0). */
  agents: z.array(catalogNameSchema),
  /** Skills (manifest + `ctx.skills.register`; plugin API 1.4.0). */
  skills: z.array(catalogNameSchema),
  /**
   * Command hook handlers of `contributes.hooks` (plugin API 1.5.0, ADR-048; `GET /hooks` lists them). Named apart from
   * `hooks`, which lists the code hooks.
   */
  commandHooks: z.int().min(0),
  /** Output styles (manifest + `ctx.outputStyles.register`; plugin API 1.5.0, ADR-051). */
  outputStyles: z.array(catalogNameSchema),
})
export type PluginContributions = z.infer<typeof pluginContributionsSchema>

// ---------- Claude Code plugins and origins (Phase 12, ADR-053 / ADR-054) ----------

/**
 * Where a `github` or `marketplace` install came from (column `plugins.origin`, without the server-side entry overlay),
 * discriminated on `kind`: a marketplace entry (the marketplace may since have been removed: the origin then dangles)
 * or a GitHub repository at a resolved commit.
 */
export const pluginOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('marketplace'),
    marketplaceId: marketplaceIdSchema,
    /** The marketplace name at install time. */
    marketplace: marketplaceNameSchema,
    /** The entry name. */
    plugin: z.string().min(1).max(128),
    sourceKind: marketplaceEntrySourceKindSchema,
    /** `relative` / `github` entries: the commit the files came from. */
    commit: commitShaSchema.optional(),
    /** `archive` entries: the SHA-256 of the downloaded archive. */
    archiveSha256: sha256HexSchema.optional(),
    /** `npm` entries: the resolved package version. */
    npmVersion: z.string().max(128).optional(),
    /** The folder inside the repository or archive, when not its root. */
    path: z.string().max(512).optional(),
    /** The entry version at install time (null when the entry has none). */
    version: z.string().max(128).nullable(),
  }),
  z.object({
    kind: z.literal('github'),
    repo: githubRepoSchema,
    /** The ref the user gave (null = the default branch). */
    ref: gitRefSchema.nullable(),
    /** The commit it resolved to. */
    commit: commitShaSchema,
    /** The folder inside the repository (null = its root). */
    path: z.string().max(512).nullable(),
  }),
])
export type PluginOrigin = z.infer<typeof pluginOriginSchema>

/** One thing a Claude Code plugin can run, exactly as the trust consent lists it. */
export const claudePluginExecutableSchema = z.object({
  /** A command hook handler, a stdio MCP server or a `` !`cmd` `` span of a command. */
  kind: z.enum(['hook', 'mcp', 'span']),
  /** Where it is (`PostToolUse Write|Edit`, the server name, the command name). */
  label: z.string().max(200),
  /** The command line with its arguments, as written. */
  command: z.string().max(4096),
})
export type ClaudePluginExecutable = z.infer<typeof claudePluginExecutableSchema>

/**
 * What a Claude Code plugin is (`format: 'claude'`, ADR-053): its `plugin.json` identity, its components, what it can
 * run (the trust consent), the hosts it talks to, the settings its `userConfig` asks for and what is ignored.
 */
export const claudePluginInfoSchema = z.object({
  /** `name` of `plugin.json` (else the marketplace entry, the folder or the repository name). */
  name: z.string().min(1).max(128),
  /** `displayName` of `plugin.json`, when any. */
  displayName: z.string().max(128).optional(),
  /** The version as written (any string); null when none is known. */
  version: z.string().max(128).nullable(),
  /** The namespace of its qualified names: the plugin id. */
  namespace: pluginIdSchema,
  /** Components found (after the `plugin.json` path rules and the marketplace overlay). */
  components: z.object({
    commands: z.int().min(0),
    agents: z.int().min(0),
    skills: z.int().min(0),
    outputStyles: z.int().min(0),
    /** Hook handlers (command and prompt). */
    hooks: z.int().min(0),
    mcpServers: z.int().min(0),
  }),
  /** Every command hook handler (with its arguments), stdio MCP server and `!` span: what trust approves. */
  executables: z.array(claudePluginExecutableSchema).max(LIMITS.claudePluginExecutablesMax),
  /** Hosts of http MCP servers and URLs the plugin declares. */
  hosts: z.array(z.string().max(253)).max(100),
  /** The `userConfig` options (the plugin settings form; `sensitive` ones are secret settings). */
  userConfig: z
    .array(z.object({ key: z.string().min(1).max(64), title: z.string().max(200), sensitive: z.boolean(), required: z.boolean() }))
    .max(LIMITS.claudeUserConfigMax),
  /** Parts that are never used (`.lsp.json`, `bin/`, `themes/`, `monitors/`, an `http` hook handler, …). */
  unsupported: z.array(z.object({ component: z.string().min(1).max(256), reason: z.string().max(300) })).max(100),
  diagnostics: z.array(claudeDiagnosticSchema).max(LIMITS.claudePluginDiagnosticsMax),
})
export type ClaudePluginInfo = z.infer<typeof claudePluginInfoSchema>

/** A trust pin: lowercase hex SHA-256, or `path:` + SHA-256 of the folder realpath for linked folders. */
export const trustPinSchema = z.string().regex(/^(?:path:)?[\da-f]{64}$/, 'Expected a SHA-256 pin.')
export type TrustPin = z.infer<typeof trustPinSchema>

export const pluginTrustSchema = z.object({
  /**
   * Code plugin, or declares a stdio MCP server, or (plugin API 1.5.0) command hooks or `` !`cmd` `` spans in a command
   * template (`manifestRequiresTrust`).
   */
  required: z.boolean(),
  /** `!required`, or the pin matches (source `link`: path pinned). */
  trusted: z.boolean(),
  /** Current SHA-256 of `plugin.json` + entry; null for builtins. */
  hash: sha256HexSchema.nullable(),
  /** The pinned value (`path:` + SHA-256 for linked folders). */
  trustedHash: trustPinSchema.nullable(),
})
export type PluginTrust = z.infer<typeof pluginTrustSchema>

export const pluginSummarySchema = z.object({
  id: pluginIdSchema,
  name: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  icon: iconRefSchema,
  kind: pluginKindSchema,
  /** The folder layout (Phase 12, ADR-053): `harness` or `claude` (a Claude Code plugin). */
  format: pluginFormatSchema,
  source: pluginSourceSchema,
  /**
   * npm spec, URL, linked path, or zip file name; Phase 12: `owner/repo@<sha12>[/path]` (`github`) or
   * `<plugin>@<marketplace>` (`marketplace`).
   */
  sourceRef: z.string().nullable(),
  builtin: z.boolean(),
  /** False for builtins. */
  removable: z.boolean(),
  /** User intent. */
  enabled: z.boolean(),
  state: pluginStateSchema,
  /** "Runs code" badge. */
  runsCode: z.boolean(),
  contributions: pluginContributionsSchema,
  lastError: harnessErrorInitSchema.nullable(),
  installedAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type PluginSummary = z.infer<typeof pluginSummarySchema>

export const pluginDetailSchema = pluginSummarySchema.extend({
  /** Builtin manifests included (reserved ids allowed here). */
  manifest: pluginManifestBaseSchema,
  trust: pluginTrustSchema,
  /** Files API and manifest writable: source `created`, `copy` or `link`. */
  editable: z.boolean(),
  /** `manifest.settings` present. */
  hasSettings: z.boolean(),
  /** Phase 12 (ADR-054): where a `github` or `marketplace` install came from; null for every other source. */
  origin: pluginOriginSchema.nullable(),
  /** Phase 12 (ADR-053): the Claude Code plugin info (`format: 'claude'`); null for harness plugins. */
  claude: claudePluginInfoSchema.nullable(),
})
export type PluginDetail = z.infer<typeof pluginDetailSchema>

/** Query of `DELETE /plugins/:id`; `keepData` defaults to false. */
export const pluginRemoveQuerySchema = z.object({
  keepData: queryBooleanSchema.optional(),
})
export type PluginRemoveQuery = z.infer<typeof pluginRemoveQuerySchema>

export const pluginSettingsViewSchema = z.object({
  /** null when the plugin has no settings. */
  schema: settingsSchemaSchema.nullable(),
  /** Non-secret values, defaults applied. */
  values: z.record(z.string(), z.unknown()),
  /** Properties with `format: 'secret'`. */
  secrets: z.record(z.string(), secretStateSchema),
})
export type PluginSettingsView = z.infer<typeof pluginSettingsViewSchema>

/**
 * Body of `PUT /plugins/:id/settings`, validated against the plugin's `SettingsSchema` (`settingsValuesSchema()` of
 * `@harness-forge/plugin-sdk` with `partial: true`): secret properties take a string (`''` clears); omitted keys are
 * unchanged.
 */
export const pluginSettingsUpdateSchema = z.strictObject({
  values: z.record(settingsKeySchema, z.unknown()),
})
export type PluginSettingsUpdate = z.infer<typeof pluginSettingsUpdateSchema>

export const pluginLogEntrySchema = z.object({
  /** Per-plugin increasing sequence number. */
  seq: z.int().min(0),
  at: timestampSchema,
  level: logLevelSchema,
  /** <= 4 KB. */
  message: z.string(),
  /** Redacted structured data. */
  data: z.unknown().optional(),
})
export type PluginLogEntry = z.infer<typeof pluginLogEntrySchema>

/** Query of `GET /plugins/:id/logs`: entries with `seq > after`; `limit` 1..500, default 200. */
export const pluginLogsQuerySchema = z.object({
  after: queryIntSchema(0, Number.MAX_SAFE_INTEGER).optional(),
  limit: queryIntSchema(1, LIMITS.pluginLogsLimitMax).optional(),
})
export type PluginLogsQuery = z.infer<typeof pluginLogsQuerySchema>

// ---------- install and trust (4.11) ----------

/** npm package name (`name`, `@scope/name`) with an optional `@version`, `@tag` or `@range`. */
const NPM_SPEC = /^(?:@[\da-z~-][\da-z._~-]*\/)?[\da-z~-][\da-z._~-]*(?:@[^\s@]\S*)?$/

/** Padded standard base64 digests by SRI algorithm (32 and 64 bytes). */
const SRI_DIGESTS: ReadonlyMap<string, RegExp> = new Map([
  ['sha256', /^[\d+/a-z]{43}=$/i],
  ['sha512', /^[\d+/a-z]{86}==$/i],
])

/** Subresource integrity: `sha256-<base64>` or `sha512-<base64>`. */
function isSriIntegrity(value: string): boolean {
  const dash = value.indexOf('-')
  return dash > 0 && SRI_DIGESTS.get(value.slice(0, dash))?.test(value.slice(dash + 1)) === true
}

/** Subresource integrity of a URL install: `sha256-<base64>` or `sha512-<base64>`. */
export const integritySchema = z
  .string()
  .refine(isSriIntegrity, 'Expected an SRI hash "sha256-<base64>" or "sha512-<base64>".')

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Z]:[\\/]/i.test(value) || value.startsWith('\\\\')
}

const npmInstallSourceShape = {
  source: z.literal('npm'),
  /** `name`, `name@1.2.3`, `name@tag`, `@scope/name@range`. */
  spec: z.string().trim().min(1).max(214 + 1 + 128).regex(NPM_SPEC, 'Expected an npm package spec such as "name@1.2.3".'),
}
const urlInstallSourceShape = {
  source: z.literal('url'),
  /** https URL of a `.zip` or `.tgz`. */
  url: z.string().refine(value => parseHttpUrl(value, { protocols: ['https:'] }) !== null, 'Expected an https:// URL without credentials.'),
  integrity: integritySchema,
}
const pathInstallSourceShape = {
  source: z.literal('path'),
  /** Absolute path of a plugin folder on the server host. */
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(value => isAbsoluteHostPath(value) && !hasControlChars(value), 'Expected an absolute folder path.'),
  mode: z.enum(['link', 'copy']),
}

/**
 * Phase 12 (ADR-054): a GitHub repository: `ref` (a branch, tag or commit; default: the default branch) is resolved to a
 * commit, whose zip archive is downloaded over HTTPS (no git); `path` is the plugin folder inside the repository.
 */
const githubInstallSourceShape = {
  source: z.literal('github'),
  repo: githubRepoSchema,
  ref: gitRefSchema.optional(),
  path: repoSubpathSchema.optional(),
}
/** Phase 12 (ADR-054): an entry of an added marketplace (`plugin` = the entry name). */
const marketplaceInstallSourceShape = {
  source: z.literal('marketplace'),
  marketplaceId: marketplaceIdSchema,
  plugin: z.string().min(1).max(128),
}
/**
 * Phase 12 (ADR-053): the plugin format; absent = detected from the layout (a root `plugin.json` is `harness`, else
 * `.claude-plugin/plugin.json` or a Claude Code component is `claude`).
 */
const formatShape = {
  format: pluginFormatSchema.optional(),
}

export const pluginInstallSourceSchema = z.discriminatedUnion('source', [
  z.strictObject({ ...npmInstallSourceShape, ...formatShape }),
  z.strictObject({ ...urlInstallSourceShape, ...formatShape }),
  z.strictObject({ ...pathInstallSourceShape, ...formatShape }),
  z.strictObject({ ...githubInstallSourceShape, ...formatShape }),
  z.strictObject({ ...marketplaceInstallSourceShape, ...formatShape }),
])
export type PluginInstallSource = z.infer<typeof pluginInstallSourceSchema>

/** JSON body of `POST /plugins/inspect` (multipart: the zip in part `file`). */
export const pluginInspectBodySchema = pluginInstallSourceSchema
export type PluginInspectBody = z.infer<typeof pluginInspectBodySchema>

const installOptionsShape = {
  /** Pin the SHA-256 in the same step (code plugins need it to become active). */
  trust: z.boolean().optional(),
  /** Default true. */
  enable: z.boolean().optional(),
  /** The hash the user reviewed in the inspect preview; the install fails with `conflict` (`stale`) when it differs. */
  sha256: sha256HexSchema.optional(),
}

/** JSON body of `POST /plugins/install` (multipart: part `file` + `PluginInstallForm`). */
export const pluginInstallBodySchema = z.discriminatedUnion('source', [
  z.strictObject({ ...npmInstallSourceShape, ...formatShape, ...installOptionsShape }),
  z.strictObject({ ...urlInstallSourceShape, ...formatShape, ...installOptionsShape }),
  z.strictObject({ ...pathInstallSourceShape, ...formatShape, ...installOptionsShape }),
  z.strictObject({ ...githubInstallSourceShape, ...formatShape, ...installOptionsShape }),
  z.strictObject({ ...marketplaceInstallSourceShape, ...formatShape, ...installOptionsShape }),
])
export type PluginInstallBody = z.infer<typeof pluginInstallBodySchema>

/**
 * Multipart fields of `POST /plugins/install` next to the zip part `file` (the `file` part is not part of this schema
 * and is dropped by it).
 */
export const pluginInstallFormSchema = z.object({
  trust: z.enum(['true', 'false']).optional(),
  enable: z.enum(['true', 'false']).optional(),
  /** See `sha256` of the JSON body. */
  sha256: sha256HexSchema.optional(),
  /** Phase 12: see `format` of the JSON body. */
  format: pluginFormatSchema.optional(),
})
export type PluginInstallForm = z.infer<typeof pluginInstallFormSchema>

/** Multipart fields of `POST /plugins/inspect` next to the zip part `file` (Phase 12: the optional `format`). */
export const pluginInspectFormSchema = z.object({
  format: pluginFormatSchema.optional(),
})
export type PluginInspectForm = z.infer<typeof pluginInspectFormSchema>

export const pluginInspectionSchema = z.object({
  /** For a Claude Code plugin (Phase 12): a manifest synthesized from `plugin.json` (no `contributes`). */
  manifest: pluginManifestBaseSchema,
  kind: pluginKindSchema,
  /** Phase 12 (ADR-053): the detected (or requested) format. */
  format: pluginFormatSchema,
  /** `zip`, `npm`, `url`, `link` or `copy`; Phase 12: `github` or `marketplace`. */
  source: pluginSourceSchema,
  /**
   * Resolved source reference shown in "I trust <source>" (e.g. `name@1.2.3` for npm, the URL, the folder path; Phase
   * 12: `owner/repo@<sha12>[/path]` for GitHub and marketplace entries from GitHub).
   */
  sourceRef: z.string().optional(),
  /** The hash that trust pins. */
  sha256: sha256HexSchema,
  /** Declared in the manifest (code plugins may register more at runtime). */
  contributions: pluginContributionsSchema,
  /** Hosts of provider base URLs and MCP http/sse URLs (code plugins: unknown). */
  networkHosts: z.array(z.string()),
  /** Credential keys, secret settings, MCP header / env names. */
  secretsRequested: z.array(z.string()),
  /** `manifest.permissions` (advisory). */
  permissions: z.array(z.string()),
  requiresTrust: z.boolean(),
  /** `engines.harness` satisfies `PLUGIN_API_VERSION`. */
  compatible: z.boolean(),
  /** Install = update. */
  existing: z.object({ version: z.string(), state: pluginStateSchema, source: pluginSourceSchema }).nullable(),
  files: z.object({ count: z.int().min(0), bytes: z.int().min(0) }),
  /** e.g. "Runs code with full server privileges", "Replaces version 1.2.0". */
  warnings: z.array(z.string()),
  /** Phase 12 (ADR-053): the Claude Code plugin info (`format: 'claude'`); null for harness plugins. */
  claude: claudePluginInfoSchema.nullable(),
})
export type PluginInspection = z.infer<typeof pluginInspectionSchema>

/** Body of `POST /plugins/:id/trust`: must equal the current hash. */
export const pluginTrustBodySchema = z.strictObject({
  sha256: sha256HexSchema,
})
export type PluginTrustBody = z.infer<typeof pluginTrustBodySchema>

// ---------- declarative drafts (4.12) ----------

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.floor(value.length / 4) * 3 - padding
}

/** An uploaded plugin icon (`manifest.icon` must be this file name). SVG is sanitized by the server. */
export const iconFileInputSchema = z.strictObject({
  name: z.enum(['icon.svg', 'icon.png']),
  base64: z
    .base64()
    .max(Math.ceil(LIMITS.iconFileBytes / 3) * 4)
    .refine(value => value.length > 0 && decodedBase64Bytes(value) <= LIMITS.iconFileBytes, 'Icons are limited to 256 KB.'),
})
export type IconFileInput = z.infer<typeof iconFileInputSchema>

/** Declarative-only manifest (no `main`) of drafts and manifest updates. */
const declarativeManifestSchema = pluginManifestBaseSchema.superRefine((manifest, ctx) => {
  if (manifest.main !== undefined)
    ctx.addIssue({ code: 'custom', path: ['main'], message: 'Only declarative plugins (without "main") can be created or edited here.' })
})

interface IconCheckInput {
  manifest: { icon?: string }
  iconFile?: { name: string }
}

function checkIconFile(value: IconCheckInput, ctx: z.RefinementCtx, iconFileRequired: boolean): void {
  const icon = value.manifest.icon
  if (value.iconFile && icon !== value.iconFile.name)
    ctx.addIssue({ code: 'custom', path: ['manifest', 'icon'], message: `Set "icon" to "${value.iconFile.name}" to use the uploaded icon.` })
  if (!value.iconFile && iconFileRequired && icon !== undefined && !icon.startsWith('lobe:'))
    ctx.addIssue({ code: 'custom', path: ['iconFile'], message: `Upload the icon file "${icon}".` })
}

/** Body of `POST /plugins`: creates a declarative plugin (reserved ids are answered with 403 by the server). */
export const pluginDraftSchema = z
  .strictObject({
    /** Declarative only (no `main`); id free and not reserved. */
    manifest: declarativeManifestSchema,
    iconFile: iconFileInputSchema.optional(),
    /** Saved as provider credentials after creation; keys are the manifest's provider ids. */
    credentials: z.record(providerIdSchema, credentialValuesSchema).optional(),
    /** Default true. */
    enable: z.boolean().optional(),
  })
  .superRefine((draft, ctx) => {
    checkIconFile(draft, ctx, true)
    const providerIds = new Set((draft.manifest.contributes?.providers ?? []).map(provider => provider.id))
    for (const id of Object.keys(draft.credentials ?? {})) {
      if (!providerIds.has(id))
        ctx.addIssue({ code: 'custom', path: ['credentials', id], message: `The manifest declares no provider "${id}".` })
    }
  })
export type PluginDraft = z.infer<typeof pluginDraftSchema>

/** Body of `PUT /plugins/:id/manifest`: same id, declarative only. */
export const pluginManifestUpdateSchema = z
  .strictObject({
    manifest: declarativeManifestSchema,
    iconFile: iconFileInputSchema.optional(),
  })
  .superRefine((update, ctx) => checkIconFile(update, ctx, false))
export type PluginManifestUpdate = z.infer<typeof pluginManifestUpdateSchema>

/** Body of `POST /plugins/drafts/test`: a temporary provider, nothing stored. `modelId` is required for `ping`. */
export const draftTestRequestSchema = z
  .strictObject({
    provider: declarativeProviderSchema,
    /** Plain values for this test only, never stored or logged. */
    credentials: z.record(fieldKeySchema, z.string().max(LIMITS.credentialValueMaxChars)).optional(),
    /** A listing call, or a 1-token generation. */
    action: z.enum(['list-models', 'ping']),
    modelId: modelIdSchema.optional(),
  })
  .superRefine((request, ctx) => {
    if (request.action === 'ping' && request.modelId === undefined)
      ctx.addIssue({ code: 'custom', path: ['modelId'], message: '"modelId" is required for "ping".' })
  })
export type DraftTestRequest = z.infer<typeof draftTestRequestSchema>

/** `ok: false` + `error` on failure, not an HTTP error. */
export const draftTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().min(0),
  /** `list-models`. */
  models: z.array(modelInfoSchema).optional(),
  /** `ping`: generated text, <= 200 characters. */
  output: z.string().max(200).optional(),
  error: harnessErrorInitSchema.optional(),
})
export type DraftTestResult = z.infer<typeof draftTestResultSchema>

// ---------- plugin files and build (4.13) ----------

/** Body of `POST /plugins/scaffold`. `language` defaults to `js`. */
export const scaffoldRequestSchema = z.strictObject({
  /** Free, not reserved (a reserved id is answered with 403). */
  id: pluginIdSchema,
  // Same bound as the manifest `name` (64); no control characters.
  name: z.string().trim().min(1).max(64).regex(/^\P{Cc}*$/u, 'Control characters are not allowed.'),
  template: pluginTemplateIdSchema,
  /** `js`: `index.mjs` with JSDoc types; `ts`: `index.ts` compiled by the host. */
  language: z.enum(['js', 'ts']).optional(),
})
export type ScaffoldRequest = z.infer<typeof scaffoldRequestSchema>

export const pluginFileEntrySchema = z.object({
  /** Relative POSIX path, e.g. `lib/tools.mjs`. */
  path: z.string(),
  type: z.enum(['file', 'dir']),
  /** Bytes; 0 for directories. */
  size: z.int().min(0),
  mtime: timestampSchema,
  /** Text file <= 1 MB inside an editable plugin. */
  editable: z.boolean(),
})
export type PluginFileEntry = z.infer<typeof pluginFileEntrySchema>

export const pluginFileContentSchema = z.object({
  path: z.string(),
  /** UTF-8 text. */
  content: z.string(),
  /** SHA-256 hex of the content. */
  etag: sha256HexSchema,
  mtime: timestampSchema,
})
export type PluginFileContent = z.infer<typeof pluginFileContentSchema>

/** Body of `PUT /plugins/:id/files/*`: <= 1 MB of UTF-8 without NUL; `baseEtag` must equal the current etag. */
export const pluginFileWriteSchema = z.strictObject({
  content: z
    .string()
    .refine(value => !value.includes('\0'), 'Files cannot contain NUL characters.')
    .refine(value => utf8ByteLength(value) <= LIMITS.pluginFileBytes, 'Files are limited to 1 MB.'),
  baseEtag: sha256HexSchema.optional(),
})
export type PluginFileWrite = z.infer<typeof pluginFileWriteSchema>

export const buildDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  /** Relative POSIX path. */
  file: z.string().nullable(),
  /** 1-based. */
  line: z.int().min(1).nullable(),
  /** 1-based. */
  column: z.int().min(1).nullable(),
  message: z.string(),
  /** The source line, for display. */
  lineText: z.string().optional(),
})
export type BuildDiagnostic = z.infer<typeof buildDiagnosticSchema>

/** Body of `POST /plugins/:id/build`; `reload` defaults to true. */
export const pluginBuildBodySchema = z.strictObject({
  reload: z.boolean().optional(),
})
export type PluginBuildBody = z.infer<typeof pluginBuildBodySchema>

/** A failed build is `ok: false` with diagnostics, not an HTTP error. */
export const buildResultSchema = z.object({
  /** No error diagnostics and, when reloaded, state `active`. */
  ok: z.boolean(),
  durationMs: z.number().min(0),
  diagnostics: z.array(buildDiagnosticSchema),
  /** Trust pin written by this build (null when the build failed). */
  hash: trustPinSchema.nullable(),
  /** State after the optional reload. */
  state: pluginStateSchema,
})
export type BuildResult = z.infer<typeof buildResultSchema>
