// Provider matrix of the opt-in live provider suite (ADR-027, PROVIDERS.md 12): which builtin providers run, with which
// key variable and which model. The variable names come from `credentials[].envVar` of `PROVIDER_DEFINITIONS` (aliases
// included, the first non-empty one wins, exactly like the credential service resolves them); Ollama runs when its
// local listing answers within 1 s. Key values only ever reach the in-process test app of their own provider: every
// report names the variable, never its value.
//
// The media matrix (`HF_LIVE_MEDIA=1`, PROVIDERS.md 12 / 13): per provider the image model (the cheapest one; a chat
// model with image output for Google and OpenRouter), the speech model and every transcription seed, each check run
// only with the provider's key and only when the provider serves that kind (`createImageModel` / `imageParams`,
// `createSpeechModel`, `createTranscriptionModel`).
import type { ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { LiveMediaCheckId } from './summary.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { parseEnv } from 'node:util'
import { PROVIDER_DEFINITIONS } from '../builtin-plugins/core-providers/index.ts'
import { classifyId, providerServesKind } from '../catalog/classify.ts'
import { findWorkspaceRoot, serverPackageRoot } from '../paths.ts'
import { envVarNames } from '../services/secrets/credentials.ts'

/** Raw environment variables (`process.env` merged with the repository `.env`). */
export type LiveEnv = Readonly<Record<string, string | undefined>>

/** The keyless builtin provider that runs against a local server. */
export const OLLAMA_PROVIDER_ID = 'ollama'
/** Listing of the local Ollama server; the suite runs Ollama only when it answers. */
export const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags'
export const OLLAMA_PROBE_TIMEOUT_MS = 1000
/** `HF_LIVE_MAX_COST_USD` default: the budget of one run in USD. */
export const DEFAULT_LIVE_BUDGET_USD = 0.5
/** `HF_LIVE_PROVIDERS=none` runs nothing (a dry run that still prints the summary). */
export const NO_PROVIDERS = 'none'

/** A builtin provider as the suite sees it. */
export interface LiveProviderSpec {
  readonly providerId: string
  /** Credential field of the required secret (`apiKey`); null for a keyless provider. */
  readonly keyField: string | null
  /** Key variables in resolution order (the first non-empty one wins); empty for a keyless provider. */
  readonly envVars: readonly string[]
  /** `smallModelId`; null when the provider has none (Ollama: the model comes from its local listing). */
  readonly modelId: string | null
}

/** A provider that runs: its key variable (null when keyless) and the model of the chat checks. */
export interface LiveRunEntry {
  readonly status: 'run'
  readonly providerId: string
  readonly keyField: string | null
  readonly envVars: readonly string[]
  readonly envVar: string | null
  /** The key value: passed to the provider's own test app only, never printed. */
  readonly key: string | null
  readonly modelId: string
}

/** A provider that does not run, and why (no key, not selected, Ollama not answering). */
export interface LiveSkipEntry {
  readonly status: 'skip'
  readonly providerId: string
  readonly keyField: string | null
  readonly envVars: readonly string[]
  readonly modelId: string | null
  readonly reason: string
}

export type LiveMatrixEntry = LiveRunEntry | LiveSkipEntry

/** Result of the Ollama probe: the model names of its listing, or why it is not used. */
export type OllamaProbe
  = | { readonly reachable: true, readonly models: readonly string[] }
    | { readonly reachable: false, readonly reason: string }

export interface LiveMatrixInput {
  readonly specs: readonly LiveProviderSpec[]
  readonly env: LiveEnv
  /** Provider ids to run; null = every provider. */
  readonly filter: ReadonlySet<string> | null
  /** Null when Ollama was not probed (not selected). */
  readonly ollama: OllamaProbe | null
}

/** Every builtin provider in registry order, with its key variables from `credentials[].envVar`. */
export function liveProviderSpecs(definitions: readonly ProviderDefinition[] = PROVIDER_DEFINITIONS): LiveProviderSpec[] {
  return definitions.map((definition) => {
    const keyField = definition.credentials.find(field => field.type === 'secret' && field.required === true)
    return {
      providerId: definition.id,
      keyField: keyField?.key ?? null,
      envVars: keyField === undefined ? [] : envVarNames(keyField),
      modelId: definition.smallModelId ?? null,
    }
  })
}

/** The first variable of `names` with a non-empty (trimmed) value, as the credential service resolves it. */
export function findKey(names: readonly string[], env: LiveEnv): { name: string, value: string } | null {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value)
      return { name, value }
  }
  return null
}

