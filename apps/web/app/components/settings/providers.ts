// Settings -> Providers rules (docs/UI.md 9.1): list order, row subtitles and labels, and the plain-HTTP warning.
import type { ProviderSummary } from '@harness-forge/shared'
import { BUILTIN_PLUGIN_IDS, BUILTIN_PROVIDER_IDS } from '@harness-forge/shared'

const BUILTIN_PLUGINS: ReadonlySet<string> = new Set(BUILTIN_PLUGIN_IDS)
const BUILTIN_ORDER: ReadonlyMap<string, number> = new Map(
  BUILTIN_PROVIDER_IDS.map((id, index): [string, number] => [id, index]),
)

/** Contributed by a builtin plugin (`core-providers`, or the dev-only `mock`). */
export function isBuiltinProvider(provider: Pick<ProviderSummary, 'pluginId'>): boolean {
  return BUILTIN_PLUGINS.has(provider.pluginId)
}

function compareNames(a: ProviderSummary, b: ProviderSummary): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id)
}

/**
 * Builtins in docs/PROVIDERS.md order (unknown builtins such as `mock` after them, in server order), then plugin
 * providers by name.
 */
export function sortProviders(items: readonly ProviderSummary[]): ProviderSummary[] {
  const rank = (provider: ProviderSummary) => BUILTIN_ORDER.get(provider.id) ?? BUILTIN_ORDER.size
  const builtins = items
    .map((provider, index) => ({ provider, index }))
    .filter(({ provider }) => isBuiltinProvider(provider))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
    .map(({ provider }) => provider)
  const plugins = items.filter(provider => !isBuiltinProvider(provider)).sort(compareNames)
  return [...builtins, ...plugins]
}

/** "1 model", "23 models". */
export function formatModelCount(count: number): string {
  return count === 1 ? '1 model' : `${count} models`
}

/**
 * Row subtitle: "Local — no key" for keyless providers, else the model count (nothing when there are none), plus
 * "via {plugin name}" for plugin providers.
 */
export function providerSubtitle(provider: ProviderSummary, pluginName?: string | null): string {
  const parts: string[] = []
  if (provider.local)
    parts.push('Local — no key')
  else if (provider.modelCount > 0)
    parts.push(formatModelCount(provider.modelCount))
  if (!isBuiltinProvider(provider))
    parts.push(`via ${pluginName || provider.pluginId}`)
  return parts.join(' · ')
}

/** "Add key" until the provider is configured, then "Configure". */
export function configureLabel(provider: Pick<ProviderSummary, 'status'>): string {
  return provider.status === 'not_configured' ? 'Add key' : 'Configure'
}

/** Tooltip of the status badge: the last error, only while the badge shows the error. */
export function statusMessage(provider: Pick<ProviderSummary, 'status' | 'lastError'>): string | undefined {
  return provider.status === 'error' ? provider.lastError?.message || undefined : undefined
}

/** `localhost` (and `*.localhost`), 127.0.0.0/8 and `[::1]`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/** The page is served over plain HTTP from a host other than loopback: keys typed here cross the network in clear. */
export function isPlainHttpFromNetwork(location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return location.protocol === 'http:' && !isLoopbackHost(location.hostname)
}
