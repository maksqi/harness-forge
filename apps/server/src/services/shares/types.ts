// Frozen interface of read-only share links (ADR-025, API.md 4.17 / 5.20, ARCHITECTURE.md 6.10 / 10.7).
// Implementation: `createShareService(deps)` in `services/shares/index.ts` (W5.4). Consumer: the shares routes
// (`http/routes/shares.ts`, W5.4: the owner routes under `/shares` and the public `/share/:token` routes). Built on
// `ChatsService.get` (the active path), `FilesService.open`, the `chat_shares` table and the keyring subkey `share`.
// Test double: `createFakeShareService` (`testing/fakes.ts`).
import type { ShareCreate, SharesQuery, ShareSummary, ShareUpdate, ShareView } from '@harness-forge/shared'
import type { StoredFile } from '../files/types.ts'

/** A file of a share, opened for `GET /share/:token/files/:fileId`. */
export interface ShareFile {
  /** The `files` row: type, name and size for the response headers. */
  file: StoredFile
  /** The bytes; the route cancels it for `HEAD`. */
  stream: ReadableStream<Uint8Array>
}

/**
 * A share is a `chat_shares` row holding an allowlist-sanitized snapshot of a chat's active path, taken at creation and
 * again only on `refresh`; the public members never read live messages. Its token (`SHARE_TOKEN_PATTERN`) is the
 * 16-character suffix of the share id + the first 22 base64url characters of
 * `HMAC-SHA256(keyring.subkey('share'), 'harness-forge/share/v1:' + shareId)`: recomputed when needed, never stored or
 * logged. The owner members run behind a session (`create` and `update` also behind fresh auth, route table flags); the
 * routes apply the rate limits of ARCHITECTURE.md 10.7 (per `clientAddress(c)`) before calling `view` / `openFile`.
 * Share actions emit no server event (the owner UI refetches).
 */
export interface ShareService {
  /**
   * `GET /shares`: every share link, or only those of `query.chatId`, newest first (`createdAt` desc, then `id`), with
   * `path` = `/share/<token>`, the current chat title and the `outdated` (the chat changed after `snapshotAt`: a later
   * `updated_at`, or an active path length other than `messageCount`) and `expired` (`expiresAt <= now`) flags.
   */
  readonly list: (query: SharesQuery) => Promise<ShareSummary[]>
  /**
   * `POST /shares`: snapshots the chat's active path (`ChatsService.get(chatId).messages`) through the allowlist
   * sanitizer, records the only file ids the share may serve and inserts the row. Options not given take their defaults
   * (`reasoning: false`, `toolDetails: false`, `attachments: true`); `title` defaults to the chat title. `not_found`
   * (unknown chat); `validation_error` (`expiresAt` not in the future or more than 365 days ahead, or the chat already
   * has `LIMITS.sharesPerChatMax` links); `payload_too_large` (`details.limitBytes`) for a snapshot above
   * `LIMITS.shareSnapshotBytes`.
   */
  readonly create: (input: ShareCreate) => Promise<ShareSummary>
  /**
   * `PATCH /shares/:id`: `title` (`null` = back to the chat title), `options` (merged key by key; they apply to the share
   * page at once, without a new snapshot), `expiresAt` (`null` removes it; same rules as `create`), `refresh: true`
   * (re-snapshots the chat's current active path). The id, the token and `path` never change. `not_found` (unknown
   * share); `validation_error` (`expiresAt`); `payload_too_large` (refreshed snapshot).
   */
  readonly update: (id: string, patch: ShareUpdate) => Promise<ShareSummary>
  /** `DELETE /shares/:id`: revokes the link (deletes the row, so the token stops working at once). `not_found`. */
  readonly remove: (id: string) => Promise<void>
  /**
   * Public `GET /share/:token`: the stored snapshot with the share's current options applied (reasoning parts, tool
   * inputs / outputs and file parts left out when disabled) and file URLs rewritten to
   * `/api/share/<token>/files/<fileId>`. Every failure throws the same `not_found`: a malformed, unknown, bad-MAC
   * (timing-safe comparison), revoked or expired token, or a deleted chat (re-checked on every call). Writes nothing.
   */
  readonly view: (token: string) => Promise<ShareView>
  /**
   * Public `GET /share/:token/files/:fileId`: a file of the snapshot, only for an id in the share's `file_ids` and only
   * with `options.attachments`. Every failure (those of `view`, a file outside the share, a file missing on disk)
   * throws the same `not_found`. Writes nothing.
   */
  readonly openFile: (token: string, fileId: string) => Promise<ShareFile>
}
