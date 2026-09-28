// Provider wizard model (docs/UI.md 8.5, docs/PLUGINS.md 4, docs/API.md 4.12): the values of the five steps, their
// validation with the shared zod schemas, the conversions values <-> manifest / draft / draft test, and the draft
// persisted in localStorage['hf-wizard-draft'] (without secret values). Pure TypeScript: no Vue, no network.
import type {
  ApiFormat,
  CredentialField,
  DeclarativeProvider,
  DraftTestRequest,
  ModelInfo,
  PluginDraft,
  PluginManifest,
  PluginManifestUpdate,
  ReasoningEffort,
  ReasoningStyle,
} from '@harness-forge/shared'
import type { ProviderTemplate } from './provider-templates'
import {
  applyDeclarativeProviderDefaults,
  DECLARATIVE_AUTH_DEFAULTS,
  FIELD_KEY_PATTERN,
  FORBIDDEN_PROVIDER_HEADERS,
  HTTP_HEADER_NAME_PATTERN,
  httpUrlSchema,
  ICON_SLUG_PATTERN,
  isReservedPluginId,
  LIMITS,
  modelIdSchema,
  pluginDraftSchema,
  pluginIdSchema,
  pluginManifestUpdateSchema,
  REASONING_STYLES_BY_API_FORMAT,
  templateKeys,
} from '@harness-forge/shared'
import { z } from 'zod'
import { readStoredJson, writeStoredJson } from '~/utils/storage'

// ---------- steps ----------

