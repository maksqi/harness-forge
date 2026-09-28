// Frozen interface of the content-addressed upload store (API.md 5.11, table `files`, `data/files/<aa>/<sha256>`).
// Implementation: `createFilesService(deps)` in `services/files/index.ts` (W1.5). Consumers: the files routes (W1.5)
// and the chat pipeline (W2.1: file parts -> bytes for vision / pdf models).
import type { FileRef } from '@harness-forge/shared'

/** A `files` row. */
export interface StoredFile {
  id: string
  /** Lowercase hex; the bytes live in `data/files/<sha256[0..2]>/<sha256>`. */
  sha256: string
  /** Sanitized original name (no path separators or control characters, <= 255 chars). */
  name: string
  mime: string
  size: number
  createdAt: number
}

export interface FilesService {
  /**
   * Validates size (`LIMITS.uploadBytes` -> `payload_too_large` with `details.limitBytes`), MIME family
   * (`UPLOAD_MIME_PATTERNS`) and content (magic bytes for images / PDF, valid UTF-8 for text), stores the bytes once per
   * sha256 and inserts a row per upload. Throws `validation_error` on a rejected file.
   */
  readonly upload: (file: File) => Promise<FileRef>
  /** The row, or null. */
  readonly get: (id: string) => Promise<StoredFile | null>
  /** Row + bytes; `not_found`. */
  readonly read: (id: string) => Promise<{ file: StoredFile, data: Uint8Array }>
  /** Row + byte stream (`GET /files/:id`); `not_found`. */
  readonly open: (id: string) => Promise<{ file: StoredFile, stream: ReadableStream<Uint8Array> }>
  /** The file id of a UI `file` part URL (`/api/files/<id>`), else null. */
  readonly idFromUrl: (url: string) => string | null
}
