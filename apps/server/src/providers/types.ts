// Frozen interfaces of model resolution, provider management and brand icons (ARCHITECTURE.md 6.6,
// PROVIDERS.md, API.md 5.5 / 5.8). Implementations (W1.4): `createProviderService(deps)` in `providers/index.ts`,
// `createIconService(deps)` in `providers/icons.ts`.
//
// Phase 6 additions (P6-0b, implemented by W6.2): `ResolvedModelBase`, `ResolvedImageModel`, `ResolvedAudioModel` and
// the resolvers `resolveImageModel` (ADR-028, ARCHITECTURE.md 6.11), `resolveTranscriptionModel` and
// `resolveSpeechModel` (ADR-029, ARCHITECTURE.md 6.12). `ResolvedModel` keeps its members (it now extends the base).
import type { ModelInfo, ProviderDefinition, ProviderRuntime } from '@harness-forge/plugin-sdk'
import type { CatalogModel, HarnessError, HarnessErrorInit, IconRef, LobeIconList, ProviderSummary, ProviderTestResult } from '@harness-forge/shared'
import type { ImageModel, LanguageModel, SpeechModel, TranscriptionModel } from 'ai'
import type { RegisteredProvider } from '../registry/types.ts'

/** An AI SDK model instance (never a string id: a string would be routed to the Vercel AI Gateway). */
export type LanguageModelInstance = Exclude<LanguageModel, string>

/** An AI SDK image model instance for `generateImage` (never a string id). */
export type ImageModelInstance = Exclude<ImageModel, string>

/** An AI SDK transcription model instance for `transcribe` (never a string id). */
export type TranscriptionModelInstance = Exclude<TranscriptionModel, string>

/** An AI SDK speech model instance for `generateSpeech` (never a string id). */
export type SpeechModelInstance = Exclude<SpeechModel, string>

/**
 * The fields every resolved model shares (chat, image, transcription and speech models). Credentials are applied
 * inside the model instance of the extending type; a resolved model is never serialized.
 */
export interface ResolvedModelBase {
  /** `providerId:modelId` (split on the first `:`). */
  modelRef: string
  providerId: string
  modelId: string
  /**
   * Effective metadata (catalog merge) as `ModelInfo`: input of `ProviderDefinition.reasoning()`, `imageParams()` and
   * hooks.
   */
  info: ModelInfo
  /** The catalog entry (kind, capabilities, context window, efforts, cost, alias, voices). */
  entry: CatalogModel
  /** The registered provider: its definition (factories, `imageParams`, `transcriptionOptions`, `mapError`) and owner. */
  provider: RegisteredProvider
}

/** A chat model resolved for a call (`resolveModel`). */
export interface ResolvedModel extends ResolvedModelBase {
  model: LanguageModelInstance
}

/** An image model resolved for a call (`resolveImageModel`, ADR-028): input of `ImageService.generate`. */
export interface ResolvedImageModel extends ResolvedModelBase {
  /** From `ProviderDefinition.createImageModel`. */
  imageModel: ImageModelInstance
}

/**
 * A transcription or speech model resolved for a call (`resolveTranscriptionModel` / `resolveSpeechModel`, ADR-029):
 * `model` comes from `ProviderDefinition.createTranscriptionModel` / `createSpeechModel`.
 */
export interface ResolvedAudioModel<M extends TranscriptionModelInstance | SpeechModelInstance> extends ResolvedModelBase {
  model: M
}

/** A resolved `kind: 'transcription'` model (dictation). */
export type ResolvedTranscriptionModel = ResolvedAudioModel<TranscriptionModelInstance>

/** A resolved `kind: 'speech'` model (read-aloud). */
export type ResolvedSpeechModel = ResolvedAudioModel<SpeechModelInstance>

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
   *
   * Phase 6 (ADR-028, implemented by W6.2): an image model (`entry.kind === 'image'`) is refused with
   * `validation_error`; image models resolve through `resolveImageModel` (the chat pipeline picks the resolver from the
   * catalog kind).
   */
  readonly resolveModel: (modelRef: string, options?: ResolveModelOptions) => Promise<ResolvedModel>
  /**
   * An image model for `generateImage` (ADR-028, ARCHITECTURE.md 6.11; implemented by W6.2). The checks of
   * `resolveModel` in the same order (unknown provider -> `not_found`; disabled provider or missing required
   * credentials -> `provider_not_configured`, action `configure-provider`, before any network call; unknown catalog
   * entry -> `model_not_found`, action `refresh-models`), then:
   * - a model whose `entry.kind` is not `image` -> `validation_error` (the model named);
   * - a provider without `createImageModel` -> `model_not_found` (its image models are not offered);
   * - a throwing factory, a timeout (5 s guard) or a value that is not an image model instance -> `plugin_error` of the
   *   owner plugin (`details.pluginId`).
   */
  readonly resolveImageModel: (modelRef: string, options?: ResolveModelOptions) => Promise<ResolvedImageModel>
  /**
   * A transcription model for `transcribe` (dictation, ADR-029, ARCHITECTURE.md 6.12; implemented by W6.2). The checks
   * of `resolveModel` in the same order (`not_found`, `provider_not_configured`, `model_not_found` as above), then:
   * - a model whose `entry.kind` is not `transcription` -> `validation_error` (the model named);
   * - a provider without `createTranscriptionModel` -> `validation_error` (the model named; the catalog leaves such
   *   listing / seed / models.dev entries out, e.g. `alibaba:qwen3-asr-flash`, so this is reached by a custom model);
   * - a throwing factory, a timeout (5 s guard) or a value that is not a transcription model instance -> `plugin_error`.
   */
  readonly resolveTranscriptionModel: (modelRef: string, options?: ResolveModelOptions) => Promise<ResolvedTranscriptionModel>
  /**
   * A speech model for `generateSpeech` (read-aloud, ADR-029, ARCHITECTURE.md 6.12; implemented by W6.2). Same rules
   * as `resolveTranscriptionModel` with `kind: 'speech'` and `createSpeechModel` (wrong kind or missing factory ->
   * `validation_error`; a failing factory -> `plugin_error`).
   */
  readonly resolveSpeechModel: (modelRef: string, options?: ResolveModelOptions) => Promise<ResolvedSpeechModel>
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
