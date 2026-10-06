// Marketplace DTOs (Phase 12, ADR-054; API.md section 4.33): the sources a marketplace is read from (a GitHub
// repository, a hosted `marketplace.json`, a folder on the server host), the summaries, entries and details of
// `/marketplaces`, the suggestion card and the `marketplace.changed` event. A `marketplace.json` is parsed only by
// `parseMarketplaceJson` (`util/claude-plugins.ts`); the server stores the normalized catalog.
import { z } from 'zod'
import { marketplaceEntrySourceKindSchema } from '../enums.ts'
import { harnessErrorInitSchema } from '../errors.ts'
import { marketplaceIdSchema, pluginIdSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { hasControlChars } from '../util/text.ts'
import { parseHttpUrl } from '../util/url.ts'

// ---------- names, repositories and refs ----------

/** A marketplace name (`name` of `marketplace.json`): 1..64 characters of `[A-Za-z0-9._-]` (unique per server). */
export const MARKETPLACE_NAME_PATTERN = /^[\w.-]{1,64}$/

export const marketplaceNameSchema = z.string().regex(MARKETPLACE_NAME_PATTERN, 'Marketplace names use 1-64 characters of A-Z, a-z, 0-9, ".", "_" and "-".')
export type MarketplaceName = z.infer<typeof marketplaceNameSchema>

/**
 * Marketplace names that only repositories of the `anthropics` GitHub owner may use (ADR-054, against impersonation):
 * these three and every name starting with `anthropic-`.
 */
export const RESERVED_MARKETPLACE_NAMES = ['claude-plugins-official', 'claude-code-plugins', 'claude-community'] as const

/** The GitHub owner whose repositories may use the reserved marketplace names. */
export const OFFICIAL_MARKETPLACE_OWNER = 'anthropics'

/** True for a reserved marketplace name (`RESERVED_MARKETPLACE_NAMES` or the prefix `anthropic-`), any case. */
export function isReservedMarketplaceName(name: string): boolean {
  const lower = name.toLowerCase()
  return (RESERVED_MARKETPLACE_NAMES as readonly string[]).includes(lower) || lower.startsWith('anthropic-')
}

/**
 * A GitHub repository `owner/repo`: the owner 1..39 characters of `[A-Za-z0-9-]` (no leading `-`), the repository 1..100
 * characters of `[A-Za-z0-9._-]` (not `.` or `..`). A trailing `.git` is removed by the shorthand parser, not here.
 */
export const GITHUB_REPO_PATTERN = /^[\dA-Z][\dA-Z-]{0,38}\/(?!\.{1,2}$)[\w.-]{1,100}$/i

export const githubRepoSchema = z.string().regex(GITHUB_REPO_PATTERN, 'Expected a GitHub repository "owner/repo".')
export type GithubRepo = z.infer<typeof githubRepoSchema>

/**
 * A git ref (a branch, a tag or a commit sha) as GitHub resolves it: 1..255 characters of `[A-Za-z0-9._/-]`, no leading
 * `/` or `-`; `isGitRef` also refuses `..`, `//` and a trailing `/`.
 */
export const GIT_REF_PATTERN = /^[\w.][\w./-]{0,254}$/

/** True for a safe git ref (`GIT_REF_PATTERN`, no `..`, no `//`, no trailing `/`). */
export function isGitRef(value: string): boolean {
  return GIT_REF_PATTERN.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
}

export const gitRefSchema = z.string().refine(isGitRef, 'Expected a branch, tag or commit (A-Z, a-z, 0-9, ".", "_", "-", "/"; no "..").')
export type GitRef = z.infer<typeof gitRefSchema>

/** A full git commit sha: 40 lowercase hex characters. */
export const COMMIT_SHA_PATTERN = /^[\da-f]{40}$/

export const commitShaSchema = z.string().regex(COMMIT_SHA_PATTERN, 'Expected a 40-character lowercase hex commit sha.')
export type CommitSha = z.infer<typeof commitShaSchema>

/**
 * A relative folder inside a repository or an archive (the GitHub install source `path`, a marketplace entry path):
 * 1..512 characters, POSIX segments without `.`, `..`, empty segments, a leading `/`, backslashes or control characters.
 */
export const repoSubpathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    value => !hasControlChars(value) && !value.includes('\\') && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
    'Use a relative folder path without ".", ".." or empty segments.',
  )
