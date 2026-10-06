// `mock:prompt-hook` (Phase 12, ADR-057, PROVIDERS.md 8 "Prompt hook mock (Phase 12)"; C45-T1, FROZEN after Gate
// P12-0b): the model that answers prompt hooks, so the probes and the e2e specs drive every outcome without a real
// model. The 18th language model of the mock provider: `kind: 'chat'`, no capabilities (it never calls a tool).
//
// Input: the text parts of the call's user messages, in order (each message's text parts joined with "\n", the messages
// joined with "\n"); the system text and the assistant messages are never searched. The prompt-hook runner sends the
// hook's prompt with `$ARGUMENTS` replaced by the hook input JSON (or the JSON appended), so a marker written in the
// prompt wins over one inside the hook input unless the prompt places `$ARGUMENTS` before its own marker.
//
// The answer (the whole text of the reply) comes from the FIRST marker of that text:
//   [[ph:ok]]            {"ok":true}
//   [[ph:deny R]]        {"ok":false,"reason":"R"}                     R = the text between `deny` and `]]`, trimmed
//   [[ph:impossible R]]  {"ok":false,"reason":"R","impossible":true}
//   [[ph:fenced]]        "Here is my answer:" on its own line, then {"ok":false,"reason":"fenced"} in a json code fence
//   [[ph:invalid]]       I cannot decide.                              (no JSON: a non-blocking error)
//   none                 {"ok":true}
// A marker is `[[ph:<keyword>` followed by `]]` or a blank, then everything up to the first `]]`. `ok`, `fenced` and
// `invalid` take nothing but blanks before `]]`, and an unknown keyword is no marker: such text is skipped and the
// search goes on. `R` may be empty (`[[ph:deny]]` answers `{"ok":false,"reason":""}`, which `readPromptHookAnswer`
// reads as invalid: a "no" needs a reason).
//
// No waits: the stream has no delays and `doGenerate` answers at once (timeouts are tested with `MockLanguageModelV4`
// in unit tests, never with this mock). The reasoning setting and the output-token cap are ignored. Usage is fixed at
// 10 input and 5 output tokens, `finishReason: 'stop'`. An aborted signal rejects with its reason.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { abortableDelay, abortError, MOCK_PROVIDER_ID } from './common.ts'

/** This mock's model id (`mock:prompt-hook`). */
export const MOCK_PROMPT_HOOK_MODEL_ID = 'prompt-hook'

/** The fixed usage of every call (PROVIDERS.md 8): 10 input tokens, 5 output tokens. */
export const MOCK_PROMPT_HOOK_USAGE = { inputTokens: 10, outputTokens: 5 } as const

/** The marker keywords, in the order of PROVIDERS.md 8. */
export const MOCK_PROMPT_HOOK_MARKERS = ['ok', 'deny', 'impossible', 'fenced', 'invalid'] as const
export type MockPromptHookMarker = (typeof MOCK_PROMPT_HOOK_MARKERS)[number]

/** The answer of `[[ph:ok]]` and of a text without a marker. */
export const MOCK_PROMPT_HOOK_OK = '{"ok":true}'
/** The answer of `[[ph:invalid]]` (no JSON). */
export const MOCK_PROMPT_HOOK_INVALID = 'I cannot decide.'
/** The reason inside the fenced answer of `[[ph:fenced]]`. */
export const MOCK_PROMPT_HOOK_FENCED_REASON = 'fenced'
/** The whole answer of `[[ph:fenced]]`: a line of prose, then the JSON object inside a `json` code fence. */
export const MOCK_PROMPT_HOOK_FENCED = `Here is my answer:\n\`\`\`json\n{"ok":false,"reason":"${MOCK_PROMPT_HOOK_FENCED_REASON}"}\n\`\`\``

/** The first marker of a text: its keyword and, for `deny` / `impossible`, the trimmed reason. */
export interface MockPromptHookMatch {
  readonly marker: MockPromptHookMarker
  readonly reason: string
}

