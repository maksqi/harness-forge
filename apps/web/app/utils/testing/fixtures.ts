// Test helper (not app code): DTO factories with valid defaults, overridable per test.
import type {
  AuthStatus,
  CatalogModel,
  ChatChangeFile,
  ChatChanges,
  ChatDetail,
  ChatSummary,
  DataCleanupPreview,
  DataCleanupResult,
  DataSummary,
  FileDiff,
  FileSweepStatus,
  GitStatus,
  GitStatusFile,
  HarnessUIMessage,
  KeyStatus,
  MessageBranch,
  PluginDetail,
  PluginLogEntry,
  PluginSummary,
  ProjectSummary,
  ProviderSummary,
  RestoreResult,
  RewindPreview,
  Settings,
  ShellOutput,
  ShellRule,
  ToolSummary,
  WorkspaceChangedData,
} from '@harness-forge/shared'
import type { ChangesRow } from '~/components/workspace/changes/changes-rows'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'

/** A fixed uuidv7 chat id with a varying last group: chatId(1) -> '...000000000001'. */
export function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${String(n).padStart(12, '0')}`
}

/** A valid message id (`msg_` + 16 characters) from a short label: messageId('u1') -> 'msg_u100000000000000'. */
export function messageId(label: string): string {
  return `msg_${label.replace(/[^\dA-Z]/gi, '').slice(0, 16).padEnd(16, '0')}`
}

/** A user message with one text part. */
export function userMessage(id: string, text: string, overrides: Partial<HarnessUIMessage> = {}): HarnessUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }], ...overrides }
}

/** A finished assistant message with one text part. */
export function assistantMessage(id: string, text: string, overrides: Partial<HarnessUIMessage> = {}): HarnessUIMessage {
  return {
    id,
    role: 'assistant',
    metadata: { modelRef: 'mock:echo', startedAt: 1_759_000_000_000 },
    parts: [{ type: 'text', text, state: 'done' }],
    ...overrides,
  }
}

/** `ChatDetail.branches[id]`: the versions of a message and the position of the shown one. */
export function messageBranch(siblings: string[], index: number): MessageBranch {
  return { siblings, index }
}

export function authStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return { enabled: false, authenticated: true, source: null, freshUntil: null, ...overrides }
}

export function chatSummary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: chatId(1),
    title: 'Chat',
    titleSource: 'auto',
    modelRef: 'mock:echo',
    pinned: false,
    archived: false,
    running: false,
    pendingApproval: false,
    projectId: null,
    createdAt: 1_759_000_000_000,
    updatedAt: 1_759_000_000_000,
    ...overrides,
  }
}

/** A fixed project id with a varying end: projectId(1) -> 'prj_sample0000000001'. */
export function projectId(n: number): string {
  return `prj_sample${String(n).padStart(10, '0')}`
}

export function projectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: projectId(1),
    name: 'Website',
    path: '/srv/workspaces/website',
    instructions: null,
    available: true,
    issue: null,
    instructionsFile: null,
    chatCount: 0,
    createdAt: 1_759_000_000_000,
    updatedAt: 1_759_000_000_000,
    ...overrides,
  }
}

export function chatDetail(overrides: Partial<ChatDetail> = {}): ChatDetail {
  return {
    ...chatSummary(),
    settings: {},
    messages: [],
    branches: {},
    totals: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
    ...overrides,
  }
}

export function providerSummary(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    pluginId: 'core-providers',
    icon: { color: '/api/icons/lobe/claude-color', mono: '/api/icons/lobe/claude' },
    enabled: true,
    status: 'connected',
    credentialFields: [],
    credentials: {},
    keyUrl: null,
    local: false,
    modelCount: 3,
    modelsFetchedAt: null,
    lastError: null,
    validatedAt: null,
    ...overrides,
  }
}

export function catalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  const providerId = overrides.providerId ?? 'anthropic'
  const id = overrides.id ?? 'claude-sonnet-5'
  return {
    ref: `${providerId}:${id}`,
    providerId,
    id,
    name: id,
    alias: null,
    kind: 'chat',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: { tools: true, vision: true, pdf: false, reasoning: true, structuredOutput: true, imageOutput: false },
    reasoningEfforts: [],
    cost: null,
    favorite: false,
    hidden: false,
    custom: false,
    source: 'seed',
    lastUsedAt: null,
    ...overrides,
  }
}

export function pluginSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'dice-roller',
    name: 'Dice roller',
    version: '1.0.0',
    description: 'Rolls dice',
    icon: null,
    kind: 'code',
    source: 'created',
    sourceRef: null,
    builtin: false,
    removable: true,
    enabled: true,
    state: 'active',
    runsCode: true,
    contributions: { providers: [], models: 0, tools: ['roll_dice'], mcpServers: [], commands: [], hooks: [] },
    lastError: null,
    installedAt: 1_759_000_000_000,
    updatedAt: 1_759_000_000_000,
    ...overrides,
  }
}

export function pluginDetail(overrides: Partial<PluginDetail> = {}): PluginDetail {
  const summary = pluginSummary(overrides)
  return {
    ...summary,
    manifest: { id: summary.id, name: summary.name, version: summary.version, main: 'index.mjs' } as PluginDetail['manifest'],
    trust: { required: true, trusted: true, hash: 'a'.repeat(64), trustedHash: 'a'.repeat(64) },
    editable: true,
    hasSettings: false,
    ...overrides,
  }
}

export function toolSummary(overrides: Partial<ToolSummary> = {}): ToolSummary {
  return {
    name: 'roll_dice',
    title: null,
    description: 'Roll dice',
    pluginId: 'dice-roller',
    mcpServerId: null,
    policy: 'safe',
    enabled: true,
    override: null,
    available: true,
    workspace: null,
    inputSchema: {},
    ...overrides,
  }
}

export function keyStatus(overrides: Partial<KeyStatus> = {}): KeyStatus {
  return {
    source: 'file',
    keyVersion: 1,
    rotatedAt: null,
    keyCheck: 'ok',
    secrets: 0,
    unreadableSecrets: 0,
    shares: 0,
    pendingApprovals: 0,
    canRotate: true,
    ...overrides,
  }
}

/**
 * The global settings: the defaults (`fileSweep: 'off'`, and the Phase 9 keys `autoCompact: true`, `compactModelRef:
 * null`, `subagentModelRef: null`, `subagentMaxSteps: 30`, `shiftTabModes: true` included) with overrides.
 */
export function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

/** The automatic file sweep state (ADR-039): off, never ran. */
export function fileSweepStatus(overrides: Partial<FileSweepStatus> = {}): FileSweepStatus {
  return { mode: 'off', lastAttempt: null, nextRunAt: null, ...overrides }
}

export function dataSummary(overrides: Partial<DataSummary> = {}): DataSummary {
  return { chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0, fileSweep: fileSweepStatus(), ...overrides }
}

export function dataCleanupPreview(overrides: Partial<DataCleanupPreview> = {}): DataCleanupPreview {
  return {
    files: 0,
    fileBytes: 0,
    blobs: 0,
    diskBytes: 0,
    tempFiles: 0,
    recentFiles: 0,
    graceMs: 86_400_000,
    lastRunAt: null,
    fileSweep: fileSweepStatus(),
    pluginData: 'complete',
    ...overrides,
  }
}

export function dataCleanupResult(overrides: Partial<DataCleanupResult> = {}): DataCleanupResult {
  return { files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, ranAt: 1_759_000_000_000, pluginData: 'complete', ...overrides }
}

// ---------- workspace 2.0 (Phase 8) ----------

/** A fixed change batch id with a varying end: changeBatchId(1) -> 'wcb_sample0000000001'. */
export function changeBatchId(n: number): string {
  return `wcb_sample${String(n).padStart(10, '0')}`
}

/** A fixed shell rule id with a varying end: shellRuleId(1) -> 'srl_sample0000000001'. */
export function shellRuleId(n: number): string {
  return `srl_sample${String(n).padStart(10, '0')}`
}

/** One file of the "This chat" view: `src/index.ts` modified by one edit (+1 -1). */
export function chatChangeFile(overrides: Partial<ChatChangeFile> = {}): ChatChangeFile {
  return {
    path: 'src/index.ts',
    status: 'modified',
    edits: 1,
    changedOutside: false,
    revertible: true,
    added: 1,
    removed: 1,
    lastEditAt: 1_759_000_000_000,
    ...overrides,
  }
}

/** `GET /chats/:id/changes` of a project chat with one changed file. */
export function chatChanges(overrides: Partial<ChatChanges> = {}): ChatChanges {
  return {
    available: true,
    reason: null,
    projectId: projectId(1),
    files: [chatChangeFile()],
    truncated: false,
    untracked: { shellCommands: 0, toolCalls: 0 },
    ...overrides,
  }
}

/** `GET /chats/:id/changes/diff` of `src/index.ts` (one changed line). */
export function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    source: 'chat',
    path: 'src/index.ts',
    origPath: null,
    status: 'modified',
    binary: false,
    tooLarge: false,
    diff: {
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-export const answer = 41', '+export const answer = 42'] }],
      added: 1,
      removed: 1,
      truncated: false,
    },
    currentSha: 'c'.repeat(64),
    baseAvailable: true,
    ...overrides,
  }
}

/** One file of the "Git" view: `src/index.ts` modified in the work tree. */
export function gitStatusFile(overrides: Partial<GitStatusFile> = {}): GitStatusFile {
  return { path: 'src/index.ts', origPath: null, status: 'modified', staged: false, unstaged: true, ...overrides }
}

/** `GET /chats/:id/git` of a repository on `main` with one modified file. */
export function gitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    available: true,
    reason: null,
    branch: 'main',
    head: 'd'.repeat(40),
    prefix: '',
    files: [gitStatusFile()],
    truncated: false,
    ...overrides,
  }
}

/** `GET /chats/:id/rewind` of the user message `msg_u1...`: one file to restore and one shell command. */
export function rewindPreview(overrides: Partial<RewindPreview> = {}): RewindPreview {
  return {
    messageId: messageId('u1'),
    files: [{ path: 'checkpoint.txt', action: 'restore', conflict: false, edits: 1 }],
    untracked: {
      shellCount: 1,
      shell: [{ command: 'mkdir -p mock-dir && cd mock-dir', at: 1_759_000_000_000, messageId: messageId('a1') }],
      tools: [],
    },
    truncated: false,
    ...overrides,
  }
}

/** The answer of a revert, an undo or a rewind that restored one file. */
export function restoreResult(overrides: Partial<RestoreResult> = {}): RestoreResult {
  return { batchId: changeBatchId(1), restored: ['src/index.ts'], deleted: [], unchanged: [], skipped: [], ...overrides }
}

/** One row of the changes panel (This chat view): `src/index.ts` modified by one edit (+1 -1), revertible. */
export function changesRow(overrides: Partial<ChangesRow> = {}): ChangesRow {
  return {
    path: 'src/index.ts',
    origPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changedOutside: false,
    revertible: true,
    edits: 1,
    staged: null,
    unstaged: null,
    ...overrides,
  }
}

/** A shell rule of project 1. */
export function shellRule(overrides: Partial<ShellRule> = {}): ShellRule {
  return { id: shellRuleId(1), projectId: projectId(1), prefix: 'pnpm test', createdAt: 1_759_000_000_000, ...overrides }
}

/** The data of a `workspace.changed` event of an agent tool edit in chat 1. */
export function workspaceChangedData(overrides: Partial<WorkspaceChangedData> = {}): WorkspaceChangedData {
  return { projectId: projectId(1), chatId: chatId(1), batchId: null, source: 'tool', paths: ['src/index.ts'], ...overrides }
}

/** A finished `shell` output (exit code 0) that ended in the project folder. */
export function shellOutput(overrides: Partial<ShellOutput> = {}): ShellOutput {
  return {
    command: 'ls',
    cwd: '.',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 12,
    stdout: 'README.md\n',
    stderr: '',
    stdoutBytes: 10,
    stderrBytes: 0,
    endCwd: '.',
    ...overrides,
  }
}

export function logEntry(seq: number, overrides: Partial<PluginLogEntry> = {}): PluginLogEntry {
  return { seq, at: 1_759_000_000_000 + seq, level: 'info', message: `entry ${seq}`, ...overrides }
}
