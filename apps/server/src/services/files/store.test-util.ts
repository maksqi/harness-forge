// Test helpers of the orphaned file cleanup (W7.8): rows and blobs written straight into the store (no pins, any
// `created_at`), blob paths and mtimes.
import type { AppDeps } from '../../types.ts'
import type { StoredFile } from './types.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFileId } from '@harness-forge/shared'
import { files } from '../../db/schema.ts'

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `<files root>/<aa>/<sha256>` of `bytes` (or of a sha256). */
export function blobPathOf(deps: Pick<AppDeps, 'env'>, content: Uint8Array | string): string {
  const sha256 = typeof content === 'string' ? content : sha256Of(content)
  return join(deps.env.paths.files, sha256.slice(0, 2), sha256)
}

/** Writes the blob of `bytes` (when `mtime` is given, with that mtime). Returns its path. */
export function writeBlob(deps: Pick<AppDeps, 'env'>, bytes: Uint8Array, mtime?: number): string {
  const path = blobPathOf(deps, bytes)
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(path, bytes, { mode: 0o600 })
  if (mtime !== undefined)
    setMtime(path, mtime)
  return path
}

/** Sets the access and modification time of `path` (ms). */
export function setMtime(path: string, at: number): void {
  utimesSync(path, at / 1000, at / 1000)
}

export interface SeedFileOptions {
  createdAt: number
  name?: string
  mime?: string
  /** Default: a new file id. */
  id?: string
  /** Write the blob too (default true). */
  blob?: boolean
}

/** Inserts a `files` row (and its blob) without the files service: never pinned, any age. */
export async function seedStoredFile(deps: Pick<AppDeps, 'env' | 'db'>, bytes: Uint8Array, options: SeedFileOptions): Promise<StoredFile> {
  const row: StoredFile = {
    id: options.id ?? createFileId(),
    sha256: sha256Of(bytes),
    name: options.name ?? 'seed.bin',
    mime: options.mime ?? 'application/octet-stream',
    size: bytes.byteLength,
    createdAt: options.createdAt,
  }
  await deps.db.insert(files).values(row)
  if (options.blob ?? true)
    writeBlob(deps, bytes)
  return row
}