/**
 * `HF_LIVE_PROVIDERS`: a comma list of provider ids (case-insensitive), `none` for a dry run; unset or empty = every
 * provider. Unknown ids throw, so a typo never silently runs nothing.
 */
export function parseProviderFilter(value: string | undefined, knownIds: readonly string[]): ReadonlySet<string> | null {
  const ids = (value ?? '').split(',').map(id => id.trim().toLowerCase()).filter(id => id !== '')
  if (ids.length === 0)
    return null
  if (ids.length === 1 && ids[0] === NO_PROVIDERS)
    return new Set()
  const unknown = ids.filter(id => !knownIds.includes(id))
  if (unknown.length > 0)
    throw new Error(`HF_LIVE_PROVIDERS: unknown provider id ${unknown.map(id => `"${id}"`).join(', ')}; use a comma list of ${knownIds.join(', ')} (or ${NO_PROVIDERS}).`)
  return new Set(ids)
}

/** `HF_LIVE_MAX_COST_USD`: a non-negative number of US dollars (default 0.50). */
export function parseLiveBudget(value: string | undefined): number {
  const text = value?.trim() ?? ''
  if (text === '')
    return DEFAULT_LIVE_BUDGET_USD
  if (!/^\d+(?:\.\d+)?$/.test(text))
    throw new Error('HF_LIVE_MAX_COST_USD must be a non-negative number of US dollars, for example 0.50.')
  return Number(text)
}

/** Flag values of `HF_LIVE_MEDIA`, as the server reads its own flags (`env.ts`). */
const TRUE_FLAGS: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on'])
const FALSE_FLAGS: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off'])

/**
 * `HF_LIVE_MEDIA`: `1` adds the image and voice checks, unset / empty / `0` keeps the chat checks only. Any other value
 * throws, so a typo never silently changes what runs (or what is paid for).
 */
export function parseLiveMediaFlag(value: string | undefined): boolean {
  const text = value?.trim().toLowerCase() ?? ''
  if (text === '' || FALSE_FLAGS.has(text))
    return false
  if (TRUE_FLAGS.has(text))
    return true
  throw new Error('HF_LIVE_MEDIA must be 1 (add the image and voice checks) or 0 (chat checks only).')
}

/** Model names of an Ollama `/api/tags` body (`models[].name`, else `models[].model`). */
export function ollamaModelNames(body: unknown): string[] {
  const models = typeof body === 'object' && body !== null ? (body as { models?: unknown }).models : undefined
  if (!Array.isArray(models))
    return []
  return models.flatMap((entry: unknown) => {
    const record = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name : record.model
    return typeof name === 'string' && name.trim() !== '' ? [name.trim()] : []
  })
}

/** The first chat model of a local listing (embedding and other non-chat models are skipped), or null. */
export function pickOllamaModel(names: readonly string[]): string | null {
  return names.find(name => classifyId(name) === 'chat') ?? null
}

/** Asks the local Ollama server for its listing; unreachable when it does not answer within `timeoutMs`. */
export async function probeOllama(options: { fetch?: typeof globalThis.fetch, url?: string, timeoutMs?: number } = {}): Promise<OllamaProbe> {
  const url = options.url ?? OLLAMA_TAGS_URL
  const timeoutMs = options.timeoutMs ?? OLLAMA_PROBE_TIMEOUT_MS
  const fetchImpl = options.fetch ?? globalThis.fetch
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok)
      return { reachable: false, reason: `Ollama answered HTTP ${response.status} at ${url}` }
    return { reachable: true, models: ollamaModelNames(await response.json()) }
  }
  catch {
    return { reachable: false, reason: `no answer from ${url} within ${timeoutMs} ms` }
  }
}

