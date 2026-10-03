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
  /** Characters of global, project and chat instructions. */
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

  // Bulk data (ADR-024) and share links (ADR-025).
  /** `POST /data/import`: bytes of the uploaded backup zip or chat JSON. */
  backupImportBytes: 268_435_456,
  /** Entries of a backup zip, and items of its `files/index.json`. */
  backupEntriesMax: 50_000,
  /** Uncompressed bytes of one `chats/<chatId>.json` entry of a backup. */
  backupChatEntryBytes: 67_108_864,
  /** Messages (every version) of one chat in a chat export or a backup. */
  backupChatMessagesMax: 20_000,
  /** Serialized bytes of one share snapshot. */
  shareSnapshotBytes: 10_485_760,
  /** Characters of one tool input or output value in a share snapshot (`toolDetails`). */
  shareToolValueChars: 16_384,
  /** Share links of one chat. */
  sharesPerChatMax: 20,

  // Image generation (ADR-028) and voice (ADR-029).
  /** Images of one image turn and of one `generate_image` call (`ImageOptions.n`). */
  imagesPerTurnMax: 4,
  /** Input images of one image turn: the attached images, or the generated images of the previous reply. */
  imageInputsMax: 4,
  /** Bytes of one generated image stored as a file (= `uploadBytes`, so a backup restores every generated image). */
  generatedImageBytes: 20_971_520,
  /** Characters of an image prompt (the text of an image turn, the `generate_image` prompt). */
  imagePromptMaxChars: 32_000,
  /** `POST /audio/transcriptions`: bytes of the uploaded recording. */
  audioUploadBytes: 26_214_400,
  /** `POST /audio/speech`: characters of the text read aloud by one request. */
  speechTextMaxChars: 4096,
  /** Longest dictation the web records, in seconds (the server does not parse durations). */
  transcriptionMaxSeconds: 600,
  /** Read aloud: maximum characters of the first chunk of a reply (a fast start). */
  speechFirstChunkChars: 300,
  /** Read aloud: maximum characters of every later chunk. */
  speechChunkChars: 1500,

  // Agent workspace (ADR-031, ADR-032). The limits of the workspace tools are `WORKSPACE_LIMITS`.
  /** Characters of a project name. */
  projectNameMaxChars: 80,
  /** Projects of one server. */
  projectsMax: 200,
  /** Characters of a folder path on the server host (project paths, browse paths, workspace tool paths). */
  workspacePathMaxChars: 4096,
  /** Subfolders listed by one `GET /projects/browse` (the rest is cut, `truncated: true`). */
  browseEntriesMax: 500,
  /** Bytes of the project file (`AGENTS.md`, else `CLAUDE.md`, with its `@file` expansions) added to the instructions. */
  projectFileBytes: 32_768,
  /** Upper bound of the `maxSteps` and `projectMaxSteps` settings (steps of one agent run). */
  stepsMax: 200,

  // Workspace 2.0 (Phase 8): checkpoints and rewind (ADR-036), the changes panel and git (ADR-037), shell rules and the
  // working folder (ADR-038).
  /** Bytes of one stored before-state (8 MiB); a larger file is journaled as `too-large` and the edit still runs. */
  checkpointFileMaxBytes: 8_388_608,
  /** Bytes of the stored before-states of one project (512 MiB); the oldest are evicted above it (ADR-036). */
  checkpointProjectMaxBytes: 536_870_912,
  /** Age after which a stored before-state is evicted (30 days; the journal row stays, as `evicted`). */
  checkpointMaxAgeMs: 2_592_000_000,
  /** Files listed by `GET /chats/:id/changes` and `GET /chats/:id/rewind` (the rest is cut, `truncated`; ADR-037). */
  changesFilesMax: 500,
  /** `GET /chats/:id/changes`: only the first files get added / removed line counts (the rest `null`). */
  changesLineCountFiles: 200,
  /** `GET /chats/:id/changes`: text files up to this size (256 KiB) get line counts. */
  changesLineCountMaxBytes: 262_144,
  /** `GET /chats/:id/changes/diff`: bytes of each side of a diff (1 MiB); a larger side is `tooLarge`. */
  changeDiffSideMaxBytes: 1_048_576,
  /** Files listed by `GET /chats/:id/git` (the rest is cut, `truncated`; ADR-037). */
  gitStatusFilesMax: 2000,
  /** Timeout of one git command of the hardened runner (15 s; ADR-037). */
  gitTimeoutMs: 15_000,
  /** Bytes of the output of one git command (8 MiB); more fails the command. */
  gitOutputMaxBytes: 8_388_608,
  /** Shell commands and tool calls listed by a rewind preview (each list; ADR-036). */
  rewindUntrackedListMax: 50,
  /** Paths of one `workspace.changed` event (ADR-036). */
  workspaceEventPathsMax: 200,
  /** Shell rules per scope: one project, or the global list (ADR-038). */
  shellRulesPerScopeMax: 200,
  /** Characters of a shell rule prefix (ADR-038). */
  shellRulePrefixMaxChars: 200,
  /** Segments of one shell command the rule matcher accepts; a longer command always asks (ADR-038). */
  shellCommandSegmentsMax: 32,
  /** Characters of a shell command kept in the change journal (ADR-036). */
  journalCommandMaxChars: 1000,

  // Agent 2.0 (Phase 9): compaction (ADR-040), plan mode and todos (ADR-041), the steer queue and file mentions
  // (ADR-042), sub-agents (ADR-043).
  /** Characters of the summary of a `data-compaction` part. */
  compactionSummaryMaxChars: 60_000,
  /** Characters of the focus of `/compact [focus]`. */
  compactFocusMaxChars: 1000,
  /** Automatic compactions of one run; above it the run falls back to trimming. */
  compactionsPerRunMax: 10,
  /** Items of one `todo_write` list. */
  todoItemsMax: 50,
  /** Characters of the plan of `exit_plan_mode`. */
  planMaxChars: 50_000,
  /** Characters of the reason (feedback) of a tool approval response. */
  approvalReasonMaxChars: 2000,
  /** Characters of the prompt of a `task` call. */
  taskPromptMaxChars: 20_000,
  /** Characters of the final report of a sub-agent. */
  taskReportMaxChars: 32_000,
  /** Steps kept in a `task` output (the latest; the rest are counted in `stepsOmitted`). */
  taskStepsShownMax: 50,
  /** Sub-agents of one run that run at the same time (the others wait as `queued`). */
  subagentParallelMax: 3,
  /** Sub-agents one run can start. */
  subagentsPerRunMax: 20,
  /** Deadline of one sub-agent (570 s, below the 600 s timeout of the `task` tool). */
  subagentTimeoutMs: 570_000,
  /** Queued messages of one chat. */
  queueItemsMax: 10,
  /** Serialized bytes of one queued message (256 KiB). */
  queueItemBytes: 262_144,
  /** Characters of the query of `GET /projects/:id/files` (= the longest `@` token of the composer). */
  mentionQueryMaxChars: 256,
  /** Entries of one `GET /projects/:id/files` answer (also the maximum `limit`). */
  mentionResultsMax: 50,
  /** Bytes of a project file attached through `POST /projects/:id/files/attach` (5 MiB). */
  mentionFileMaxBytes: 5_242_880,
  /** Files of the in-memory file index of one project (the rest is cut, `truncated`). */
  mentionIndexFilesMax: 50_000,
  /** Age after which the file index of a project is rebuilt (30 s). */
  mentionIndexTtlMs: 30_000,
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
