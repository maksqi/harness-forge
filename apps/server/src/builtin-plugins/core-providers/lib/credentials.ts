// Credential fields of the builtin providers and runtime accessors (PROVIDERS.md section 2). The host resolves every
// field (stored value -> environment variable -> default) into `rt.credentials`; this module never reads
// `process.env`, and it always passes the key and base URL explicitly so no package falls back to its own
// environment variables.
import type { CredentialField, ProviderRuntime } from '@harness-forge/plugin-sdk'

/** `apiKey`: required secret; `envVar` lists the fallback variables (first non-empty wins). */
export function apiKeyField(envVar: string | string[]): CredentialField {
  return { key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar }
}

/** `baseURL`: optional, in the "Advanced" section of the key dialog. */
export function baseUrlField(defaultBaseUrl: string): CredentialField {
  return { key: 'baseURL', label: 'Base URL', type: 'url', default: defaultBaseUrl, advanced: true }
}

/** The resolved API key; `''` when unresolved, which a package sends as is (the vendor answers 401). */
export function apiKeyOf(rt: ProviderRuntime): string {
  return rt.credentials.apiKey?.trim() ?? ''
}

/** The resolved base URL without trailing slashes; the default when unset or blank. */
export function baseUrlOf(rt: ProviderRuntime, defaultBaseUrl: string): string {
  const value = rt.credentials.baseURL?.trim()
  return (value || defaultBaseUrl).replace(/\/+$/, '')
}
