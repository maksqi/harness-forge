// Small string helpers shared by the schemas. Isomorphic: no Node built-ins.

/** Number of bytes of `value` encoded as UTF-8 (lone surrogates count as the 3-byte replacement character). */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    }
    else if (code < 0x800) {
      bytes += 2
    }
    else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4
        index++
      }
      else {
        bytes += 3
      }
    }
    else {
      bytes += 3
    }
  }
  return bytes
}

/** True when `value` contains a C0 control character or DEL. Horizontal tab is allowed when `allowTab` is set. */
export function hasControlChars(value: string, allowTab = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && !(allowTab && code === 0x09)) || code === 0x7F)
      return true
  }
  return false
}

/** Shortens `value` for use inside an error message. */
export function excerpt(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

/** True when `values` has no duplicates (strict equality). */
export function isUnique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length
}

/** Returns the values that occur more than once, in first-occurrence order. */
export function duplicates<T>(values: readonly T[]): T[] {
  const seen = new Set<T>()
  const repeated = new Set<T>()
  for (const value of values) {
    if (seen.has(value))
      repeated.add(value)
    seen.add(value)
  }
  return [...repeated]
}

/** Compiles a regular expression source, returning `null` when it is invalid. */
export function compileRegExp(source: string, flags: string): RegExp | null {
  try {
    return new RegExp(source, flags)
  }
  catch {
    return null
  }
}
