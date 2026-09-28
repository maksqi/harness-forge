// Tolerant readers for vendor JSON: a field with an unexpected type is treated as absent instead of failing the whole
// response (model listings evolve faster than their documentation).

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value as an object, else `undefined`. */
export function recordOf(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

/** The value as an array, else `[]`. */
export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** A non-empty string (trimmed), else `undefined`. */
export function stringOf(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** The non-empty strings of an array. */
export function stringsOf(value: unknown): string[] {
  return arrayOf(value).flatMap((item) => {
    const text = stringOf(item)
    return text === undefined ? [] : [text]
  })
}

/** A finite number, else `undefined`. */
export function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A positive integer (token limits), else `undefined`; `0` and placeholders count as unknown. */
export function positiveIntOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** A boolean, else `undefined`. */
export function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** `{ supported: boolean }` capability flags (Anthropic model listing). */
export function supportedOf(value: unknown): boolean | undefined {
  return booleanOf(recordOf(value)?.supported)
}
