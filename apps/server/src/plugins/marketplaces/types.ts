// Frozen interface of the marketplace service (Phase 12, ADR-054; API.md 4.33 / 5.34, ARCHITECTURE.md 6.34): Claude Code
// plugin marketplaces (`.claude-plugin/marketplace.json`) added from a GitHub repository, a hosted URL or a folder on the
// server, stored in the `marketplaces` table (`mkt_` ids, unique `name`) with their normalized catalog. Implementation:
// `createMarketplaceService(deps, options?)` in `plugins/marketplaces/index.ts` (C43 stub: an empty list with the
// suggestions; W12.2 implements the store, the GitHub resolution, the catalog, the entry sources and the updates).
// Consumers: the `marketplaces` routes (W12.2), the installer's `marketplace` source (W12.2, through the store of this
// folder) and shutdown (`stopDeps`: `stop()` after the checkpoints, before the plugins). Test double:
// `createFakeMarketplaceService` (`testing/fake-marketplaces.ts`), installed with `createTestApp({ marketplaces: 'fake' })`.
//
// There is no git anywhere: GitHub is read as HTTPS archives of a resolved commit, every request through `safeFetch`
// (https only, no private or loopback address, DNS pinned, every redirect re-checked; codeload without redirects); the
// hosts are the constants below (overridable only by tests); owner, repository and ref are validated before a URL is
// built. `HF_OFFLINE=1` refuses adding or refreshing a `github` / `url` marketplace (409 `offline`); a `path` marketplace
// still works. The test-only `HF_TEST_REMOTE_URL` reroutes the production `safeFetch` (`createPluginSourceFetch`,
// `security/ssrf.ts`), never these bases. Marketplaces are never in backups and are kept by delete-all. Logs carry the
// marketplace id, its name, the repository and a 12-character sha only (never the JSON).
import type { ClaudeMarketplace, ClaudePluginDiagnostic, MarketplaceAddBody, MarketplaceDetail, MarketplaceList } from '@harness-forge/shared'
import type { SafeFetch } from '../../security/types.ts'

/** The GitHub REST API base (`GET /repos/{owner}/{repo}/commits/{ref}` with `Accept: application/vnd.github.sha`). */
export const GITHUB_API_BASE = 'https://api.github.com'
/** Raw files of a commit: `/{owner}/{repo}/{sha}/{path}` (the `marketplace.json` of a GitHub marketplace). */
export const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com'
/** Repository zips of a commit: `/{owner}/{repo}/zip/{sha}` (no redirects), fallback `/zip/refs/heads/{ref}`. */
export const GITHUB_CODELOAD_BASE = 'https://codeload.github.com'

/**
 * Network overrides of the marketplace service (tests only; production uses the defaults). The same four overrides exist
 * on the installer's `InstallerOptions` (`plugins/install/index.ts`) for the `github` and `marketplace` install sources.
 */
export interface MarketplaceServiceOptions {
  /**
   * The guarded fetch of every marketplace request (default: the plugin-source fetch `deps.ts` builds with
   * `createPluginSourceFetch({ testRemoteUrl })`, else `safeFetch` of `security/ssrf.ts`); unit tests pass
   * `createFakeSafeFetch(routes)` (`testing/fake-remote.ts`).
   */
  readonly safeFetch?: SafeFetch
  /** Base URL of the GitHub API (default `GITHUB_API_BASE`). */
  readonly githubApi?: string
  /** Base URL of raw GitHub files (default `GITHUB_RAW_BASE`). */
  readonly githubRaw?: string
  /** Base URL of GitHub repository zips (default `GITHUB_CODELOAD_BASE`). */
  readonly githubCodeload?: string
}

/**
 * The catalog stored in `marketplaces.catalog` (JSON, at most `LIMITS.marketplaceJsonBytes`): the `marketplace.json`
 * as `parseMarketplaceJson` normalized it (entries classified, unknown keys dropped, at most
 * `LIMITS.marketplaceEntriesMax` entries) and the diagnostics of that parse. The entries' `overlay` objects (inline
 * `plugin.json` fields) stay on the server; the DTO entries (`MarketplaceEntry`) never carry them.
 */
export interface StoredMarketplaceCatalog {
  /** Layout version of the stored JSON (1). */
  readonly version: 1
  readonly marketplace: ClaudeMarketplace
  /** Problems of the `marketplace.json` (dropped entries, unknown fields, unsupported sources), at most 200. */
  readonly diagnostics: readonly ClaudePluginDiagnostic[]
}

/**
 * Marketplaces (ADR-054). Errors are `HarnessError`s the routes pass through (API.md 2 / 5.34). Every add, refresh and
 * remove emits `marketplace.changed { id, marketplace }` (`marketplace: null` after a remove); a refresh that changes
 * the update state of installed plugins also emits `plugin.changed` for them.
 */
export interface MarketplaceService {
  /**
   * `GET /marketplaces`: every stored marketplace (no network), the suggestions not added yet (`MARKETPLACE_SUGGESTIONS`,
   * matched by name or source; nothing is requested before the user adds one) and the installed plugins with an update
   * available after the last refresh.
   */
  readonly list: () => Promise<MarketplaceList>
  /**
   * `POST /marketplaces` (body validated by the route with `marketplaceAddBodySchema`): fetches the source at once (a
   * GitHub ref resolved to its commit) and stores the row only when that worked. Throws `validation_error` (an invalid
   * `marketplace.json`; a reserved name from a repository outside `anthropics/*`), `not_found` (no repository, ref or
   * file), `conflict` `exists` (the name is taken, or `LIMITS.marketplacesMax` marketplaces exist), `conflict` `offline`
   * (`HF_OFFLINE=1` for a `github` / `url` source), `payload_too_large`, `rate_limited` (`retryAfterMs` when known),
   * `provider_unreachable` / `provider_error` (the remote failed).
   */
  readonly add: (body: MarketplaceAddBody) => Promise<MarketplaceDetail>
  /** `GET /marketplaces/:id`: the stored catalog with each entry's install and update state. Throws `not_found`. */
  readonly get: (id: string) => Promise<MarketplaceDetail>
  /**
   * `POST /marketplaces/:id/refresh`: fetches the source again (a moved ref gives a new commit; a `path` source is read
   * again); a failure keeps the stored catalog, stores `lastError` and throws like `add`. Throws `not_found`.
   */
  readonly refresh: (id: string) => Promise<MarketplaceDetail>
  /** `DELETE /marketplaces/:id`: removes the row; the installed plugins are kept (their origin dangles). `not_found`. */
  readonly remove: (id: string) => Promise<void>
  /**
   * Shutdown (`stopDeps`, after the checkpoints and before the plugins): aborts the fetches in flight (an add then stores
   * nothing). Idempotent; never rejects.
   */
  readonly stop: () => Promise<void>
}