export const WIZARD_STEPS = ['basics', 'api', 'credentials', 'models', 'review'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

export const STEP_TITLES: Readonly<Record<WizardStep, string>> = {
  basics: 'Basics',
  api: 'API',
  credentials: 'Credentials',
  models: 'Models',
  review: 'Review',
}

export const STEP_DESCRIPTIONS: Readonly<Record<WizardStep, string>> = {
  basics: 'Name the provider and pick its icon.',
  api: 'Choose the wire format and where the API lives.',
  credentials: 'Describe the key and how it is sent.',
  models: 'Fetch the models the API offers or add them by hand.',
  review: 'Check the manifest, test the connection and create the provider.',
}

// ---------- values ----------

export type IconMode = 'upload' | 'lobe' | 'monogram'
export type AuthStyle = 'bearer' | 'header' | 'none'
export type ModelEffort = Exclude<ReasoningEffort, 'auto'>

export const MODEL_EFFORTS: readonly ModelEffort[] = ['off', 'low', 'medium', 'high', 'max']

export interface WizardIconFile {
  name: 'icon.svg' | 'icon.png'
  base64: string
  /** Decoded size in bytes. */
  size: number
}

export interface WizardCredentialField {
  key: string
  label: string
  type: CredentialField['type']
  required: boolean
  /** Not for secrets; '' = no default. */
  default: string
  /** `select` options, comma-separated. */
  options: string
  helpUrl: string
  advanced: boolean
}

export interface WizardHeader {
  name: string
  value: string
}

export interface WizardModel {
  id: string
  name: string
  /** As typed: "128000", "128K", "1M" or ''. */
  contextWindow: string
  maxOutputTokens: string
  tools: boolean
  vision: boolean
  reasoning: boolean
  pdf: boolean
  efforts: ModelEffort[]
  /** USD per 1M tokens as typed: "0.60" or ''. */
  inputCost: string
  outputCost: string
}

export interface WizardValues {
  // Basics
  name: string
  id: string
  /** The id was typed by the user (it no longer follows the name). */
  idEdited: boolean
  description: string
  iconMode: IconMode
  lobeSlug: string
  iconFile: WizardIconFile | null
  /** Edit mode: the file icon the plugin already has ('' = none). */
  iconExisting: string
  // API
  /** The template applied last ('' = none). */
  template: string
  /** Edit mode: the provider id of the manifest ('' = the plugin id). */
  providerId: string
  apiFormat: ApiFormat
  baseURL: string
  reasoningStyle: ReasoningStyle
  modelsDevId: string
  // Credentials
  authStyle: AuthStyle
  authHeader: string
  credentials: WizardCredentialField[]
  headers: WizardHeader[]
  /** Values for the draft test; saved as provider credentials on create, never in plugin.json. */
  credentialValues: Record<string, string>
  // Models
  listModels: boolean
  listInclude: string
  listExclude: string
  /** Edit mode: a custom listing path of the manifest ('' = /models). */
  listPath: string
  models: WizardModel[]
  smallModelId: string
}

export function apiKeyField(overrides: Partial<WizardCredentialField> = {}): WizardCredentialField {
  return { key: 'apiKey', label: 'API key', type: 'secret', required: true, default: '', options: '', helpUrl: '', advanced: false, ...overrides }
}

export function emptyCredentialField(): WizardCredentialField {
  return { key: '', label: '', type: 'text', required: false, default: '', options: '', helpUrl: '', advanced: false }
}

export function emptyModel(id = ''): WizardModel {
  return {
    id,
    name: '',
    contextWindow: '',
    maxOutputTokens: '',
    tools: false,
    vision: false,
    reasoning: false,
    pdf: false,
    efforts: [],
    inputCost: '',
    outputCost: '',
  }
}

export function defaultWizardValues(): WizardValues {
  return {
    name: '',
    id: '',
    idEdited: false,
    description: '',
    iconMode: 'monogram',
    lobeSlug: '',
    iconFile: null,
    iconExisting: '',
    template: '',
    providerId: '',
    apiFormat: 'openai-chat',
    baseURL: '',
    reasoningStyle: 'openai-effort',
    modelsDevId: '',
    authStyle: 'bearer',
    authHeader: 'x-api-key',
    credentials: [apiKeyField()],
    headers: [],
    credentialValues: {},
    listModels: true,
    listInclude: '',
    listExclude: '',
    listPath: '',
    models: [],
    smallModelId: '',
  }
}

// ---------- API formats ----------

export interface ApiFormatOption {
  value: ApiFormat
  label: string
  description: string
  /** Request path appended to the base URL. */
  path: string
  /** Base URL placeholder. */
  placeholder: string
}

export const API_FORMATS: readonly ApiFormatOption[] = [
  { value: 'openai-chat', label: 'OpenAI-compatible', description: 'Chat Completions: most gateways and local servers.', path: '/chat/completions', placeholder: 'https://api.example.com/v1' },
  { value: 'openai-responses', label: 'OpenAI Responses', description: 'The OpenAI Responses API and compatible proxies.', path: '/responses', placeholder: 'https://api.example.com/v1' },
  { value: 'anthropic', label: 'Anthropic-compatible', description: 'Messages API. The base URL includes the version.', path: '/messages', placeholder: 'https://api.example.com/anthropic/v1' },
  { value: 'google', label: 'Google', description: 'Gemini generateContent API.', path: '/models/{model}:streamGenerateContent', placeholder: 'https://generativelanguage.googleapis.com/v1beta' },
]

export function apiFormatOption(format: ApiFormat): ApiFormatOption {
  return API_FORMATS.find(option => option.value === format) ?? API_FORMATS[0]!
}

export const REASONING_STYLE_LABELS: Readonly<Record<ReasoningStyle, string>> = {
  'openai-effort': 'Reasoning effort (reasoning_effort)',
  'anthropic-thinking': 'Extended thinking budget',
  'google-thinking': 'Gemini thinking level',
  'none': 'None',
}

/** The reasoning control that matches an API format (the first allowed style). */
export function defaultReasoningStyle(format: ApiFormat): ReasoningStyle {
  return REASONING_STYLES_BY_API_FORMAT[format][0]
}

function defaultAuth(format: ApiFormat): { authStyle: AuthStyle, authHeader?: string } {
  const auth = DECLARATIVE_AUTH_DEFAULTS[format]
  return auth.type === 'header' ? { authStyle: 'header', authHeader: auth.header } : { authStyle: auth.type }
}

/**
 * Switches the API format: the reasoning control follows when it does not fit the new format, and the auth style
 * follows when it still is the previous format's default (a custom choice is kept).
 */
export function changeApiFormat(values: WizardValues, format: ApiFormat): WizardValues {
  const next: WizardValues = { ...values, apiFormat: format }
  const allowed: readonly ReasoningStyle[] = REASONING_STYLES_BY_API_FORMAT[format]
  if (!allowed.includes(values.reasoningStyle))
    next.reasoningStyle = defaultReasoningStyle(format)
  const previous = defaultAuth(values.apiFormat)
  const isDefault = values.authStyle === previous.authStyle && (previous.authStyle !== 'header' || values.authHeader === previous.authHeader)
  if (isDefault) {
    const auth = defaultAuth(format)
    next.authStyle = auth.authStyle
    if (auth.authHeader)
      next.authHeader = auth.authHeader
  }
  return next
}

/** Switches the auth style: `none` drops an untouched default key field, the others bring one back when missing. */
export function changeAuthStyle(values: WizardValues, style: AuthStyle): WizardValues {
  let credentials = values.credentials
  if (style === 'none' && credentials.length === 1 && isUntouchedApiKey(credentials[0]!))
    credentials = []
  if (style !== 'none' && !credentials.some(field => field.key === 'apiKey'))
    credentials = [apiKeyField(), ...credentials]
  return { ...values, authStyle: style, credentials }
}

function isUntouchedApiKey(field: WizardCredentialField): boolean {
  return field.key === 'apiKey' && field.label === 'API key' && field.type === 'secret' && field.default === '' && field.options === '' && !field.advanced
}

// ---------- templates ----------

/**
 * Prefills everything a template knows. The name and id are taken only while the user has not named the provider;
 * the icon only while it is still the monogram; models and entered credential values are kept.
 */
export function applyTemplate(values: WizardValues, template: ProviderTemplate): WizardValues {
  const next: WizardValues = {
    ...values,
    template: template.id,
    apiFormat: template.apiFormat,
    baseURL: template.baseURL,
    reasoningStyle: template.reasoningStyle,
    modelsDevId: template.modelsDevId ?? '',
    authStyle: template.auth,
    authHeader: 'x-api-key',
    credentials: template.auth === 'none' ? [] : [apiKeyField({ required: template.apiKeyRequired, helpUrl: template.keyUrl ?? '' })],
    headers: [],
    listModels: true,
    listInclude: '',
    listExclude: template.listExclude ?? '',
    listPath: '',
  }
  if (values.name.trim() === '') {
    next.name = template.name
    if (!values.idEdited && values.providerId === '')
      next.id = template.id
  }
  if (values.iconMode === 'monogram' && template.icon) {
    next.iconMode = 'lobe'
    next.lobeSlug = template.icon
  }
  return next
}

// ---------- small parsers ----------

/** "Together AI" -> "together-ai": the plugin id suggested for a name. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

const TOKENS = /^(\d+(?:\.\d+)?)\s*([km])?$/i

/** "128000" -> 128000, "128K" -> 128000, "1.5M" -> 1500000; null when not a positive whole number. */
export function parseTokenCount(text: string): number | null {
  const match = text.trim().match(TOKENS)
  if (!match)
    return null
  const unit = match[2]?.toLowerCase()
  const value = Number(match[1]) * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1000 : 1)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

const PRICE = /^\$?\s*(\d+(?:\.\d+)?)$/

/** "0.60" or "$0.60" -> 0.6 (USD per 1M tokens); null when not a number >= 0. */
export function parsePrice(text: string): number | null {
  const match = text.trim().match(PRICE)
  if (!match)
    return null
  const value = Number(match[1])
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** "a, b ,c" -> ['a', 'b', 'c']. */
export function splitOptions(text: string): string[] {
  return text.split(',').map(option => option.trim()).filter(option => option !== '')
}

export function isHttpUrl(value: string): boolean {
  return httpUrlSchema.safeParse(value).success
}

/** A base URL: absolute http(s), no credentials, query or fragment (the provider schema's rule). */
export function isBaseUrl(value: string): boolean {
  return isHttpUrl(value) && !value.includes('?') && !value.includes('#')
}

/** Plain `http:` to a host that is not this machine: keys would travel unencrypted. */
export function isPlainHttpRemote(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return false
  }
  if (url.protocol !== 'http:')
    return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return !(host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host))
}

