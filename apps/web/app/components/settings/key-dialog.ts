// ProviderKeyDialog rules (docs/UI.md 9.2, docs/API.md 4.4): one input per credential field, main fields first and
// advanced ones in a collapsible section. Secrets are write-only: the dialog never receives a stored secret (only
// its masked hint), so a secret input always starts empty and only typed values are sent.
import type {
  CredentialField,
  CredentialState,
  ProviderSummary,
  ProviderTestResult,
  SecretSource,
} from '@harness-forge/shared'
import { httpUrlSchema, LIMITS } from '@harness-forge/shared'
import { formatModelCount } from './providers'

export interface CredentialFieldView {
  key: string
  label: string
  type: CredentialField['type']
  secret: boolean
  required: boolean
  advanced: boolean
  /** Choices of a `select` field. */
  options: string[]
  /** `CredentialField.default` (e.g. the default base URL), or null. */
  defaultValue: string | null
  /** Where the resolved value comes from; null when nothing resolves (the default may still apply). */
  source: SecretSource | null
  /** Masked hint of a resolved secret, e.g. `sk-ant-…9fQ2`. */
  hint: string | null
  /** Environment variables that can provide the value, in order. */
  envVars: string[]
  /** Starting input value: always '' for secrets; the stored override (or the select choice) otherwise. */
  initial: string
  placeholder: string
}

/** A link shown next to a field label ("Get a key", "Learn more"). */
export interface FieldLink {
  href: string
  label: string
  /** The provider's key page (`data-testid="key-get-link"`). */
  getKey: boolean
}

/** Only absolute http(s) links from the server are rendered. */
export function safeLink(url: string | null | undefined): string | null {
  return url && httpUrlSchema.safeParse(url).success ? url : null
}

function envVarsOf(field: CredentialField): string[] {
  if (!field.envVar)
    return []
  return Array.isArray(field.envVar) ? [...field.envVar] : [field.envVar]
}

function placeholderOf(field: CredentialField, state: CredentialState | undefined): string {
  const origin = state?.source === 'env' ? 'from env' : 'stored'
  if (field.type === 'secret') {
    if (state?.set)
      return `${state.hint || '••••••••'} · ${origin}`
    return field.required ? 'Paste your key…' : 'Optional'
  }
  if (state?.source === 'env' && state.value)
    return `${state.value} · from env`
  return field.default ?? (field.type === 'url' ? 'https://…' : '')
}

function initialOf(field: CredentialField, state: CredentialState | undefined): string {
  if (field.type === 'secret')
    return ''
  const stored = state?.source === 'stored' ? state.value ?? '' : ''
  if (field.type === 'select')
    return stored || field.default || field.options?.[0] || ''
  return stored
}

/** Display model of every credential field of a provider, in declaration order. */
export function credentialFieldViews(provider: ProviderSummary): CredentialFieldView[] {
  return provider.credentialFields.map((field) => {
    const state = provider.credentials[field.key]
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      secret: field.type === 'secret',
      required: field.required === true,
      advanced: field.advanced === true,
      options: field.options ? [...field.options] : [],
      defaultValue: field.default ?? null,
      source: state?.source ?? null,
      hint: field.type === 'secret' ? state?.hint ?? null : null,
      envVars: envVarsOf(field),
      initial: initialOf(field, state),
      placeholder: placeholderOf(field, state),
    }
  })
}

/** The fields shown up front and the ones inside "Advanced". */
export function splitFieldViews(views: readonly CredentialFieldView[]): {
  main: CredentialFieldView[]
  advanced: CredentialFieldView[]
} {
  return { main: views.filter(view => !view.advanced), advanced: views.filter(view => view.advanced) }
}

/** Links next to field labels: the provider key page on the primary field, `helpUrl` pages on the others. */
export function fieldLinks(provider: ProviderSummary): Record<string, FieldLink> {
  const links: Record<string, FieldLink> = {}
  const fields = provider.credentialFields
  const primary = fields.find(field => field.type === 'secret' && !field.advanced) ?? fields.find(field => !field.advanced)
  for (const field of fields) {
    if (field === primary) {
      const secret = field.type === 'secret'
      const href = safeLink(secret ? field.helpUrl ?? provider.keyUrl : provider.keyUrl ?? field.helpUrl)
      if (href)
        links[field.key] = { href, label: secret ? 'Get a key' : provider.local ? 'Download' : 'Learn more', getKey: secret }
      continue
    }
    const href = safeLink(field.helpUrl)
    if (href)
      links[field.key] = { href, label: 'Learn more', getKey: false }
  }
  return links
}

/** "ANTHROPIC_API_KEY", "A or B", "A, B or C". */
export function formatEnvVars(names: readonly string[]): string {
  if (names.length === 0)
    return 'a variable'
  if (names.length === 1)
    return names[0]!
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

/** Notice under a field whose value comes from the server environment. */
export function envNotice(view: Pick<CredentialFieldView, 'envVars' | 'secret'>): string {
  const what = view.secret ? 'A key' : 'A value'
  return `Using ${formatEnvVars(view.envVars)} from the server environment. ${what} saved here takes priority.`
}

/** A non-secret field whose stored value replaces the default ("Reset" goes back to the default). */
export function isOverridden(view: CredentialFieldView): boolean {
  return !view.secret && view.source === 'stored'
}

/** The dialog can offer "Remove key": a secret is stored on the server (env values are not removable). */
export function hasStoredSecret(views: readonly CredentialFieldView[]): boolean {
  return views.some(view => view.secret && view.source === 'stored')
}

/**
 * Values to send (`PUT /providers/:id/credentials`, `POST /providers/:id/test`): typed secrets, and non-secret
 * fields that differ from their starting value (`''` clears a stored override). `baseline` holds the starting values
 * captured when the dialog opened, so a provider update arriving meanwhile is not mistaken for an edit.
 */
export function changedValues(
  views: readonly CredentialFieldView[],
  draft: Readonly<Record<string, string>>,
  baseline: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const view of views) {
    const start = (baseline[view.key] ?? view.initial).trim()
    const value = (draft[view.key] ?? start).trim()
    if (view.secret) {
      if (value)
        values[view.key] = value
    }
    else if (value !== start) {
      values[view.key] = value
    }
  }
  return values
}

/** Per-field problems that block Test and Save (keyed by field key). */
export function draftErrors(views: readonly CredentialFieldView[], draft: Readonly<Record<string, string>>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const view of views) {
    const value = (draft[view.key] ?? '').trim()
    if (value.length > LIMITS.credentialValueMaxChars)
      errors[view.key] = `Use at most ${LIMITS.credentialValueMaxChars} characters.`
    else if (view.type === 'url' && value && !httpUrlSchema.safeParse(value).success)
      errors[view.key] = 'Enter a URL that starts with http:// or https://.'
  }
  return errors
}

/** "Connected · 23 models · 380 ms". */
export function testSuccessText(result: Pick<ProviderTestResult, 'latencyMs' | 'modelCount'>): string {
  const parts = ['Connected']
  if (result.modelCount !== undefined)
    parts.push(formatModelCount(result.modelCount))
  parts.push(`${Math.round(result.latencyMs)} ms`)
  return parts.join(' · ')
}

/** Stable identity of a set of draft values, so a passing test can be reused by Save. */
export function valuesSignature(values: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.keys(values).sort().map(key => [key, values[key]]))
}
