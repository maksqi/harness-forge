// Frozen interface of the content-addressed upload store (API.md 5.11, table `files`, `data/files/<aa>/<sha256>`).
// Implementation: `createFilesService(deps)` in `services/files/index.ts` (W1.5). Consumers: the files routes (W1.5)
// and the chat pipeline (W2.1: file parts -> bytes for vision / pdf models); in Phase 5 the data service (W5.3:
// `importFile`, `purge`, ADR-024) and the share service (W5.4: `open` for share-scoped files, ADR-025).
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

/** One attachment of a data import (an item of a backup's `files/index.json` and its blob `files/<sha256>`). */
export interface FileImportInput {
  /**
   * The file id of the backup (the `/api/files/<id>` URLs of its parts): the stored row keeps it when no row uses it
   * yet (else it gets a new id, and the data import rewrites the part URLs).
   */
  preferredId: string
  /** The lowercase hex sha256 the backup declares for `data`; the bytes are hashed again and must match. */
  sha256: string
  /** Original name; sanitized like an upload. */
  name: string
  /** Declared type; checked against the content like an upload. */
  mime: string
  data: Uint8Array
  /** `createdAt` of the backup's row (kept for a new row). */
  createdAt: number
}

/** Result of `importFile`. */
export interface FileImportResult {
  /** The row the parts must point at: `file.id` may differ from `preferredId`. */
  file: StoredFile
  /** true: a row with the same content (sha256) already existed and is reused (nothing written); false: a new row. */
  reused: boolean
}

/** Result of `purge`: what was deleted. */
export interface FilePurgeResult {
  /** Deleted `files` rows. */
  files: number
  /**
   * Sum of the deleted rows' `size` (what `DataSummary.fileBytes` counted), not the freed disk space: identical
   * uploads share one blob.
   */
  bytes: number
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

  // ----- Phase 5: bulk data (ADR-024), W5.3

  /**
   * Stores one attachment of a data import. The bytes must hash to `input.sha256` and pass the upload checks (size,
   * MIME family, content; the name is sanitized): else `validation_error` (`payload_too_large` above
   * `LIMITS.uploadBytes`). Deduplicated by content: when a row with the same sha256 exists it is reused (`reused: true`,
   * preferring the row whose id is `preferredId`; a missing blob is written again); otherwise the blob is stored and a
   * new row inserted under `preferredId` when it is a free, valid file id, else under a new id (`reused: false`).
   * Running the same import again therefore reuses every file.
   */
  readonly importFile: (input: FileImportInput) => Promise<FileImportResult>
  /**
   * Delete-all with `files: true`: deletes every `files` row and every blob of the store (`data/files/**`, orphans
   * included). Messages keep their `/api/files/<id>` URLs, which then answer `404`.
   */
  readonly purge: () => Promise<FilePurgeResult>
}