function isRegExpSource(value: string): boolean {
  try {
    void new RegExp(value, 'i')
    return true
  }
  catch {
    return false
  }
}

// ---------- values -> manifest ----------

/** The provider id: the plugin id, or the manifest's own provider id in edit mode. */
export function providerIdOf(values: WizardValues): string {
  return values.providerId || values.id
}

function toCredentialField(field: WizardCredentialField): CredentialField {
  const result: CredentialField = { key: field.key.trim(), label: field.label.trim() || field.key.trim(), type: field.type }
  if (field.required)
    result.required = true
  if (field.type !== 'secret' && field.default.trim() !== '')
    result.default = field.default.trim()
  if (field.type === 'select')
    result.options = splitOptions(field.options)
  if (field.helpUrl.trim() !== '')
    result.helpUrl = field.helpUrl.trim()
  if (field.advanced)
    result.advanced = true
  return result
}

export function toModelInfo(model: WizardModel): ModelInfo {
  const id = model.id.trim()
  const info: ModelInfo = { id }
  const name = model.name.trim()
  if (name !== '' && name !== id)
    info.name = name
  const contextWindow = parseTokenCount(model.contextWindow)
  if (contextWindow !== null)
    info.contextWindow = contextWindow
  const maxOutputTokens = parseTokenCount(model.maxOutputTokens)
  if (maxOutputTokens !== null)
    info.maxOutputTokens = maxOutputTokens
  info.capabilities = { tools: model.tools, vision: model.vision, reasoning: model.reasoning, pdf: model.pdf }
  // Offered efforts (the UI clears them when reasoning is turned off; a manifest may carry them anyway).
  if (model.efforts.length > 0)
    info.reasoningEfforts = MODEL_EFFORTS.filter(effort => model.efforts.includes(effort))
  const input = parsePrice(model.inputCost)
  const output = parsePrice(model.outputCost)
  if (input !== null || output !== null)
    info.cost = { ...(input === null ? {} : { input }), ...(output === null ? {} : { output }) }
  return info
}

/** The `DeclarativeProvider` the values describe. */
export function buildProvider(values: WizardValues): DeclarativeProvider {
  const include = values.listInclude.trim()
  const exclude = values.listExclude.trim()
  const path = values.listPath.trim()
  const headers = values.headers.filter(header => header.name.trim() !== '' || header.value !== '')
  const provider: DeclarativeProvider = {
    id: providerIdOf(values),
    name: values.name.trim(),
    baseURL: values.baseURL.trim(),
    apiFormat: values.apiFormat,
    auth: values.authStyle === 'header' ? { type: 'header', header: values.authHeader.trim() } : { type: values.authStyle },
    credentials: values.credentials.map(toCredentialField),
  }
  if (headers.length > 0)
    provider.headers = Object.fromEntries(headers.map(header => [header.name.trim(), header.value]))
  if (values.models.length > 0)
    provider.models = values.models.map(toModelInfo)
  provider.listModels = !values.listModels
    ? false
    : include || exclude || path
      ? { ...(path ? { path } : {}), ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) }
      : true
  if (values.reasoningStyle !== 'none')
    provider.reasoningStyle = values.reasoningStyle
  if (values.modelsDevId.trim() !== '')
    provider.modelsDevId = values.modelsDevId.trim()
  if (values.smallModelId.trim() !== '')
    provider.smallModelId = values.smallModelId.trim()
  return provider
}