function keylessEntry(spec: LiveProviderSpec, ollama: OllamaProbe | null): LiveMatrixEntry {
  const skip = (reason: string): LiveSkipEntry => ({ status: 'skip', providerId: spec.providerId, keyField: null, envVars: [], modelId: spec.modelId, reason })
  if (spec.providerId !== OLLAMA_PROVIDER_ID)
    return skip('keyless provider without a local probe')
  if (ollama === null)
    return skip('Ollama was not probed')
  if (!ollama.reachable)
    return skip(`Ollama is not running (${ollama.reason})`)
  const modelId = pickOllamaModel(ollama.models)
  if (modelId === null)
    return skip('the local Ollama listing has no chat model (run "ollama pull <model>")')
  return { status: 'run', providerId: spec.providerId, keyField: null, envVars: [], envVar: null, key: null, modelId }
}

/** One entry per provider, in the order of `specs`. Pure: the Ollama probe result is an input. */
export function buildLiveMatrix(input: LiveMatrixInput): LiveMatrixEntry[] {
  return input.specs.map((spec): LiveMatrixEntry => {
    const skip = (reason: string): LiveSkipEntry => ({ status: 'skip', providerId: spec.providerId, keyField: spec.keyField, envVars: spec.envVars, modelId: spec.modelId, reason })
    if (input.filter !== null && !input.filter.has(spec.providerId))
      return skip('not selected by HF_LIVE_PROVIDERS')
    if (spec.keyField === null)
      return keylessEntry(spec, input.ollama)
    const key = findKey(spec.envVars, input.env)
    if (key === null)
      return skip(`no key (set ${spec.envVars.join(' or ')})`)
    if (spec.modelId === null)
      return skip('the provider has no smallModelId')
    return { status: 'run', providerId: spec.providerId, keyField: spec.keyField, envVars: spec.envVars, envVar: key.name, key: key.value, modelId: spec.modelId }
  })
}

/** Builds the matrix from the environment; probes Ollama only when it is selected. */
export async function resolveLiveMatrix(env: LiveEnv, options: { specs?: readonly LiveProviderSpec[], probe?: () => Promise<OllamaProbe> } = {}): Promise<LiveMatrixEntry[]> {
  const specs = options.specs ?? liveProviderSpecs()
  const filter = parseProviderFilter(env.HF_LIVE_PROVIDERS, specs.map(spec => spec.providerId))
  const probeNeeded = specs.some(spec => spec.providerId === OLLAMA_PROVIDER_ID && (filter === null || filter.has(spec.providerId)))
  const ollama = probeNeeded ? await (options.probe ?? probeOllama)() : null
  return buildLiveMatrix({ specs, env, filter, ollama })
}

// ---------- the media matrix (HF_LIVE_MEDIA=1) ----------

/**
 * Where the image of an image check comes from: an image turn with a dedicated image model (`kind: 'image'`,
 * `createImageModel`), or a chat model with image output (`capabilities.imageOutput`, the provider's `imageParams`).
 */
export type LiveImageSource = 'image-model' | 'image-output'

export interface LiveImageChoice {
  readonly modelId: string
  readonly source: LiveImageSource
}

/** The image and speech model of a provider's media checks. */
export interface LiveMediaChoice {
  readonly image?: LiveImageChoice
  readonly speech?: string
}

/**
 * The model of each image and speech check (PROVIDERS.md 12 / 13): the cheapest seed of the kind (`gpt-image-1-mini`,
 * `gemini-2.5-flash-preview-tts`), the only one where a provider has one; Google and OpenRouter make images with the
 * image-output chat model `gemini-2.5-flash-image` of their live listings. Transcription checks use every
 * transcription seed (`liveMediaSpecs`).
 */
