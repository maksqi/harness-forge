// Node >= 25 exposes an experimental global `localStorage`/`sessionStorage` (undefined without
// --localstorage-file) that shadows happy-dom's implementation. Install an in-memory Storage when that happens.
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key) },
    setItem: (key, value) => { data.set(key, String(value)) },
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  let current: Storage | undefined
  try {
    current = globalThis[name]
  }
  catch {
    current = undefined
  }
  if (!current)
    Object.defineProperty(globalThis, name, { value: memoryStorage(), configurable: true, writable: true })
}