/** `manifest.icon` of the values: `lobe:<slug>`, the uploaded (or existing) file name, or none (monogram). */
export function manifestIcon(values: WizardValues): string | undefined {
  if (values.iconMode === 'lobe' && values.lobeSlug !== '')
    return `lobe:${values.lobeSlug}`
  if (values.iconMode === 'upload')
    return values.iconFile?.name ?? (values.iconExisting || undefined)
  return undefined
}

/**
 * The plugin manifest of the values. In edit mode `base` is the current manifest: everything the wizard does not
 * edit (author, homepage, permissions, settings, other providers, models, MCP servers, commands) is kept.
 */
export function buildManifest(values: WizardValues, base?: PluginManifest | null): PluginManifest {
  const description = values.description.trim()
  const icon = manifestIcon(values)
  const otherProviders = (base?.contributes?.providers ?? []).slice(1)
  return {
    ...(base?.$schema === undefined ? {} : { $schema: base.$schema }),
    manifestVersion: 1,
    id: values.id,
    name: values.name.trim(),
    version: base?.version ?? '1.0.0',
    ...(description === '' ? {} : { description }),
    ...(base?.author === undefined ? {} : { author: base.author }),
    ...(base?.homepage === undefined ? {} : { homepage: base.homepage }),
    ...(icon === undefined ? {} : { icon }),
    engines: base?.engines ?? { harness: '^1.0.0' },
    ...(base?.permissions === undefined ? {} : { permissions: base.permissions }),
    ...(base?.settings === undefined ? {} : { settings: base.settings }),
    contributes: { ...base?.contributes, providers: [buildProvider(values), ...otherProviders] },
  }
}

/** The manifest as it will be written to plugin.json. */
export function manifestJson(values: WizardValues, base?: PluginManifest | null): string {
  return `${JSON.stringify(buildManifest(values, base), null, 2)}\n`
}

/** Entered credential values of declared fields (trimmed, non-empty). */
export function enteredCredentials(values: WizardValues): Record<string, string> {
  const entered: Record<string, string> = {}
  for (const field of values.credentials) {
    const key = field.key.trim()
    const value = (values.credentialValues[key] ?? '').trim()
    if (key !== '' && value !== '')
      entered[key] = value
  }
  return entered
}

/** `POST /plugins` body: manifest, uploaded icon, credentials (stored encrypted, never in plugin.json). */
export function buildDraft(values: WizardValues): PluginDraft {
  const credentials = enteredCredentials(values)
  return {
    manifest: buildManifest(values),
    ...(values.iconMode === 'upload' && values.iconFile ? { iconFile: { name: values.iconFile.name, base64: values.iconFile.base64 } } : {}),
    ...(Object.keys(credentials).length === 0 ? {} : { credentials: { [providerIdOf(values)]: credentials } }),
  }
}

/** `PUT /plugins/:id/manifest` body (edit mode). */
export function buildManifestUpdate(values: WizardValues, base: PluginManifest): PluginManifestUpdate {
  return {
    manifest: buildManifest(values, base),
    ...(values.iconMode === 'upload' && values.iconFile ? { iconFile: { name: values.iconFile.name, base64: values.iconFile.base64 } } : {}),
  }
}

/** `POST /plugins/drafts/test` body. */
export function buildTestRequest(values: WizardValues, action: DraftTestRequest['action'], modelId?: string): DraftTestRequest {
  const credentials = enteredCredentials(values)
  return {
    provider: buildProvider(values),
    ...(Object.keys(credentials).length === 0 ? {} : { credentials }),
    action,
    ...(modelId === undefined ? {} : { modelId }),
  }
}

/** The model the connection test pings: the small model, else the first model, else the first fetched one. */
export function pingModelId(values: WizardValues, fetched: readonly ModelInfo[] = []): string | null {
  const small = values.smallModelId.trim()
  if (small !== '')
    return small
  return values.models.find(model => model.id.trim() !== '')?.id.trim() ?? fetched[0]?.id ?? null
}

// ---------- manifest -> values (edit mode, fetched models) ----------

function fromCredentialField(field: CredentialField): WizardCredentialField {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required === true,
    default: field.default ?? '',
    options: (field.options ?? []).join(', '),
    helpUrl: field.helpUrl ?? '',
    advanced: field.advanced === true,
  }
}

