// Safe localStorage access: storage can be missing, full or blocked (private mode, strict cookie settings); those
// cases degrade to "nothing stored" instead of throwing. Auto-imported (utils/).

/** Reads and JSON-parses `key`; null when missing, unreadable or not JSON. */
export function readStoredJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw == null ? null : JSON.parse(raw) as unknown
  }
  catch {
    return null
  }
}

/** JSON-stringifies `value` into `key`; returns false when storage is unavailable or full. */
export function writeStoredJson(key: string, value: unknown): boolean {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
    return true
  }
  catch {
    return false
  }
}