export const LIVE_MEDIA_MODELS: Readonly<Record<string, LiveMediaChoice>> = {
  openai: { image: { modelId: 'gpt-image-1-mini', source: 'image-model' }, speech: 'gpt-4o-mini-tts' },
  google: { image: { modelId: 'gemini-2.5-flash-image', source: 'image-output' }, speech: 'gemini-2.5-flash-preview-tts' },
  xai: { image: { modelId: 'grok-imagine-image', source: 'image-model' }, speech: 'tts' },
  mistral: { speech: 'voxtral-mini-tts-latest' },
  openrouter: { image: { modelId: 'google/gemini-2.5-flash-image', source: 'image-output' } },
}

/** The media checks of one provider (null / empty: the provider has no such check). */
export interface LiveMediaSpec {
  readonly providerId: string
  readonly image: LiveImageChoice | null
  readonly speech: string | null
  /** Every transcription seed (`kind: 'transcription'`), in seed order. */
  readonly transcription: readonly string[]
}

/** True when the provider can make the images of `source`. */
function servesImages(definition: ProviderDefinition, source: LiveImageSource): boolean {
  return source === 'image-model' ? providerServesKind(definition, 'image') : typeof definition.imageParams === 'function'
}

/**
 * Every provider (registry order) with the models of its media checks: the choices of `models` the provider can serve
 * (a choice whose factory is missing is dropped) and its transcription seeds when it has `createTranscriptionModel`.
 */
export function liveMediaSpecs(definitions: readonly ProviderDefinition[] = PROVIDER_DEFINITIONS, models: Readonly<Record<string, LiveMediaChoice>> = LIVE_MEDIA_MODELS): LiveMediaSpec[] {
  return definitions.map((definition) => {
    const choice = Object.hasOwn(models, definition.id) ? models[definition.id] : undefined
    const image = choice?.image !== undefined && servesImages(definition, choice.image.source) ? choice.image : null
    const speech = choice?.speech !== undefined && providerServesKind(definition, 'speech') ? choice.speech : null
    const transcription = providerServesKind(definition, 'transcription')
      ? (definition.seedModels ?? []).filter(model => model.kind === 'transcription').map(model => model.id)
      : []
    return { providerId: definition.id, image, speech, transcription }
  })
}

/**
 * Run order of the media checks: speech first (its audio clips are what the transcription checks transcribe), images
 * last (the most expensive checks, so a small budget still covers the voice checks).
 */
export const LIVE_MEDIA_RUN_ORDER: readonly LiveMediaCheckId[] = ['speech', 'transcription', 'image']

/** The models of one media check: the image or speech model, or every transcription model. */
export function mediaModelsOf(spec: LiveMediaSpec, kind: LiveMediaCheckId): string[] {
  switch (kind) {
    case 'image':
      return spec.image === null ? [] : [spec.image.modelId]
    case 'speech':
      return spec.speech === null ? [] : [spec.speech]
    case 'transcription':
      return [...spec.transcription]
  }
}

/** One media check of one provider. */
export interface LiveMediaCheckRef {
  readonly kind: LiveMediaCheckId
  readonly providerId: string
}

/** Every media check in run order (kind by kind, providers in registry order): one test each, known at collection. */
export function liveMediaChecks(specs: readonly LiveMediaSpec[] = liveMediaSpecs()): LiveMediaCheckRef[] {
  return LIVE_MEDIA_RUN_ORDER.flatMap(kind => specs
    .filter(spec => mediaModelsOf(spec, kind).length > 0)
    .map(spec => ({ kind, providerId: spec.providerId })))
}

interface LiveMediaEntryBase {
  readonly kind: LiveMediaCheckId
  readonly providerId: string
  /** Key variables of the provider, in resolution order. */
  readonly envVars: readonly string[]
  /** One model (image, speech) or every transcription model. */
  readonly modelIds: readonly string[]
  /** Image checks only; null otherwise. */
  readonly imageSource: LiveImageSource | null
}