/** A model row from a manifest model or a fetched listing entry. */
export function wizardModelFromInfo(info: ModelInfo): WizardModel {
  return {
    id: info.id,
    name: info.name ?? '',
    contextWindow: info.contextWindow === undefined ? '' : String(info.contextWindow),
    maxOutputTokens: info.maxOutputTokens === undefined ? '' : String(info.maxOutputTokens),
    tools: info.capabilities?.tools === true,
    vision: info.capabilities?.vision === true,
    reasoning: info.capabilities?.reasoning === true,
    pdf: info.capabilities?.pdf === true,
    efforts: (info.reasoningEfforts ?? []).filter((effort): effort is ModelEffort => effort !== 'auto'),
    inputCost: info.cost?.input === undefined ? '' : String(info.cost.input),
    outputCost: info.cost?.output === undefined ? '' : String(info.cost.output),
  }
}

/** Wizard values of an existing manifest (edit mode); the first declared provider is edited. */
export function valuesFromManifest(manifest: PluginManifest): WizardValues {
  const values: WizardValues = {
    ...defaultWizardValues(),
    name: manifest.name,
    id: manifest.id,
    idEdited: true,
    description: manifest.description ?? '',
  }
  const icon = manifest.icon
  if (icon?.startsWith('lobe:')) {
    values.iconMode = 'lobe'
    values.lobeSlug = icon.slice('lobe:'.length)
  }
  else if (icon !== undefined) {
    values.iconMode = 'upload'
    values.iconExisting = icon
  }
  const provider = manifest.contributes?.providers?.[0]
  if (!provider)
    return values
  const resolved = applyDeclarativeProviderDefaults(provider)
  const listing = resolved.listModels
  return {
    ...values,
    providerId: provider.id,
    apiFormat: provider.apiFormat,
    baseURL: provider.baseURL,
    reasoningStyle: resolved.reasoningStyle,
    modelsDevId: provider.modelsDevId ?? '',
    authStyle: resolved.auth.type,
    authHeader: resolved.auth.header ?? 'x-api-key',
    credentials: resolved.credentials.map(fromCredentialField),
    headers: Object.entries(resolved.headers).map(([name, value]) => ({ name, value })),
    listModels: listing !== false,
    listInclude: typeof listing === 'object' ? listing.include ?? '' : '',
    listExclude: typeof listing === 'object' ? listing.exclude ?? '' : '',
    listPath: typeof listing === 'object' ? listing.path ?? '' : '',
    models: resolved.models.map(wizardModelFromInfo),
    smallModelId: provider.smallModelId ?? '',
  }
}

// ---------- validation ----------

/** Validation messages by field path (`name`, `credentials.0.key`, `headers.1.value`, `models.2.id`, ...). */
export type WizardIssues = Record<string, string>

export interface WizardValidationContext {
  /** Ids of installed plugins (the new id must be free). */
  existingIds: ReadonlySet<string>
  /** Edit mode: the id is fixed and `base` is the current manifest. */
  editing: boolean
  base?: PluginManifest | null
}

/** The step a field path belongs to. */
export function stepOfPath(path: string): WizardStep {
  const head = path.split('.')[0] ?? ''
  if (['name', 'id', 'description', 'icon', 'iconFile'].includes(head))
    return 'basics'
  if (['baseURL', 'apiFormat', 'reasoningStyle', 'modelsDevId'].includes(head))
    return 'api'
  if (['authStyle', 'authHeader', 'credentials', 'headers', 'credentialValues'].includes(head))
    return 'credentials'
  if (['models', 'listModels', 'listInclude', 'listExclude', 'listPath', 'smallModelId'].includes(head))
    return 'models'
  return 'review'
}

/** Maps a server / schema issue path of a draft or manifest update to a wizard field path. */
export function wizardPathOfIssue(path: readonly (string | number)[], values: WizardValues): string {
  const [first, second, third, fourth, fifth] = path
  if (first === 'iconFile')
    return 'icon'
  if (first === 'credentials')
    return typeof third === 'string' ? `credentialValues.${third}` : 'credentials'
  if (first !== 'manifest')
    return 'manifest'
  if (second === 'id' || second === 'name' || second === 'description')
    return second
  if (second === 'icon')
    return 'icon'
  if (second !== 'contributes' || third !== 'providers' || fourth !== 0)
    return 'manifest'
  switch (fifth) {
    case 'name':
      return 'name'
    case 'id':
      return 'id'
    case 'baseURL':
    case 'reasoningStyle':
    case 'modelsDevId':
    case 'smallModelId':
      return fifth
    case 'auth':
      return 'authHeader'
    case 'credentials': {
      const index = path[5]
      const field = path[6]
      if (typeof index !== 'number')
        return 'credentials'
      return `credentials.${index}.${typeof field === 'string' && ['label', 'options', 'default', 'helpUrl'].includes(field) ? field : 'key'}`
    }
    case 'headers': {
      const name = path[5]
      const index = values.headers.findIndex(header => header.name.trim() === name)
      return index < 0 ? 'credentials' : `headers.${index}.value`
    }
    case 'models': {
      const index = path[5]
      const field = path[6]
      if (typeof index !== 'number')
        return 'models'
      const known: Record<string, string> = { name: 'name', contextWindow: 'contextWindow', maxOutputTokens: 'maxOutputTokens', cost: 'inputCost' }
      return `models.${index}.${typeof field === 'string' ? known[field] ?? 'id' : 'id'}`
    }
    case 'listModels':
      return path.includes('include') ? 'listInclude' : 'listExclude'
    default:
      return 'manifest'
  }
}

