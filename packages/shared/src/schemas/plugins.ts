// Plugin DTOs: list, detail, settings, logs, install and trust, drafts, files and build (API.md sections 4.10-4.13).
import { z } from 'zod'
import { logLevelSchema, pluginKindSchema, pluginSourceSchema, pluginStateSchema, pluginTemplateIdSchema } from '../enums.ts'
import { harnessErrorInitSchema } from '../errors.ts'
import {
  agentNameSchema,
  commandNameSchema,
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
import { declarativeProviderSchema, fieldKeySchema, modelInfoSchema } from './plugin-data.ts'
import { pluginManifestBaseSchema } from './plugin-manifest.ts'
import { settingsKeySchema, settingsSchemaSchema } from './plugin-settings.ts'
import { credentialValuesSchema } from './providers.ts'

// ---------- list and detail (4.10) ----------

export const pluginContributionsSchema = z.object({
  providers: z.array(providerIdSchema),
  /** Contributed models (manifest + `ctx.models.register`). */
  models: z.int().min(0),
  tools: z.array(toolNameSchema),
  /** Declared MCP server ids. */
  mcpServers: z.array(z.string()),
  commands: z.array(commandNameSchema),
  /** `HookMap` keys with at least one handler. */
  hooks: z.array(z.string()),
  /** Agent types (manifest + `ctx.agents.register`; plugin API 1.4.0). */
  agents: z.array(agentNameSchema),
  /** Skills (manifest + `ctx.skills.register`; plugin API 1.4.0). */
  skills: z.array(agentNameSchema),
})
export type PluginContributions = z.infer<typeof pluginContributionsSchema>

/** A trust pin: lowercase hex SHA-256, or `path:` + SHA-256 of the folder realpath for linked folders. */
export const trustPinSchema = z.string().regex(/^(?:path:)?[\da-f]{64}$/, 'Expected a SHA-256 pin.')
export type TrustPin = z.infer<typeof trustPinSchema>

export const pluginTrustSchema = z.object({
  /** Code plugin, or declares a stdio MCP server. */
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
  source: pluginSourceSchema,
  /** npm spec, URL, linked path, or zip file name. */
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

export const pluginInstallSourceSchema = z.discriminatedUnion('source', [
  z.strictObject(npmInstallSourceShape),
  z.strictObject(urlInstallSourceShape),
  z.strictObject(pathInstallSourceShape),
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
  z.strictObject({ ...npmInstallSourceShape, ...installOptionsShape }),
  z.strictObject({ ...urlInstallSourceShape, ...installOptionsShape }),
  z.strictObject({ ...pathInstallSourceShape, ...installOptionsShape }),
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
})
export type PluginInstallForm = z.infer<typeof pluginInstallFormSchema>

export const pluginInspectionSchema = z.object({
  manifest: pluginManifestBaseSchema,
  kind: pluginKindSchema,
  /** `zip`, `npm`, `url`, `link` or `copy`. */
  source: pluginSourceSchema,
  /** Resolved source reference shown in "I trust <source>" (e.g. `name@1.2.3` for npm, the URL, the folder path). */
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