/** A media check that runs: the key goes to the check's own test app only, never into a report. */
export interface LiveMediaRunEntry extends LiveMediaEntryBase {
  readonly status: 'run'
  readonly keyField: string
  readonly envVar: string
  readonly key: string
}

export interface LiveMediaSkipEntry extends LiveMediaEntryBase {
  readonly status: 'skip'
  readonly reason: string
}

export type LiveMediaEntry = LiveMediaRunEntry | LiveMediaSkipEntry

export interface LiveMediaMatrixInput {
  readonly media: readonly LiveMediaSpec[]
  readonly providers: readonly LiveProviderSpec[]
  readonly env: LiveEnv
  /** Provider ids to run (`HF_LIVE_PROVIDERS`); null = every provider. */
  readonly filter: ReadonlySet<string> | null
  /** `HF_LIVE_MEDIA=1`. */
  readonly enabled: boolean
}

/** One entry per media check, in run order. Pure: runs only when enabled, selected and the provider's key is set. */
export function buildLiveMediaMatrix(input: LiveMediaMatrixInput): LiveMediaEntry[] {
  const providers = new Map(input.providers.map(spec => [spec.providerId, spec]))
  const specs = new Map(input.media.map(spec => [spec.providerId, spec]))
  return liveMediaChecks(input.media).map(({ kind, providerId }): LiveMediaEntry => {
    const spec = specs.get(providerId)
    const provider = providers.get(providerId)
    const base: LiveMediaEntryBase = {
      kind,
      providerId,
      envVars: provider?.envVars ?? [],
      modelIds: spec === undefined ? [] : mediaModelsOf(spec, kind),
      imageSource: kind === 'image' ? spec?.image?.source ?? null : null,
    }
    const skip = (reason: string): LiveMediaSkipEntry => ({ status: 'skip', ...base, reason })
    if (!input.enabled)
      return skip('media checks are off (set HF_LIVE_MEDIA=1)')
    if (input.filter !== null && !input.filter.has(providerId))
      return skip('not selected by HF_LIVE_PROVIDERS')
    if (provider?.keyField === null || provider?.keyField === undefined)
      return skip('keyless provider')
    const key = findKey(provider.envVars, input.env)
    if (key === null)
      return skip(`no key (set ${provider.envVars.join(' or ')})`)
    return { status: 'run', ...base, keyField: provider.keyField, envVar: key.name, key: key.value }
  })
}

/** The media matrix from the environment (`HF_LIVE_MEDIA`, `HF_LIVE_PROVIDERS` and the keys); throws on bad values. */
export function resolveLiveMediaMatrix(env: LiveEnv, options: { media?: readonly LiveMediaSpec[], providers?: readonly LiveProviderSpec[] } = {}): LiveMediaEntry[] {
  const providers = options.providers ?? liveProviderSpecs()
  return buildLiveMediaMatrix({
    media: options.media ?? liveMediaSpecs(),
    providers,
    env,
    filter: parseProviderFilter(env.HF_LIVE_PROVIDERS, providers.map(spec => spec.providerId)),
    enabled: parseLiveMediaFlag(env.HF_LIVE_MEDIA),
  })
}

/** `<workspace root>/.env`, the file the server loads at start (`env.ts`). */
export function workspaceEnvFile(): string {
  return join(findWorkspaceRoot(serverPackageRoot()) ?? process.cwd(), '.env')
}

/** Variables of a `.env` file (Node's `.env` parser); `{}` when the file does not exist. Never changes `process.env`. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file))
    return {}
  const parsed = parseEnv(readFileSync(file, 'utf8'))
  return Object.fromEntries(Object.entries(parsed).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])))
}

/** Variables that are already set (even to an empty value) win over the `.env` file, as at server start. */
export function mergeEnv(current: LiveEnv, file: LiveEnv): Record<string, string | undefined> {
  return { ...file, ...current }
}

/** `process.env` over the repository `.env`. */
export function liveEnvironment(file: string = workspaceEnvFile()): Record<string, string | undefined> {
  return mergeEnv(process.env, readEnvFile(file))
}
