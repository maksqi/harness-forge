// Size and count limits shared by the web app and the server (API.md section 3.4).

export const LIMITS = {
  /** `POST /files`: bytes per uploaded file. */
  uploadBytes: 20_971_520,
  /** Plugin files readable / writable through the files API. */
  pluginFileBytes: 1_048_576,
  /** Default JSON request body limit. */
  jsonBodyBytes: 1_048_576,
  /** `POST /chat` request body limit. */
  chatBodyBytes: 2_097_152,
  /** Plugin zip uploads and URL downloads (compressed). */
  pluginZipBytes: 20_971_520,
  /** Default page size of cursor-paginated lists. */
  pageLimitDefault: 50,
  /** Maximum page size of cursor-paginated lists. */
  pageLimitMax: 100,
  /** Serialized JSON output of one tool call (truncated with a marker above). */
  toolOutputBytes: 65_536,
  /** Interval of the `: ping` heartbeat of `GET /events`. */
  sseHeartbeatMs: 25_000,

  // Additional limits used by the schemas of this package.
  /** Decoded size of a plugin icon (`IconFileInput`, manifest icon files). */
  iconFileBytes: 262_144,
  /** `plugin.json` size. */
  manifestBytes: 262_144,
  /** Messages of one `POST /chats` import. */
  chatImportMessagesMax: 2000,
  /** Parts of one UI message. */
  messagePartsMax: 1000,
  /** Characters of global and chat instructions. */
  instructionsMaxChars: 20_000,
  /** Characters of one credential value. */
  credentialValueMaxChars: 4096,
  /** Default and maximum `limit` of `GET /plugins/:id/logs`. */
  pluginLogsLimitDefault: 200,
  pluginLogsLimitMax: 500,
  /** Bytes of a declarative command template. */
  commandTemplateBytes: 16_384,
  /** Bytes of a prompt command expansion stored in `metadata.command.expansion`. */
  commandExpansionBytes: 65_536,
} as const

/** MIME families accepted by `POST /files` (the server also checks the content). */
export const UPLOAD_MIME_PATTERNS = ['image/*', 'application/pdf', 'text/*'] as const

/** True when `mime` (parameters such as `; charset=utf-8` are ignored) matches `UPLOAD_MIME_PATTERNS`. */
export function isAllowedUploadMime(mime: string): boolean {
  const type = (mime.split(';')[0] ?? '').trim().toLowerCase()
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(type))
    return false
  return UPLOAD_MIME_PATTERNS.some(pattern => (pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern))
}