const HEADER_NAME_MESSAGE = 'Use letters, digits and "-" (an HTTP header name).'
const URL_MESSAGE = 'Use an absolute http:// or https:// URL.'

/** Every problem of the values, by field path, in the words of the wizard. */
export function validateWizard(values: WizardValues, context: WizardValidationContext): WizardIssues {
  const issues: WizardIssues = {}
  const add = (path: string, message: string): void => {
    if (!(path in issues))
      issues[path] = message
  }

  // Basics
  const name = values.name.trim()
  if (name === '')
    add('name', 'Enter a name.')
  else if (name.length > 64)
    add('name', 'Use at most 64 characters.')
  if (!context.editing) {
    const id = values.id
    if (id === '')
      add('id', 'Enter an id.')
    else if (!pluginIdSchema.safeParse(id).success)
      add('id', 'Use 1-40 characters of a-z, 0-9 and "-", not starting or ending with "-".')
    else if (isReservedPluginId(id))
      add('id', `"${id}" is reserved for built-in plugins.`)
    else if (context.existingIds.has(id))
      add('id', 'A plugin with this id already exists.')
  }
  if (values.description.trim().length > 280)
    add('description', 'Use at most 280 characters.')
  if (values.iconMode === 'upload' && !values.iconFile && values.iconExisting === '')
    add('icon', 'Choose an SVG or PNG file.')
  if (values.iconMode === 'lobe' && !ICON_SLUG_PATTERN.test(values.lobeSlug))
    add('icon', 'Pick an icon.')

  // API
  const baseURL = values.baseURL.trim()
  if (baseURL === '')
    add('baseURL', 'Enter the base URL of the API.')
  else if (!isBaseUrl(baseURL))
    add('baseURL', 'Use an absolute http:// or https:// URL without a query, fragment or credentials.')
  if (!(REASONING_STYLES_BY_API_FORMAT[values.apiFormat] as readonly ReasoningStyle[]).includes(values.reasoningStyle))
    add('reasoningStyle', 'Pick a reasoning control that fits the API format.')
  if (values.modelsDevId.trim().length > 64)
    add('modelsDevId', 'Use at most 64 characters.')

  // Credentials
  if (values.authStyle === 'header') {
    const header = values.authHeader.trim()
    if (header === '')
      add('authHeader', 'Enter the header name.')
    else if (!HTTP_HEADER_NAME_PATTERN.test(header))
      add('authHeader', HEADER_NAME_MESSAGE)
    else if ((FORBIDDEN_PROVIDER_HEADERS as readonly string[]).includes(header.toLowerCase()))
      add('authHeader', `"${header}" cannot be used.`)
  }
  const keys = values.credentials.map(field => field.key.trim())
  values.credentials.forEach((field, index) => {
    const key = keys[index] ?? ''
    if (key === '')
      add(`credentials.${index}.key`, 'Enter a key.')
    else if (!FIELD_KEY_PATTERN.test(key))
      add(`credentials.${index}.key`, 'Start with a letter; use letters, digits and "_".')
    else if (keys.indexOf(key) !== index)
      add(`credentials.${index}.key`, 'This key is already used.')
    if (field.label.trim() === '')
      add(`credentials.${index}.label`, 'Enter a label.')
    else if (field.label.trim().length > 100)
      add(`credentials.${index}.label`, 'Use at most 100 characters.')
    if (field.type === 'select') {
      const options = splitOptions(field.options)
      if (options.length === 0)
        add(`credentials.${index}.options`, 'Enter the options, separated by commas.')
      else if (new Set(options).size !== options.length)
        add(`credentials.${index}.options`, 'Options must be unique.')
      else if (field.default.trim() !== '' && !options.includes(field.default.trim()))
        add(`credentials.${index}.default`, 'The default must be one of the options.')
    }
    if (field.type === 'url' && field.default.trim() !== '' && !isHttpUrl(field.default.trim()))
      add(`credentials.${index}.default`, URL_MESSAGE)
    if (field.helpUrl.trim() !== '' && !isHttpUrl(field.helpUrl.trim()))
      add(`credentials.${index}.helpUrl`, URL_MESSAGE)
  })
  if (values.authStyle !== 'none' && !keys.includes('apiKey'))
    add('credentials', 'Add a field with the key "apiKey": its value is the key the authentication sends.')
  else if (values.credentials.length > 20)
    add('credentials', 'Use at most 20 fields.')
  const authHeader = values.authStyle === 'bearer' ? 'authorization' : values.authStyle === 'header' ? values.authHeader.trim().toLowerCase() : null
  const headerNames = values.headers.map(header => header.name.trim().toLowerCase())
  values.headers.forEach((header, index) => {
    const headerName = header.name.trim()
    const lower = headerName.toLowerCase()
    if (headerName === '')
      add(`headers.${index}.name`, 'Enter a header name.')
    else if (!HTTP_HEADER_NAME_PATTERN.test(headerName))
      add(`headers.${index}.name`, HEADER_NAME_MESSAGE)
    else if ((FORBIDDEN_PROVIDER_HEADERS as readonly string[]).includes(lower))
      add(`headers.${index}.name`, `"${headerName}" cannot be set.`)
    else if (lower === authHeader)
      add(`headers.${index}.name`, 'The authentication already sends this header.')
    else if (headerNames.indexOf(lower) !== index)
      add(`headers.${index}.name`, 'This header is already set.')
    if (/[\n\r]/.test(header.value))
      add(`headers.${index}.value`, 'Header values cannot contain line breaks.')
    const referenced = templateKeys(header.value, 'credentials')
    if (referenced === null)
      add(`headers.${index}.value`, 'Only {{credentials.<key>}} placeholders are allowed.')
    else if (referenced.some(key => !keys.includes(key)))
      add(`headers.${index}.value`, `Unknown credential "${referenced.find(key => !keys.includes(key))}".`)
  })
  for (const field of values.credentials) {
    const key = field.key.trim()
    const value = (values.credentialValues[key] ?? '').trim()
    if (key === '' || value === '')
      continue
    if (value.length > LIMITS.credentialValueMaxChars)
      add(`credentialValues.${key}`, `Use at most ${LIMITS.credentialValueMaxChars} characters.`)
    else if (field.type === 'url' && !isHttpUrl(value))
      add(`credentialValues.${key}`, URL_MESSAGE)
    else if (field.type === 'select' && !splitOptions(field.options).includes(value))
      add(`credentialValues.${key}`, 'Pick one of the options.')
  }

  // Models
  const ids = values.models.map(model => model.id.trim())
  values.models.forEach((model, index) => {
    const id = ids[index] ?? ''
    if (id === '')
      add(`models.${index}.id`, 'Enter the model id.')
    else if (!modelIdSchema.safeParse(id).success)
      add(`models.${index}.id`, 'Use up to 256 characters without line breaks.')
    else if (ids.indexOf(id) !== index)
      add(`models.${index}.id`, 'This model is already listed.')
    if (model.name.trim().length > 256)
      add(`models.${index}.name`, 'Use at most 256 characters.')
    for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
      if (model[key].trim() !== '' && parseTokenCount(model[key]) === null)
        add(`models.${index}.${key}`, 'Enter a number of tokens, e.g. 128000 or 128K.')
    }
    for (const key of ['inputCost', 'outputCost'] as const) {
      if (model[key].trim() !== '' && parsePrice(model[key]) === null)
        add(`models.${index}.${key}`, 'Enter a price in USD per 1M tokens, e.g. 0.60.')
    }
  })
  if (!values.listModels && values.models.length === 0)
    add('models', 'Add at least one model, or fetch the model list at runtime.')
  if (values.listModels) {
    for (const key of ['listInclude', 'listExclude'] as const) {
      const source = values[key].trim()
      if (source.length > 256)
        add(key, 'Use at most 256 characters.')
      else if (source !== '' && !isRegExpSource(source))
        add(key, 'Enter a valid regular expression.')
    }
  }
  const small = values.smallModelId.trim()
  if (small !== '' && !modelIdSchema.safeParse(small).success)
    add('smallModelId', 'Use up to 256 characters without line breaks.')

  // Safety net: whatever the shared schemas still refuse (the server validates with the same ones).
  if (Object.keys(issues).length === 0) {
    const parsed = context.editing && context.base
      ? pluginManifestUpdateSchema.safeParse(buildManifestUpdate(values, context.base))
      : pluginDraftSchema.safeParse(buildDraft(values))
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        add(wizardPathOfIssue(issue.path.filter((segment): segment is string | number => typeof segment !== 'symbol'), values), issue.message)
    }
  }
  return issues
}

