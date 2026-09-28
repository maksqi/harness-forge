// Test helper (not app code): an in-memory `localStorage`. Node >= 25 defines its own global `localStorage`, which
// is undefined without `--localstorage-file` and shadows happy-dom's in Vitest; tests stub it with this one.
import { vi } from 'vitest'

export function createMemoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: key => data.get(String(key)) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: key => void data.delete(String(key)),
    setItem: (key, value) => void data.set(String(key), String(value)),
  }
}

/** Replaces `globalThis.localStorage` with a fresh in-memory storage (undo with `vi.unstubAllGlobals()`). */
export function stubLocalStorage(): Storage {
  const storage = createMemoryStorage()
  vi.stubGlobal('localStorage', storage)
  return storage
}
