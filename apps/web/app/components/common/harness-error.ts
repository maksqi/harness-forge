// Presentation rules for HarnessError envelopes (docs/UI.md 7.4, docs/API.md section 2).
// `toHarnessErrorView` is a local stand-in for `toHarnessError()` (utils/errors.ts, C5) and follows the
// `HarnessError.from()` rules of @harness-forge/shared; the view type is structurally a `HarnessErrorInit`.

export interface HarnessErrorView {
  code: string
  message: string
  status?: number
  providerId?: string
  retryAfterMs?: number
  action?: string
  details?: unknown
}

export type HarnessErrorUiAction = 'configure-provider' | 'refresh-models' | 'login' | 'retry' | 'view-logs'

export const GENERIC_ERROR_MESSAGE = 'An unexpected error occurred. Try again.'

const ENVELOPE_ACTIONS = new Set<string>(['configure-provider', 'refresh-models', 'login', 'retry'])

export const errorActionLabels: Record<HarnessErrorUiAction, string> = {
  'configure-provider': 'Open settings',
  'refresh-models': 'Refresh models',
  'login': 'Log in',
  'retry': 'Retry',
  'view-logs': 'View logs',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function fromInit(value: unknown): HarnessErrorView | null {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string')
    return null
  const view: HarnessErrorView = { code: value.code, message: value.message }
  if (typeof value.status === 'number')
    view.status = value.status
  if (typeof value.providerId === 'string')
    view.providerId = value.providerId
  if (typeof value.retryAfterMs === 'number' && value.retryAfterMs >= 0)
    view.retryAfterMs = value.retryAfterMs
  if (typeof value.action === 'string')
    view.action = value.action
  if (value.details !== undefined)
    view.details = value.details
  return view
}

function fromEnvelope(value: unknown): HarnessErrorView | null {
  return isRecord(value) ? fromInit(value.error) : null
}

function fromJson(text: unknown): HarnessErrorView | null {
  if (typeof text !== 'string' || !text.trimStart().startsWith('{'))
    return null
  try {
    const parsed: unknown = JSON.parse(text)
    return fromEnvelope(parsed) ?? fromInit(parsed)
  }
  catch {
    return null
  }
}

/** Normalizes anything thrown or stored as an error into a displayable HarnessError shape. */
export function toHarnessErrorView(input: unknown): HarnessErrorView {
  const direct = fromInit(input) ?? fromEnvelope(input) ?? fromJson(input)
  if (direct)
    return direct
  if (input instanceof Error) {
    const withBody = input as Error & { responseBody?: unknown }
    const nested = fromJson(input.message) ?? fromJson(withBody.responseBody)
    if (nested)
      return nested
  }
  return { code: 'internal_error', message: GENERIC_ERROR_MESSAGE }
}

const TITLES: Record<string, string> = {
  provider_not_configured: 'No API key for {provider}',
  auth_invalid: '{provider} rejected the API key',
  rate_limited: 'Rate limited by {provider}',
  model_not_found: 'Model not found',
  context_overflow: 'This chat no longer fits the model\'s context',
  provider_unreachable: 'Can\'t reach {provider}',
  provider_error: '{provider} returned an error',
  plugin_error: 'A plugin failed',
  internal_error: 'Something went wrong',
  validation_error: 'Some values are not valid',
  unauthorized: 'Log in to continue',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  conflict: 'Could not complete the request',
  payload_too_large: 'Too large',
  not_implemented: 'Not available yet',
}

function conflictReason(error: HarnessErrorView): string | undefined {
  return isRecord(error.details) && typeof error.details.reason === 'string' ? error.details.reason : undefined
}

/** One-line title; `{provider}` becomes the provider name, else the provider id, else "the provider". */
export function errorTitle(error: HarnessErrorView, providerName?: string): string {
  if (error.code === 'conflict' && conflictReason(error) === 'run-active')
    return 'A response is already running in this chat.'
  const template = TITLES[error.code] ?? TITLES.internal_error!
  const provider = providerName || error.providerId || 'the provider'
  const title = template.replace('{provider}', provider)
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/** Plugin id from `details.pluginId` (plugin_error), when known. */
export function errorPluginId(error: HarnessErrorView): string | undefined {
  return isRecord(error.details) && typeof error.details.pluginId === 'string' ? error.details.pluginId : undefined
}

/** Actions to offer: the envelope `action` wins over the per-code defaults (docs/UI.md 7.4). */
export function errorActions(error: HarnessErrorView): HarnessErrorUiAction[] {
  if (error.action && ENVELOPE_ACTIONS.has(error.action))
    return [error.action as HarnessErrorUiAction]
  switch (error.code) {
    case 'provider_not_configured':
    case 'auth_invalid':
      return ['configure-provider']
    case 'model_not_found':
      return ['refresh-models']
    case 'rate_limited':
    case 'provider_unreachable':
    case 'provider_error':
    case 'internal_error':
      return ['retry']
    case 'plugin_error':
      return errorPluginId(error) ? ['view-logs'] : ['retry']
    case 'unauthorized':
      return ['login']
    default:
      return []
  }
}

/** Short upstream text or other details worth showing under a "Details" toggle, as plain text. */
export function errorDetailsText(error: HarnessErrorView): string | null {
  if (error.details === undefined || error.details === null)
    return null
  if (isRecord(error.details) && typeof error.details.upstream === 'string')
    return error.details.upstream
  try {
    return JSON.stringify(error.details, null, 2)
  }
  catch {
    return null
  }
}
