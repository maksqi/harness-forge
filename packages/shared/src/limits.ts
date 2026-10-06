// Size and count limits shared by the web app and the server (API.md section 3.4).
//
// This module imports nothing: the helper modules under `util/` import `LIMITS` (directly or through `schemas/`), so an
// import from `util/` here would close a cycle (a TDZ error at load). Values mirrored by a `util/` constant
// (`DEFINITION_LIMITS`, `HOOK_LIMITS`, `TRUST_LIMITS`, `MCP_CONFIG_LIMITS`, `COMMAND_TEMPLATE_LIMITS`, Phase 12:
// `CLAUDE_PLUGIN_LIMITS`, `CLAUDE_HOME_LIMITS`) are literals here, and `limits.test.ts` checks that they are equal.

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

  // Agent customization (Phase 10): the catalog and definition files (ADR-044), custom agents, commands and skills
  // (ADR-045), background sub-agents (ADR-046), plan files and Remember (ADR-047).
  /** UTF-8 bytes of one definition file or stored definition (= `DEFINITION_LIMITS.contentBytes`, 64 KiB). */
  customizationContentBytes: 65_536,
  /** UTF-8 bytes of the frontmatter block of a definition (= `DEFINITION_LIMITS.frontmatterBytes`, 8 KiB). */
  customizationFrontmatterBytes: 8192,
  /** Definition files read from one project folder (the rest is left out with a `limit` diagnostic). */
  customizationFilesPerFolderMax: 200,
  /** Characters of a definition `description` (= `DEFINITION_LIMITS.descriptionMaxChars`). */
  customizationDescriptionMaxChars: 1024,
  /** Personal agents, commands or skills (each kind). */
  customizationsPerKindMax: 200,
  /** Age after which the catalog of a project is rebuilt (10 s). */
  customizationIndexTtlMs: 10_000,
  /** Agent types listed in the run instructions. */
  agentTypesListedMax: 30,
  /** Skills listed in the run instructions. */
  skillsListedMax: 50,
  /** Characters of one description in the agent type and skill listings of the run instructions. */
  listedDescriptionMaxChars: 250,
  /** Supporting files of a project skill listed by the `skill` tool. */
  skillFilesListedMax: 50,
  /** Characters of the text of one `POST /memory`. */
  rememberTextMaxChars: 2000,
  /** Bytes of the project file (`AGENTS.md` / `CLAUDE.md`) after a Remember append (1 MiB). */
  rememberFileMaxBytes: 1_048_576,
  /** Background tasks of one chat that run at the same time. */
  backgroundTasksPerChatMax: 3,
  /** Background tasks of the whole server that run at the same time. */
  backgroundTasksMax: 10,
  /** Deadline of one background task (30 min). */
  backgroundTaskTimeoutMs: 1_800_000,
  /** Finished background task rows kept per chat (the oldest are deleted above it). */
  backgroundTasksKeptPerChat: 100,

  // Hooks, trust, project MCP and output styles (Phase 11): command hooks (ADR-048), project trust (ADR-049), project
  // `.mcp.json` servers (ADR-050), command `!` spans and `@` files (ADR-052). Mirrors: `HOOK_LIMITS`, `TRUST_LIMITS`,
  // `MCP_CONFIG_LIMITS`, `COMMAND_TEMPLATE_LIMITS` (`util/{hooks,trust,mcp-config,command-template}.ts`).
  /** Default timeout of one command hook (60 s; a hook's own `timeout` is in seconds, Claude Code parity). */
  hookTimeoutDefaultMs: 60_000,
  /** Maximum timeout of one command hook (600 s). */
  hookTimeoutMaxMs: 600_000,
  /** Matching hooks run for one event (in parallel; the rest are skipped with a diagnostic). */
  hooksPerEventMax: 20,
  /** Personal hooks (table `hooks`). */
  personalHooksMax: 100,
  /** Command hook processes of the whole server that run at the same time (the others wait). */
  hookProcessesMax: 16,
  /** Bytes of the stdin payload of one hook (`tool_response`, then `tool_input` are cut to fit). */
  hookPayloadBytes: 262_144,
  /** Bytes of the stdout kept from one hook run. */
  hookStdoutBytes: 65_536,
  /** Bytes of the stderr kept from one hook run. */
  hookStderrBytes: 16_384,
  /** Characters of a hook command. */
  hookCommandMaxChars: 4096,
  /** Characters of a hook matcher. */
  hookMatcherMaxChars: 200,
  /** Characters of the label of a hook (a hook record entry, the run log). */
  hookLabelMaxChars: 200,
  /** Characters of the model-visible context of one event (`data-hook` `context`, every handler joined). */
  hookContextMaxChars: 10_000,
  /** Characters of a block or decision reason (`data-hook` `reason`). */
  hookReasonMaxChars: 2000,
  /** Characters of a hook's `systemMessage` and of the error of one hook in a `data-hook` part. */
  hookSystemMessageMaxChars: 2000,
  /** Serialized bytes of a `PreToolUse` `updatedInput` (64 KiB). */
  hookUpdatedInputBytes: 65_536,
  /** `Stop` hook continuations in a row (turns with run origin `hook`); then notice `hook-continuation-limit`. */
  hookContinuationsMax: 5,
  /** Extra rounds a `SubagentStop` hook can give one sub-agent. */
  subagentStopContinuationsMax: 2,
  /** Entries of the hook run log (`GET /hooks/runs`, in memory; the oldest are dropped). */
  hookRunsKept: 200,
  /** Characters of the error of one run log entry. */
  hookRunErrorMaxChars: 500,
  /** Entries of `GET /hooks` (personal, project and plugin hooks together). */
  hookListItemsMax: 300,
  /** Command hook handlers of one plugin (`contributes.hooks`, plugin API 1.5.0). */
  pluginHooksMax: 50,
  /** Output styles of one plugin (`contributes.outputStyles`, plugin API 1.5.0). */
  pluginOutputStylesMax: 20,
  /** Bytes of one project settings file read for its `hooks` key (`.claude` / `.harness` `settings{,.local}.json`). */
  projectSettingsFileBytes: 262_144,
  /** Hook handlers of one project (every settings file together). */
  projectHookItemsMax: 100,
  /** Bytes of a project `.mcp.json`. */
  projectMcpFileBytes: 262_144,
  /** Servers of a project `.mcp.json`. */
  projectMcpServersMax: 20,
  /** Variables of the project MCP servers of one project (`${VAR}` names with a stored value). */
  projectMcpVariablesMax: 50,
  /** Characters of one project MCP variable value. */
  projectMcpVariableValueMaxChars: 4096,
  /** Tools listed per project MCP server. */
  projectMcpToolsMax: 1000,
  /** How long the first run of a project chat waits for its MCP servers (else notice `project-mcp-unavailable`). */
  projectMcpConnectWaitMs: 5000,
  /** Idle time after which a project MCP server stops (10 min). */
  projectMcpIdleMs: 600_000,
  /** Executable items listed by `GET /projects/:id/trust`. */
  trustItemsMax: 200,
  /** Items of one `POST /projects/:id/trust`. */
  trustApproveItemsMax: 50,
  /** Script files a command names that are hashed into its trust hash. */
  trustRefFilesMax: 8,
  /** Bytes of one referenced script file (a larger one is hashed as missing). */
  trustRefFileBytes: 1_048_576,
  /** `` !`cmd` `` spans of one command file. */
  commandShellSpansMax: 10,
  /** Timeout of one span. */
  commandShellTimeoutMs: 30_000,
  /** Time all spans of one command may take together. */
  commandShellTotalMs: 60_000,
  /** Bytes of the output kept per span. */
  commandShellOutputBytes: 16_384,
  /** `@path` files inlined by one command file. */
  commandFileRefsMax: 10,
  /** Bytes inlined per `@path` file. */
  commandFileRefBytes: 32_768,

  // Claude Code ecosystem (Phase 12): Claude Code plugins (ADR-053), marketplaces and archive sources (ADR-054), the
  // home-folder import (ADR-055), project definition files (ADR-056), prompt hooks, new events and transcripts
  // (ADR-057), frontmatter compatibility (ADR-058). Mirrors: `CLAUDE_PLUGIN_LIMITS` (`util/claude-plugins.ts`) and
  // `CLAUDE_HOME_LIMITS` (`util/claude-import.ts`).
  /** Bytes of a Claude Code `.claude-plugin/plugin.json` (checked before `JSON.parse`). */
  claudePluginManifestBytes: 262_144,
  /** Bytes of a `.claude-plugin/marketplace.json` (and of a stored marketplace catalog). */
  marketplaceJsonBytes: 1_048_576,
  /** Entries of one marketplace (the rest are dropped with a diagnostic). */
  marketplaceEntriesMax: 1000,
  /** Commands, agents or skills of one Claude Code plugin (each kind). */
  claudeComponentsPerKindMax: 100,
  /** Output styles of one Claude Code plugin. */
  claudeOutputStylesMax: 20,
  /** `userConfig` options of one Claude Code plugin (= the plugin settings properties limit). */
  claudeUserConfigMax: 50,
  /** Characters of a qualified catalog name `<pluginId>:<name>` (`QUALIFIED_NAME_PATTERN`). */
  qualifiedNameMaxChars: 128,
  /** Segments after the plugin id of a qualified catalog name. */
  qualifiedNameSegmentsMax: 3,
  /** Diagnostics of one Claude Code plugin or marketplace (inspection, detail). */
  claudePluginDiagnosticsMax: 200,
  /** Executable items listed by a Claude Code plugin inspection (what the trust consent shows). */
  claudePluginExecutablesMax: 200,
  /** Marketplaces of one server. */
  marketplacesMax: 50,
  /** Compressed bytes of a GitHub repository archive (50 MiB; the plugin subtree still obeys the install caps). */
  repoArchiveBytes: 52_428_800,
  /** UTF-8 bytes of one supporting file the `skill` tool reads (`file` input; larger files are cut). */
  skillFileReadBytes: 65_536,
  /** Bytes of one definition file read by the import (agent, command, skill, output style). */
  claudeImportDefinitionBytes: 65_536,
  /** Definitions of one kind read by the import. */
  claudeImportDefinitionsPerKindMax: 200,
  /** Subfolder levels below `commands/` read by the import. */
  claudeImportCommandDepthMax: 3,
  /** Bytes of the imported `settings.json`. */
  claudeImportSettingsBytes: 262_144,
  /** Bytes of the imported `CLAUDE.md`. */
  claudeMdBytes: 1_048_576,
  /** Bytes of `~/.claude.json` (read whole, reduced to its `mcpServers` maps at once). */
  claudeJsonBytes: 16_777_216,
  /** Bytes of one import (every file together; also the multipart upload limit of `POST /claude-import/upload`). */
  claudeImportBytesMax: 33_554_432,
  /** Items of one import plan. */
  claudeImportItemsMax: 1000,
  /** Skipped files listed by one import plan. */
  claudeImportSkippedMax: 200,
  /** Characters of the summary of an import plan item (never values). */
  claudeImportSummaryMaxChars: 300,
  /** Lifetime of an import plan held by the server (10 min). */
  claudeImportPlanTtlMs: 600_000,
  /** Import plans held by the server at the same time (the oldest is dropped). */
  claudeImportPlansMax: 4,
  /** Deadline of one home-folder scan (10 s). */
  claudeImportScanTimeoutMs: 10_000,
  /** Default timeout of one prompt hook (30 s; a handler's own `timeout` is in seconds, at most `hookTimeoutMaxMs`). */
  promptHookTimeoutDefaultMs: 30_000,
  /** Characters of a prompt hook's `prompt`. */
  promptHookPromptMaxChars: 16_384,
  /** Output tokens of one prompt hook answer. */
  promptHookMaxOutputTokens: 512,
  /** Prompt hook model calls of the whole server that run at the same time (the others wait). */
  hookModelCallsMax: 8,
  /** Bytes of the `error` of a `PostToolUseFailure` payload. */
  hookErrorBytes: 16_384,
  /** Bytes of one hook transcript (`<dataDir>/transcripts/<chatId>.jsonl`; the oldest messages are dropped above it). */
  transcriptBytesMax: 8_388_608,
  /** Bytes of one part of a transcript line (text, tool input). */
  transcriptPartBytes: 65_536,
  /** Bytes of one tool result in a transcript line. */
  transcriptToolResultBytes: 16_384,
  /** Time the `SessionEnd` hooks of a chat delete get by default (1.5 s; raised by explicit handler timeouts). */
  sessionEndBudgetMs: 1500,
  /** Longest `SessionEnd` budget an explicit handler timeout can ask for (60 s). */
  sessionEndBudgetMaxMs: 60_000,
  /** Skills an agent definition preloads (`skills` frontmatter key). */
  agentSkillsPreloadMax: 5,
  /** Bytes of the preloaded skills added to a child's instructions (32 KiB). */
  agentSkillsPreloadBytes: 32_768,
  /** Upper bound of an agent's `maxTurns` (= `stepsMax`). */
  agentMaxTurnsMax: 200,
  /** Named `arguments` of a command or skill. */
  definitionArgumentsMax: 9,
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