export type RepoSubpath = z.infer<typeof repoSubpathSchema>

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Z]:[\\/]/i.test(value) || value.startsWith('\\\\')
}

// ---------- sources ----------

/**
 * Where a marketplace is read from (ADR-054), discriminated on `type` (`marketplaceSourceTypeSchema` in `enums.ts`): `github` (the
 * `.claude-plugin/marketplace.json` of the commit `ref` resolves to; default: the default branch), `url` (an https URL of
 * a hosted `marketplace.json`) or `path` (an absolute folder on the server host that holds
 * `.claude-plugin/marketplace.json`).
 */
export const marketplaceSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('github'),
    repo: githubRepoSchema,
    ref: gitRefSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('url'),
    url: z.string().max(2048).refine(value => parseHttpUrl(value, { protocols: ['https:'] }) !== null, 'Expected an https:// URL without credentials.'),
  }),
  z.strictObject({
    type: z.literal('path'),
    path: z
      .string()
      .min(1)
      .max(LIMITS.workspacePathMaxChars)
      .refine(value => isAbsoluteHostPath(value) && !hasControlChars(value), 'Expected an absolute folder path.'),
  }),
])
export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>

/**
 * Body of `POST /marketplaces` (strict): the marketplace is fetched at once; nothing is stored when that fails. A name
 * that is taken is `409` (`exists`), a reserved name from another owner `400`, `HF_OFFLINE=1` `409` (`offline`) for a
 * `github` or `url` source, more than 50 marketplaces `409`.
 */
export const marketplaceAddBodySchema = z.strictObject({
  source: marketplaceSourceSchema,
})
export type MarketplaceAddBody = z.infer<typeof marketplaceAddBodySchema>

// ---------- summary, entries, detail ----------

/**
 * A problem of a marketplace or of a Claude Code plugin (ADR-053 / ADR-054): never an error of the request. `code` is a
 * code of the reader that found it (`CLAUDE_PLUGIN_DIAGNOSTIC_CODES`, a hook, definition or `.mcp.json` diagnostic code);
 * the message is one English sentence that never quotes a command, a secret or a file's contents.
 */
export const claudeDiagnosticSchema = z.object({
  level: z.enum(['error', 'warning', 'info']),
  code: z.string().min(1).max(64),
  message: z.string().max(1000),
  /** The component it is about (`commands`, `hooks`, `mcpServers`, `plugins[3]`, …). */
  component: z.string().max(256).optional(),
  /** Plugin- or marketplace-relative file, when it came from one. */
  path: z.string().max(LIMITS.workspacePathMaxChars).optional(),
})
export type ClaudeDiagnostic = z.infer<typeof claudeDiagnosticSchema>

