// Non-cryptographic hashing used for deterministic short suffixes (MCP tool names).

const FNV_OFFSET_BASIS = 0x811C9DC5
const FNV_PRIME = 0x01000193

/** 32-bit FNV-1a over the UTF-8 bytes of `value`, as an unsigned integer. */
export function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/** 32-bit FNV-1a as 8 lowercase hex characters. */
export function fnv1a32Hex(value: string): string {
  return fnv1a32(value).toString(16).padStart(8, '0')
}
