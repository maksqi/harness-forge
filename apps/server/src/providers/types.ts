// Frozen interfaces of model resolution, provider management and brand icons (ARCHITECTURE.md 6.6,
// PROVIDERS.md, API.md 5.5 / 5.8). Implementations (W1.4): `createProviderService(deps)` in `providers/index.ts`,
// `createIconService(deps)` in `providers/icons.ts`.
import type { ModelInfo, ProviderDefinition, ProviderRuntime } from '@harness-forge/plugin-sdk'
import type { CatalogModel, HarnessError, HarnessErrorInit, IconRef, LobeIconList, ProviderSummary, ProviderTestResult } from '@harness-forge/shared'
import type { LanguageModel } from 'ai'
import type { RegisteredProvider } from '../registry/types.ts'

/** An AI SDK model instance (never a string id: a string would be routed to the Vercel AI Gateway). */
export type LanguageModelInstance = Exclude<LanguageModel, string>

/** A model ref resolved for a call (credentials are applied inside `model`; never serialized). */
export interface ResolvedModel {
  modelRef: string
  providerId: string
  modelId: string
  model: LanguageModelInstance
  /** Effective metadata (catalog merge) as `ModelInfo`: input of `ProviderDefinition.reasoning()` and hooks. */
  info: ModelInfo
  /** The catalog entry (capabilities, context window, efforts, cost, alias). */
  entry: CatalogModel
  provider: RegisteredProvider
}

export interface ResolveModelOptions {
  /** The run signal (passed to the provider runtime). */
  signal?: AbortSignal
}

/** Outcome of a provider call reported by the chat pipeline (drives status / `lastError`). */
export type ProviderCallOutcome = { ok: true } | { ok: false, error: HarnessErrorInit }

/**
 * Registered providers joined with `provider_configs`, credentials and the catalog. Every change emits
 * `provider.changed` (and `catalog.changed` when models appear or disappear).
 */
export interface ProviderService {
  /** Every registered provider (enabled or not) in registry order. */
  readonly list: () => Promise<ProviderSummary[]>
  /** `not_found`. */
  readonly get: (id: string) => Promise<ProviderSummary>
  /** `provider_configs.enabled` (default true); false for an unknown id. */
  readonly isEnabled: (id: string) => Promise<boolean>
  /** Persists `enabled`; `not_found`. */
  readonly setEnabled: (id: string, enabled: boolean) => Promise<ProviderSummary>
  /**
   * Credential test (`validate()`, else `listModels`, else a 1-token ping on `smallModelId`; 15 s). With `values`
   * (candidate credentials merged over the stored ones) nothing is persisted; without, `validatedAt` / `lastError` are
   * stored. A failure is `ok: false`, not a throw. `not_found`.
   */
  readonly test: (id: string, values?: Record<string, string>) => Promise<ProviderTestResult>
  /**
   * `providerId:modelId` (split on the first `:`) -> registered and enabled provider (`not_found` /
   * `provider_not_configured`) -> credentials (missing required -> `provider_not_configured`, action
   * `configure-provider`, before any network call) -> catalog entry (unknown -> `model_not_found`, action
   * `refresh-models`) -> guarded `createLanguageModel`.
   */
  readonly resolveModel: (modelRef: string, options?: ResolveModelOptions) => Promise<ResolvedModel>
  /** The runtime handed to a provider definition (resolved credentials, host `fetch`, signal). `not_found`. */
  readonly runtime: (providerId: string, options?: ResolveModelOptions) => Promise<ProviderRuntime>
  /**
   * Maps an error of a provider call (API.md 2.3): `definition.mapError` first, then 401/403 -> `auth_invalid`, 429 ->
   * `rate_limited` (+ `retryAfterMs`), 404 -> `model_not_found`, context length -> `context_overflow`, network ->
   * `provider_unreachable`, else `provider_error`; sets `providerId` and the upstream `status`. Never throws.
   */
  readonly mapError: (providerId: string, error: unknown) => HarnessError
  /** Records the outcome of a call (status, `lastError`); emits `provider.changed` when the status changes. */
  readonly recordOutcome: (providerId: string, outcome: ProviderCallOutcome) => Promise<void>
}

/** `@lobehub/icons-static-svg` icons served by `GET /icons/lobe[/:slug]` (PROVIDERS.md 10). */
export interface IconService {
  /** Package version: the `?v=` cache buster of icon URLs and `LobeIconList.version`. */
  readonly version: string
  /** Mono slugs sorted, `hasColor` when `<slug>-color` exists. */
  readonly list: () => Promise<LobeIconList>
  /** SVG markup of a slug read from the package directory only, or null for an unknown slug. */
  readonly read: (slug: string) => Promise<string | null>
  /**
   * `IconRef` (server URLs with `?v=<version>`) of a LobeHub icon spec, keeping only variants that exist; null when none
   * does (monogram fallback) or the spec is not a `lobe:` reference (plugin file icons are resolved by the host):
   * - `lobe:<slug>`: color `<slug>-color`, mono `<slug>`; `lobe:<x>-color`: color `<x>-color`, mono `<x>`;
   * - `{ color?: 'lobe:<a>', mono?: 'lobe:<b>' }` (mono and color slugs differ, e.g. Z.ai): each slug as given.
   */
  readonly lobeRef: (icon: LobeIconSpec) => IconRef
}

/** An icon spec of a `ProviderDefinition` or manifest (`lobe:<slug>`, a file path, or a color / mono pair). */
export type LobeIconSpec = NonNullable<ProviderDefinition['icon']>