/** `[[ph:<word>`, then `]]` or a blank (lookahead), then the shortest text up to `]]`. */
const MARKER = /\[\[ph:([a-z]+)(?=\]\]|\s)([\s\S]*?)\]\]/g
const WITH_REASON: ReadonlySet<string> = new Set(['deny', 'impossible'])
const WITHOUT_REASON: ReadonlySet<string> = new Set(['ok', 'fenced', 'invalid'])

/** The first marker of `text` (see the module comment), or null. */
export function findPromptHookMarker(text: string): MockPromptHookMatch | null {
  for (const match of text.matchAll(MARKER)) {
    const keyword = match[1] ?? ''
    const rest = match[2] ?? ''
    if (WITH_REASON.has(keyword))
      return { marker: keyword as MockPromptHookMarker, reason: rest.trim() }
    if (WITHOUT_REASON.has(keyword) && rest.trim() === '')
      return { marker: keyword as MockPromptHookMarker, reason: '' }
  }
  return null
}

/** The whole reply for a searched text (see the table of the module comment). */
export function mockPromptHookAnswer(text: string): string {
  const match = findPromptHookMarker(text)
  switch (match?.marker) {
    case 'deny':
      return JSON.stringify({ ok: false, reason: match.reason })
    case 'impossible':
      return JSON.stringify({ ok: false, reason: match.reason, impossible: true })
    case 'fenced':
      return MOCK_PROMPT_HOOK_FENCED
    case 'invalid':
      return MOCK_PROMPT_HOOK_INVALID
    default:
      return MOCK_PROMPT_HOOK_OK
  }
}

/** The searched text of a call: the text parts of every user message in order (system and assistant text never). */
export function mockPromptHookText(prompt: LanguageModelV4Prompt): string {
  const messages: string[] = []
  for (const message of prompt) {
    if (message.role !== 'user')
      continue
    messages.push(message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n'))
  }
  return messages.join('\n')
}

function fixedUsage(): LanguageModelV4Usage {
  const input = MOCK_PROMPT_HOOK_USAGE.inputTokens
  const output = MOCK_PROMPT_HOOK_USAGE.outputTokens
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  }
}

function answerOf(options: LanguageModelV4CallOptions): string {
  if (options.abortSignal?.aborted)
    throw abortError(options.abortSignal)
  return mockPromptHookAnswer(mockPromptHookText(options.prompt))
}

/** The stream parts of one answer (one text delta, no reasoning, no tool call). */
export function mockPromptHookStreamParts(answer: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'mock-response', modelId: MOCK_PROMPT_HOOK_MODEL_ID, timestamp: new Date(0) },
    { type: 'text-start', id: 'text-0' },
    { type: 'text-delta', id: 'text-0', delta: answer },
    { type: 'text-end', id: 'text-0' },
    { type: 'finish', usage: fixedUsage(), finishReason: { unified: 'stop', raw: 'stop' } },
  ]
}

/** `mock:prompt-hook` (`createMockLanguageModel('prompt-hook')` of ./models.ts returns this). */
export function createMockPromptHookModel(): LanguageModelV4 {
  return new MockLanguageModelV4({
    provider: MOCK_PROVIDER_ID,
    modelId: MOCK_PROMPT_HOOK_MODEL_ID,
    supportedUrls: {},
    doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => ({
      content: [{ type: 'text', text: answerOf(options) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: fixedUsage(),
      response: { id: 'mock-response', modelId: MOCK_PROMPT_HOOK_MODEL_ID, timestamp: new Date(0) },
      warnings: [],
    }),
    doStream: async (options) => {
      const signal = options.abortSignal
      return {
        stream: simulateReadableStream({
          chunks: mockPromptHookStreamParts(answerOf(options)),
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          // No timer at all: every chunk follows at once, unless the call was aborted meanwhile.
          _internal: { delay: async () => abortableDelay(0, signal) },
        }),
      }
    },
  })
}
