// The Tavily backend of `core-search` (Phase 14, ADR-063, W14.5-T1). Verified against the vendor's API reference
// (docs.tavily.com, "Tavily Search" `POST /search`, read 2026-10-22):
// - `POST https://api.tavily.com/search` with a JSON body `{ query, max_results, search_depth: 'basic',
//   include_published_date: true, time_range? }`; `max_results` 0 … 20 (default 10); `search_depth` `basic` costs one
//   credit; `time_range` `day` | `week` | `month` | `year`; `include_published_date` (default false) adds
//   `published_date` to the results;
// - the key in the header `Authorization: Bearer <key>` (never in the body);
// - the answer `{ query, answer?, images, results: [{ title, url, content, score, raw_content?, published_date?,
//   … }], response_time, request_id? }`; `content` is the snippet (several chunks joined with `[...]`),
//   `published_date` may be null.
// Other statuses the vendor documents: 400, 422, 432 / 433 (plan or spending limit), 500 (all `provider_error`).
import type { BackendHttpRequest, BackendSearchRequest, RawSearchResult, SearchBackend } from './common.ts'
import { arrayField, fieldOf } from './common.ts'

export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'

function buildRequest(request: BackendSearchRequest): BackendHttpRequest {
  return {
    url: TAVILY_SEARCH_ENDPOINT,
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${request.key}` },
    body: JSON.stringify({
      query: request.query,
      max_results: request.count,
      search_depth: 'basic',
      include_published_date: true,
      ...(request.freshness === undefined ? {} : { time_range: request.freshness }),
    }),
  }
}

function readResults(body: unknown): RawSearchResult[] | null {
  const results = arrayField(body, 'results')
  if (results === null)
    return null
  return results.map(entry => ({
    title: fieldOf(entry, 'title'),
    url: fieldOf(entry, 'url'),
    snippet: fieldOf(entry, 'content'),
    published: fieldOf(entry, 'published_date'),
  }))
}

/** Tavily (`backend: 'tavily'`). */
export const tavilyBackend: SearchBackend = {
  id: 'tavily',
  label: 'Tavily',
  endpoint: TAVILY_SEARCH_ENDPOINT,
  buildRequest,
  readResults,
}
