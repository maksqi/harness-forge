// Test helpers of the Phase 14 records (W14.6): stored message parts of web search and MCP elicitation as the pipeline
// writes them, shared by the share snapshot, export, import, backup and restore tests. Every value a share or a
// Markdown export must never carry holds a `*-SENTINEL` marker of `RECORD_SENTINELS`.
import type { HarnessUIMessage, McpElicitationRecord, SearchWebResult } from '@harness-forge/shared'

type Part = HarnessUIMessage['parts'][number]

/** Provider data of native search parts: kept in the stored message and in backups, never in shares or exports. */
export const RECORD_SENTINELS = {
  encrypted: 'ENCRYPTED-CONTENT-SENTINEL',
  callMetadata: 'CALL-METADATA-SENTINEL',
  resultMetadata: 'RESULT-METADATA-SENTINEL',
  providerField: 'PROVIDER-FIELD-SENTINEL',
} as const

/** The results of the stored `search_web` call. */
export const SEARCH_RESULTS: SearchWebResult[] = [
  { title: 'MCP authorization', url: 'https://modelcontextprotocol.io/specification/authorization', snippet: 'OAuth 2.1 with PKCE\nfor remote servers.', published: '2026-06-18' },
  { title: 'RFC 7636 [PKCE]', url: 'https://www.rfc-editor.org/rfc/rfc7636', snippet: 'Proof Key for Code Exchange.', published: null },
]

/** The elicitation records of the stored MCP call: an answered form and an automatic decline. */
export const ELICITATION_RECORDS: McpElicitationRecord[] = [
  { id: 'eli_0000000000000001', message: 'Which account should I use?', fields: ['name', 'email_address'], action: 'accept', reason: 'user' },
  { id: 'eli_0000000000000002', message: 'Confirm the upload.', fields: [], action: 'decline', reason: 'not-interactive' },
]

/** A finished `search_web` call (the builtin of `core-search`). */
export function searchWebPart(results: SearchWebResult[] = SEARCH_RESULTS): Part {
  return {
    type: 'tool-search_web',
    toolCallId: 'call_search_1',
    state: 'output-available',
    input: { query: 'mcp authorization pkce', count: 5 },
    output: { query: 'mcp authorization pkce', backend: 'brave', results },
  } as unknown as Part
}

/** The `source-url` parts the sources transform adds after the `search_web` output. */
export function searchSourceParts(): Part[] {
  return SEARCH_RESULTS.map((result, index) => ({ type: 'source-url', sourceId: `src_search_${index + 1}`, url: result.url, title: result.title }) as Part)
}

/** A provider-executed Anthropic `web_search` call: the query in the input, `encryptedContent` in each result. */
export function anthropicSearchPart(): Part {
  return {
    type: 'tool-web_search',
    toolCallId: 'srvtoolu_0001',
    state: 'output-available',
    providerExecuted: true,
    input: { query: 'weather in Lisbon' },
    output: [
      { type: 'web_search_result', url: 'https://weather.example/lisbon', title: 'Lisbon weather', pageAge: '1 day ago', encryptedContent: RECORD_SENTINELS.encrypted },
      { type: 'web_search_result', url: 'javascript:alert(1)', title: 'Not a web page', pageAge: null, encryptedContent: RECORD_SENTINELS.encrypted },
    ],
    callProviderMetadata: { anthropic: { marker: RECORD_SENTINELS.callMetadata } },
    resultProviderMetadata: { anthropic: { marker: RECORD_SENTINELS.resultMetadata } },
  } as unknown as Part
}

/** A provider-executed OpenAI `web_search` call: an empty input, the query in the output's action. */
export function openaiSearchPart(): Part {
  return {
    type: 'tool-web_search',
    toolCallId: 'ws_0001',
    state: 'output-available',
    providerExecuted: true,
    input: {},
    output: {
      action: { type: 'search', query: 'nuxt 4 release date' },
      sources: [{ type: 'url', url: 'https://nuxt.com/blog' }],
      providerOnly: RECORD_SENTINELS.providerField,
    },
  } as unknown as Part
}

/** A finished MCP tool call whose server asked twice: its output keeps the records (never a value). */
export function mcpAskPart(): Part {
  return {
    type: 'dynamic-tool',
    toolName: 'mcp__fake__ask',
    toolCallId: 'call_ask_1',
    state: 'output-available',
    input: {},
    output: { content: [{ type: 'text', text: 'Thanks, the account is set.' }], elicitations: ELICITATION_RECORDS },
  } as unknown as Part
}

/** An MCP call stored while it still waited for input (its last output is preliminary). */
export function mcpWaitingPart(): Part {
  return {
    type: 'dynamic-tool',
    toolName: 'mcp__fake__ask',
    toolCallId: 'call_ask_2',
    state: 'output-available',
    preliminary: true,
    input: {},
    output: {
      status: 'input-required',
      elicitation: {
        id: 'eli_0000000000000003',
        serverId: 'fake',
        serverName: 'Fake',
        message: 'Your name?',
        form: { fields: [{ name: 'name', type: 'string', title: 'Name', description: null, required: true }] },
        expiresAt: 1_800_000_000_000,
      },
    },
  } as unknown as Part
}

/** A user message and a reply with every Phase 14 record (ids `msg_records000000001` / `…02`). */
export function recordMessages(): HarnessUIMessage[] {
  return [
    { id: 'msg_records000000001', role: 'user', parts: [{ type: 'text', text: 'Look it up' }] },
    {
      id: 'msg_records000000002',
      role: 'assistant',
      metadata: { modelRef: 'mock:search-tool', startedAt: 1, finishedAt: 2 },
      parts: [
        { type: 'step-start' },
        searchWebPart(),
        ...searchSourceParts(),
        anthropicSearchPart(),
        { type: 'source-url', sourceId: 'src_native_1', url: 'https://weather.example/lisbon', title: 'Lisbon weather' },
        openaiSearchPart(),
        mcpAskPart(),
        { type: 'text', text: 'Done.', state: 'done' },
      ],
    } as HarnessUIMessage,
  ]
}
