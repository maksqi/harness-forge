// MCP content as text (Phase 14, ADR-061; ARCHITECTURE.md 6.41 / 6.42): one content item of a tool result, a prompt
// message or a resource as plain text for the model. Owner in P14-A: W14.2 (prompt expansions: user text joined,
// `<prompt-message role>` wrapping, `<resource uri mimeType>` blocks, one-line placeholders for images, blobs and
// links; `resource` / `resource_link` items of tool results as readable text). C51 stub (P14-0b): the signature is
// final, the body keeps the v1.8 behavior of `mcpModelOutput` (a text item's text, anything else as JSON text).
// MCP content is untrusted: callers cap it before use and never log it at `info`.

/** Options of `mcpContentText`. */
export interface McpContentTextOptions {
  /** Longest text answered (a longer one is cut and ends in `...`); default: no cap. */
  readonly maxChars?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capped(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars < 0 || text.length <= maxChars)
    return text
  return `${text.slice(0, Math.floor(maxChars))}...`
}

/**
 * The text of one MCP content item (`text`, `image`, `audio`, `resource`, `resource_link`, or anything a server sends):
 * a text item's `text`; every other item as its JSON (C51 stub; W14.2 makes resources and links readable).
 */
export function mcpContentText(content: unknown, options: McpContentTextOptions = {}): string {
  if (isRecord(content) && content.type === 'text' && typeof content.text === 'string')
    return capped(content.text, options.maxChars)
  let json: string | undefined
  try {
    json = JSON.stringify(content)
  }
  catch {
    json = undefined
  }
  return capped(json ?? String(content), options.maxChars)
}
