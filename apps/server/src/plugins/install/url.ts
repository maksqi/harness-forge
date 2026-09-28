// URL source (PLUGINS.md 12 "Sources"): an https `.zip` or `.tgz` with a required SRI `integrity`, downloaded through
// the SSRF-guarded `SafeFetch` (security/ssrf.ts: no loopback / private / link-local targets, every redirect hop
// re-checked, at most 3 redirects here, a byte cap and a timeout). The integrity is verified on the downloaded bytes
// before anything is decompressed; the archive format is taken from its magic bytes, not from the URL.
import type { SafeFetch, SafeFetchResult } from '../../security/types.ts'
import type { InstallLimits } from './errors.ts'
import { isHarnessError } from '@harness-forge/shared'
import { invalid, upstreamError } from './errors.ts'
import { verifyIntegrity } from './integrity.ts'
import { looksLikeGzip } from './tar.ts'
import { looksLikeZip } from './zip.ts'

const DOWNLOAD_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 3

export interface UrlDownload {
  data: Uint8Array
  format: 'zip' | 'tgz'
}

/** Downloads and verifies an archive; `integrity` was validated by `pluginInstallSourceSchema`. */
export async function downloadFromUrl(url: string, integrity: string, safeFetch: SafeFetch, limits: Pick<InstallLimits, 'compressedBytes'>): Promise<UrlDownload> {
  let response: SafeFetchResult
  try {
    response = await safeFetch(url, {
      maxBytes: limits.compressedBytes,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      protocols: ['https:'],
      method: 'GET',
      headers: { accept: 'application/zip, application/gzip, application/octet-stream;q=0.9, */*;q=0.5' },
    })
  }
  catch (error) {
    if (isHarnessError(error))
      throw error
    throw upstreamError('provider_unreachable', 'The download failed: network error.')
  }
  if (response.status !== 200)
    throw upstreamError('provider_error', `The download failed (HTTP ${response.status}).`, response.status)
  const data = response.body
  if (!verifyIntegrity(data, integrity, ['sha256', 'sha512']))
    throw invalid('The downloaded file does not match the integrity hash.', ['integrity'])
  if (looksLikeZip(data))
    return { data, format: 'zip' }
  if (looksLikeGzip(data))
    return { data, format: 'tgz' }
  throw invalid('The URL does not point to a .zip or .tgz archive.', ['url'])
}
