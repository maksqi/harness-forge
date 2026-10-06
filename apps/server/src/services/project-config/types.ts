// Frozen interface of the project config reader (Phase 11, ADR-049 / ADR-050; ARCHITECTURE.md 6.29): the executable
// items of a project folder's settings files and `.mcp.json`, with their trust hashes. Implementation:
// `createProjectConfigService(deps)` in `services/project-config/index.ts` (C36 stub: an empty snapshot; W11.3
// implements the reads, the parsing, the hashing, the cache and `verify`). Consumers: the hook service (project hooks,
// W11.1), the project trust service (the items to review, W11.3), the project MCP manager (`.mcp.json` servers, W11.4),
// `GET /hooks?projectId` (W11.1) and shutdown (`stopDeps`: `stop()` after the customizations). Test double:
// `createFakeProjectConfigService` (`testing/fake-project-config.ts`), installed with `createTestApp({ projectConfig:
// 'fake' })`.
//
// Repository content is untrusted. The four settings files (`.claude/settings.json`, `.claude/settings.local.json`,
// `.harness/settings.json`, `.harness/settings.local.json`; only their `hooks` key) and `.mcp.json`, at the project root
// only, are read through `resolveWorkspacePath` / `openWorkspaceFile` (no link anywhere on the path, a regular file, at
// most 256 KiB before `JSON.parse`) and parsed only by the shared `readSettingsHooks` / `parseMcpJson`; problems are
// diagnostics with project-relative paths, never errors and never contents. Nothing is read from the home folder. The
// trust hash of an item is the sha256 (hex, `node:crypto`) of the shared `trustHashInput(item)`, which covers the item
// and the script files its command names (`extractCommandFileRefs` / `extractArgsFileRefs`, at most 8 files of at most
// 1 MiB, each read through the same path guard; a missing, linked or larger file is `sha256: null`).
import type {
  HookDiagnostic,
  HookSpec,
  McpConfigDiagnostic,
  McpJsonServer,
  TrustHashItem,
  TrustItemKind,
  TrustWarning,
} from '@harness-forge/shared'

/**
 * The hashed form of an executable item: what `verify` re-checks right before anything runs. `hashItem.refs` holds the
 * referenced files with their content hashes as scanned; `sha256` = sha256 of `trustHashInput(hashItem)`.
 */
export interface TrustSubject {
  readonly kind: TrustItemKind
  /** sha256 (lowercase hex) of `trustHashInput(hashItem)` at scan time: the value an approval pins. */
  readonly sha256: string
  /** The canonical item (`TrustHashItem`) with the referenced files and their sha256 at scan time. */
  readonly hashItem: TrustHashItem
}

/** What every executable item of a project folder has besides its hash. */
interface ProjectConfigItemBase extends TrustSubject {
  /** The project-relative file the item comes from (`.claude/settings.json`, `.mcp.json`). */
  readonly path: string
  /** A short label for lists (the command, the server name), at most 200 characters. */
  readonly label: string
  /** Review warnings (`referenced-file-missing`, `runs-repository-code`, `private-network`). */
  readonly warnings: readonly TrustWarning[]
}

/**
 * One hook handler of the project's settings files. Items whose spec has an `error` diagnostic are not listed (they
 * never run; their diagnostics are in `hookDiagnostics`); identical items (the same sha256) are listed once, in the
 * first file of the precedence order.
 */
export interface ProjectHookItem extends ProjectConfigItemBase {
  readonly kind: 'hook'
  /** The handler as read (event, matcher, command, timeout in seconds, position, file). */
  readonly spec: HookSpec
  readonly hashItem: Extract<TrustHashItem, { readonly kind: 'hook' }>
}

/** One server of the project's `.mcp.json` (unexpanded: `${VAR}` references kept). */
export interface ProjectMcpServerItem extends ProjectConfigItemBase {
  readonly kind: 'mcp'
  /** The parsed server (name, harness id, normalized transport, the raw object that is hashed). */
  readonly server: McpJsonServer
  readonly hashItem: Extract<TrustHashItem, { readonly kind: 'mcp' }>
}

/** An executable item of the project's settings files or `.mcp.json`. */
export type ProjectConfigItem = ProjectHookItem | ProjectMcpServerItem

/**
 * One read of a project folder's settings files and `.mcp.json` (cached per project for 10 s, single-flight builds).
 * Immutable. An unknown project or a folder that does not open gives `available: false` with the reason and no items.
 */
export interface ProjectConfigSnapshot {
  readonly projectId: string
  /** The project folder opened (`openWorkspace`); false = no items (`issue` says why). */
  readonly available: boolean
  /** Why the folder is not available (safe to show); null when `available`. */
  readonly issue: string | null
  /** The canonical project root of the read; null when not available. */
  readonly root: string | null
  /** The settings files that exist and were read, project-relative, lowest precedence first (at most 4). */
  readonly settingsFiles: readonly string[]
  /** `.mcp.json` exists and was read. */
  readonly mcpFile: boolean
  /** The hook items of every settings file, in precedence order. */
  readonly hooks: readonly ProjectHookItem[]
  /** The servers of `.mcp.json`, in file order. */
  readonly mcpServers: readonly ProjectMcpServerItem[]
  /** Diagnostics of the settings files (invalid, oversized, linked or unreadable files; invalid handlers). */
  readonly hookDiagnostics: readonly HookDiagnostic[]
  /** Diagnostics of `.mcp.json`. */
  readonly mcpDiagnostics: readonly McpConfigDiagnostic[]
  /** When the folder was read (epoch ms). */
  readonly scannedAt: number
}

/** Options of `ProjectConfigService.snapshot`. */
export interface ProjectConfigSnapshotOptions {
  /** Aborts the wait for a build (the build itself goes on for the other waiters). */
  readonly signal?: AbortSignal
  /** Read the folder now instead of serving the cached snapshot (trust approvals, `GET /projects/:id/trust`). */
  readonly refresh?: boolean
}

/** The project config reader. Frozen after P11-0b. */
export interface ProjectConfigService {
  /**
   * The executable items of the project's settings files and `.mcp.json`, served from the per-project cache (TTL
   * 10 s, single flight) unless `options.refresh`. Never rejects for a folder or file problem (`available: false` or
   * diagnostics); rejects only when `options.signal` aborts or the database fails.
   */
  readonly snapshot: (projectId: string, options?: ProjectConfigSnapshotOptions) => Promise<ProjectConfigSnapshot>
  /**
   * Verify-before-run: re-reads the referenced files of `item` (`item.hashItem.refs`, through the path guard of the
   * project's current root) and recomputes the sha256 of `trustHashInput`; true when it still equals `item.sha256`.
   * Called right before a hook process, a project MCP server or a command `!` span starts; false (also for an unknown
   * project or a folder that does not open) means the item is skipped as pending. Never rejects except on abort.
   */
  readonly verify: (projectId: string, item: TrustSubject, signal?: AbortSignal) => Promise<boolean>
  /**
   * Drops the cached snapshot of a project (a build in flight is not kept); null drops every cached snapshot. Called by
   * the service itself on `workspace.changed`, `project.changed` and `run.finished` of a chat of the project. Never
   * throws.
   */
  readonly invalidate: (projectId: string | null) => void
  /** Shutdown (`stopDeps`, after the customizations): drops the caches and the subscriptions. Idempotent; never throws. */
  readonly stop: () => void
}
