// Instruction markers of the server-internal model calls (Phase 9). FROZEN after P9-0b (C26, complete).
//
// The compaction summarizer (`chat/compaction/summarize.ts`, ADR-040) and the sub-agent preamble
// (`chat/subagent/index.ts`, ADR-043) put one of these strings into the `instructions` of their model call. The mock
// models (`builtin-plugins/mock/**`, PROVIDERS.md 8 "Agent mocks (Phase 9)") recognize the call by it: `mock:compact`
// answers a summarizer call with its `MOCK-SUMMARY:` text, `mock:subagent` plays the child. Real models only see an
// opaque bracketed tag. The strings are never shown to users (instructions are not stored in messages) and never
// change: the mock models, the probes and the e2e specs depend on them.

/** Marks the instructions of a compaction summarizer call (`summarizeHistory`). */
export const COMPACT_INSTRUCTIONS_MARKER = '[[hf:compact-summarizer:v1]]'

/** Marks the instructions (preamble) of a sub-agent run (`createSubagentRunner`). */
export const SUBAGENT_INSTRUCTIONS_MARKER = '[[hf:subagent:v1]]'
