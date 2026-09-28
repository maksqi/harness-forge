// Common DTO building blocks (API.md section 4.2) and query-string helpers.
import { z } from 'zod'
import { secretSourceSchema } from '../enums.ts'

/** `{ items: T[] }`: non-paginated lists. */
export function listResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) })
}

/** `{ items: T[]; nextCursor: string | null }`: cursor-paginated lists (`nextCursor` is null on the last page). */
export function cursorPageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() })
}

export interface ListResponse<T> {
  items: T[]
}

export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
}

/** Write-only secret state: never the value. */
export const secretStateSchema = z.object({
  /** A value resolves (stored or env). */
  set: z.boolean(),
  /** Masked hint such as `sk-…9fQ2`; null when not set or too short. */
  hint: z.string().nullable(),
  /** `stored` wins over `env`; null when not set. */
  source: secretSourceSchema.nullable(),
})
export type SecretState = z.infer<typeof secretStateSchema>

/**
 * Icon URLs served by the server (`/api/icons/lobe/<slug>?v=...`, `/api/plugins/<id>/icon?v=...`); null means the
 * monogram fallback.
 */
export const iconRefSchema = z.object({ color: z.string().optional(), mono: z.string().optional() }).nullable()
export type IconRef = z.infer<typeof iconRefSchema>

/** Query-string boolean: `true` / `false` / `1` / `0` (or a real boolean) -> boolean. */
export const queryBooleanSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform(value => value === 'true' || value === '1'),
])

/** Query-string integer within `[min, max]`: a number or a string of digits -> number. */
export function queryIntSchema(min: number, max: number) {
  return z
    .union([z.number(), z.string().regex(/^\d{1,15}$/, 'Expected an integer.').transform(Number)])
    .pipe(z.int().min(min).max(max))
}

/** Opaque base64url pagination cursor. */
export const cursorSchema = z.string().regex(/^[\w-]{1,1024}$/, 'Invalid cursor.')
