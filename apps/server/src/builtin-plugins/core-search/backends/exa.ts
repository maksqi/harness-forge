// The Exa backend of `core-search` (Phase 14, ADR-063, W14.5-T1). Verified against the vendor's API reference
// (exa.ai/docs, "Search" `POST /search`, read 2026-10-22):
// - `POST https://api.exa.ai/search` with a JSON body `{ query, numResults, type: 'auto', contents: { highlights: true },
//   startPublishedDate? }`; `numResults` 1 … 100 (default 10); `type` `auto` (the default) picks the search kind;
//   `contents.highlights: true` returns the most relevant sentences with default settings; `startPublishedDate` is an
//   ISO 8601 date-time (the freshness filter: now minus 1, 7, 31 or 365 days);
// - the key in the header `x-api-key` (`Authorization: Bearer` is accepted too);
// - the answer `{ requestId, results: [{ id, title, url, publishedDate?, author?, highlights?, highlightScores?, text?,
//   summary?, … }], searchTime?, costDollars?, … }`: the snippet is the highlights joined (else `summary`, else `text`).
import type { SearchWebFreshness } from '@harness-forge/shared'
import type { BackendHttpRequest, BackendSearchRequest, RawSearchResult, SearchBackend } from './common.ts'
import { arrayField, fieldOf } from './common.ts'

export const EXA_SEARCH_ENDPOINT = 'https://api.exa.ai/search'

const DAY_MS = 86_400_000

/** How far back each freshness filter reaches, in days (the same windows as Brave's pd / pw / pm / py). */
export const EXA_FRESHNESS_DAYS: Readonly<Record<SearchWebFreshness, number>> = { day: 1, week: 7, month: 31, year: 365 }

/** The `startPublishedDate` of a freshness filter at `now` (ms since the epoch). */
export function exaStartPublishedDate(freshness: SearchWebFreshness, now: number): string {
  return new Date(now - EXA_FRESHNESS_DAYS[freshness] * DAY_MS).toISOString()
}

function buildRequest(request: BackendSearchRequest, now: number): BackendHttpRequest {
  return {
    url: EXA_SEARCH_ENDPOINT,
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'x-api-key': request.key },
    body: JSON.stringify({
      query: request.query,
      numResults: request.count,
      type: 'auto',
      contents: { highlights: true },
      ...(request.freshness === undefined ? {} : { startPublishedDate: exaStartPublishedDate(request.freshness, now) }),
    }),
  }
}

/** The snippet of an Exa result: the highlights joined, else the summary, else the text. */
function exaSnippet(entry: unknown): unknown {
  const highlights = fieldOf(entry, 'highlights')
  if (Array.isArray(highlights)) {
    const joined = highlights.filter((value): value is string => typeof value === 'string' && value.trim() !== '').join(' … ')
    if (joined !== '')
      return joined
  }
  const summary = fieldOf(entry, 'summary')
  if (typeof summary === 'string' && summary.trim() !== '')
    return summary
  return fieldOf(entry, 'text')
}

function readResults(body: unknown): RawSearchResult[] | null {
  const results = arrayField(body, 'results')
  if (results === null)
    return null
  return results.map(entry => ({
    title: fieldOf(entry, 'title'),
    url: fieldOf(entry, 'url'),
    snippet: exaSnippet(entry),
    published: fieldOf(entry, 'publishedDate'),
  }))
}

/** Exa (`backend: 'exa'`). */
export const exaBackend: SearchBackend = {
  id: 'exa',
  label: 'Exa',
  endpoint: EXA_SEARCH_ENDPOINT,
  buildRequest,
  readResults,
}