/** Issues of one step, in field order. */
export function issuesOfStep(issues: WizardIssues, step: WizardStep): Array<[string, string]> {
  return Object.entries(issues).filter(([path]) => stepOfPath(path) === step)
}

/** The first step with a problem, or null. */
export function firstInvalidStep(issues: WizardIssues): WizardStep | null {
  return WIZARD_STEPS.find(step => issuesOfStep(issues, step).length > 0) ?? null
}

// ---------- draft persistence ----------

export const WIZARD_DRAFT_KEY = 'hf-wizard-draft'

export interface StoredWizardDraft {
  step: WizardStep
  values: WizardValues
}

const credentialFieldValuesSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['secret', 'text', 'url', 'select']),
  required: z.boolean(),
  default: z.string(),
  options: z.string(),
  helpUrl: z.string(),
  advanced: z.boolean(),
})

const modelValuesSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextWindow: z.string(),
  maxOutputTokens: z.string(),
  tools: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
  pdf: z.boolean(),
  efforts: z.array(z.enum(['off', 'low', 'medium', 'high', 'max'])),
  inputCost: z.string(),
  outputCost: z.string(),
})

/** Shape of a stored draft (a draft of another version or a tampered one is ignored field by field). */
const storedValuesSchema = z.object({
  name: z.string(),
  id: z.string(),
  idEdited: z.boolean(),
  description: z.string(),
  iconMode: z.enum(['upload', 'lobe', 'monogram']),
  lobeSlug: z.string(),
  iconFile: z.object({ name: z.enum(['icon.svg', 'icon.png']), base64: z.string(), size: z.number() }).nullable(),
  template: z.string(),
  apiFormat: z.enum(['openai-chat', 'openai-responses', 'anthropic', 'google']),
  baseURL: z.string(),
  reasoningStyle: z.enum(['openai-effort', 'anthropic-thinking', 'google-thinking', 'none']),
  modelsDevId: z.string(),
  authStyle: z.enum(['bearer', 'header', 'none']),
  authHeader: z.string(),
  credentials: z.array(credentialFieldValuesSchema).max(50),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).max(50),
  credentialValues: z.record(z.string(), z.string()),
  listModels: z.boolean(),
  listInclude: z.string(),
  listExclude: z.string(),
  models: z.array(modelValuesSchema).max(5000),
  smallModelId: z.string(),
}).partial()