/** One marketplace (`GET /marketplaces` items, the `marketplace.changed` event). */
export const marketplaceSummarySchema = z.object({
  id: marketplaceIdSchema,
  /** `name` of the `marketplace.json` (unique). */
  name: marketplaceNameSchema,
  /** `description` of the `marketplace.json`, when any. */
  description: z.string().max(1000).nullable(),
  /** `owner.name` of the `marketplace.json`, when any. */
  owner: z.string().max(200).nullable(),
  source: marketplaceSourceSchema,
  /**
   * What the stored catalog was read from: the 40-character commit (`github`), the SHA-256 of the fetched
   * `marketplace.json` (`url`); null for `path` sources (read again on every refresh).
   */
  resolvedRef: z.string().max(64).nullable(),
  /** Entries of the stored catalog (supported or not). */
  plugins: z.int().min(0),
  /** Installed plugins of this marketplace with an update available. */
  updates: z.int().min(0),
  /** The last successful fetch; null before the first one. */
  fetchedAt: timestampSchema.nullable(),
  /** The last failed refresh (the stored catalog stays usable); null after a success. */
  lastError: harnessErrorInitSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type MarketplaceSummary = z.infer<typeof marketplaceSummarySchema>

/** One plugin entry of a marketplace (`MarketplaceDetail.entries`). */
export const marketplaceEntrySchema = z.object({
  /** The entry `name` (the installed plugin id is derived from it, ADR-053). */
  name: z.string().min(1).max(128),
  description: z.string().max(1000).nullable(),
  /** The entry `version` as written (any string); null when the entry has none. */
  version: z.string().max(128).nullable(),
  category: z.string().max(64).nullable(),
  /** `tags` (and `keywords`) of the entry, at most 20. */
  tags: z.array(z.string().min(1).max(64)).max(20),
  author: z.string().max(200).nullable(),
  /** Where the plugin comes from: the classified source kind and one display line (`owner/repo@ref`, a URL, `./path`). */
  source: z.object({
    kind: marketplaceEntrySourceKindSchema,
    text: z.string().max(512),
  }),
  /** This harness can install the source (`relative`, `github`, `archive`, `npm` with the default registry). */
  supported: z.boolean(),
  /** One English sentence when `supported` is false. */
  unsupportedReason: z.string().max(300).optional(),
  /** The installed plugin of this entry (its origin names this marketplace and entry); null when not installed. */
  installedPluginId: pluginIdSchema.nullable(),
  /** The entry version differs from the installed one (else, without versions, the commit differs). */
  updateAvailable: z.boolean(),
})
export type MarketplaceEntry = z.infer<typeof marketplaceEntrySchema>

/** `GET /marketplaces/:id`, `POST /marketplaces`, `POST /marketplaces/:id/refresh`: a marketplace with its entries. */
export const marketplaceDetailSchema = marketplaceSummarySchema.extend({
  entries: z.array(marketplaceEntrySchema).max(LIMITS.marketplaceEntriesMax),
  /** Problems of the `marketplace.json` (dropped entries, unknown fields, unsupported sources), at most 200. */
  diagnostics: z.array(claudeDiagnosticSchema).max(LIMITS.claudePluginDiagnosticsMax),
})
export type MarketplaceDetail = z.infer<typeof marketplaceDetailSchema>

/** A marketplace the UI offers as a card before anything is fetched (a click adds it; no request before). */
export const marketplaceSuggestionSchema = z.object({
  /** The `marketplace.json` name the source is expected to have. */
  name: marketplaceNameSchema,
  title: z.string().max(100),
  description: z.string().max(300),
  source: marketplaceSourceSchema,
})
export type MarketplaceSuggestion = z.infer<typeof marketplaceSuggestionSchema>

/** The suggestions of `GET /marketplaces` (ADR-054): only the official Claude Code marketplace. */
export const MARKETPLACE_SUGGESTIONS: readonly MarketplaceSuggestion[] = Object.freeze([
  Object.freeze({
    name: 'claude-plugins-official',
    title: 'Claude Code plugins',
    description: 'The official Claude Code plugin marketplace by Anthropic.',
    source: Object.freeze({ type: 'github', repo: 'anthropics/claude-plugins-official' }) as MarketplaceSource,
  }),
])

/**
 * An installed plugin whose marketplace entry changed after a refresh (Phase 12, ADR-054): the entry version differs
 * from the installed one (else, without versions, the commit). An update is a new inspect → install of the same entry.
 */
export const pluginUpdateSchema = z.object({
  pluginId: pluginIdSchema,
  marketplaceId: marketplaceIdSchema,
  /** The marketplace entry name. */
  plugin: z.string().min(1).max(128),
  /** The installed version as written; null when unknown. */
  version: z.string().max(128).nullable(),
  /** The entry version after the last refresh; null when the entry has none (compared by commit). */
  availableVersion: z.string().max(128).nullable(),
})
export type PluginUpdate = z.infer<typeof pluginUpdateSchema>

/**
 * `GET /marketplaces`: every marketplace, the suggestions that are not added yet (matched by name or source) and the
 * plugins with an update available (also counted per marketplace).
 */
export const marketplaceListSchema = z.object({
  items: z.array(marketplaceSummarySchema).max(LIMITS.marketplacesMax),
  suggestions: z.array(marketplaceSuggestionSchema).max(10),
  updates: z.array(pluginUpdateSchema).max(1000),
})
export type MarketplaceList = z.infer<typeof marketplaceListSchema>

/** `/marketplaces/:id`. */
export const marketplaceParamsSchema = z.object({ id: marketplaceIdSchema })
export type MarketplaceParams = z.infer<typeof marketplaceParamsSchema>

// ---------- event ----------

/** Data of `marketplace.changed` (ADR-054): the marketplace after the change; `marketplace: null` = it was removed. */
export const marketplaceChangedDataSchema = z.object({
  id: marketplaceIdSchema,
  marketplace: marketplaceSummarySchema.nullable(),
})
export type MarketplaceChangedData = z.infer<typeof marketplaceChangedDataSchema>