/** The values that may be stored: secret credential values are dropped. */
export function persistableValues(values: WizardValues): WizardValues {
  const secretKeys = new Set(values.credentials.filter(field => field.type === 'secret').map(field => field.key.trim()))
  return {
    ...values,
    credentialValues: Object.fromEntries(Object.entries(values.credentialValues).filter(([key]) => !secretKeys.has(key))),
  }
}

/** Stores the draft of the create flow (never secret values). */
export function saveWizardDraft(step: WizardStep, values: WizardValues): boolean {
  const { iconExisting: _iconExisting, providerId: _providerId, listPath: _listPath, ...rest } = persistableValues(values)
  return writeStoredJson(WIZARD_DRAFT_KEY, { step, values: rest })
}

/** The stored draft merged over the defaults, or null when there is none (or it is unusable). */
export function loadWizardDraft(): StoredWizardDraft | null {
  const stored = readStoredJson(WIZARD_DRAFT_KEY)
  if (typeof stored !== 'object' || stored === null)
    return null
  const record = stored as { step?: unknown, values?: unknown }
  const parsed = storedValuesSchema.safeParse(record.values)
  if (!parsed.success)
    return null
  const step = WIZARD_STEPS.find(candidate => candidate === record.step) ?? 'basics'
  return { step, values: { ...defaultWizardValues(), ...parsed.data } }
}

export function clearWizardDraft(): void {
  try {
    globalThis.localStorage?.removeItem(WIZARD_DRAFT_KEY)
  }
  catch {
    // Storage may be unavailable (private mode); nothing was stored then.
  }
}

/** True when the values differ from a fresh wizard (worth keeping as a draft). */
export function hasDraftContent(values: WizardValues): boolean {
  return JSON.stringify(persistableValues(values)) !== JSON.stringify(defaultWizardValues())
}

// ---------- labels ----------

export function authSummary(values: WizardValues): string {
  if (values.authStyle === 'bearer')
    return 'Bearer token (Authorization header)'
  if (values.authStyle === 'header')
    return `Header ${values.authHeader.trim() || '(unnamed)'}`
  return 'No key'
}

/** Base64 of bytes (browser-safe, no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * Reads a chosen icon file: `.svg` or `.png` (by name or type), <= 256 KB, a PNG signature or an `<svg` element.
 * Throws an `Error` with a message for the user. The server sanitizes SVG files again (scripts, external refs).
 */
export async function readIconFile(file: File): Promise<WizardIconFile> {
  const name = file.name.toLowerCase()
  const kind = name.endsWith('.svg') || file.type === 'image/svg+xml'
    ? 'svg'
    : name.endsWith('.png') || file.type === 'image/png' ? 'png' : null
  if (kind === null)
    throw new Error('Choose an .svg or .png file.')
  if (file.size > LIMITS.iconFileBytes)
    throw new Error(`The icon is larger than ${LIMITS.iconFileBytes / 1024} KB.`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length === 0)
    throw new Error('The file is empty.')
  if (kind === 'png' && !(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47))
    throw new Error('This file is not a PNG image.')
  if (kind === 'svg' && !/<svg[\s>]/i.test(new TextDecoder().decode(bytes)))
    throw new Error('This file is not an SVG image.')
  return { name: kind === 'svg' ? 'icon.svg' : 'icon.png', base64: bytesToBase64(bytes), size: bytes.length }
}

/** A `data:` URL for the preview of an uploaded icon (rendered through <img>, never inlined). */
export function iconPreviewUrl(file: WizardIconFile): string {
  return `data:${file.name === 'icon.svg' ? 'image/svg+xml' : 'image/png'};base64,${file.base64}`
}
