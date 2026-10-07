// What the two intakes of the home-folder import collect (ADR-055; W12.3): the scan of `HF_CLAUDE_HOME`
// (./collect-disk.ts) and the upload of a picked folder or a zip (./collect-upload.ts) both admit files through one
// `HomeCollector`, so the same files give the same plan whatever the intake. The collector applies the allowlist
// (`classifyClaudeHomePath` of the shared `util/claude-import.ts`), the caps of `CLAUDE_HOME_LIMITS` (per file kind, per
// definition kind, 32 MiB in total) before anything is read, refuses a path collected twice, decodes UTF-8 strictly and
// reduces `.claude.json` at once to its MCP server maps (`extractClaudeJsonMcpServers`), so account data, keys and
// histories never stay in memory. Skipped paths carry a reason, never a content. Nothing here logs.
import type { ClaudeHomeFile, ClaudeHomeFileKind, ClaudeImportDiagnostic } from '@harness-forge/shared'
import { classifyClaudeHomePath, CLAUDE_HOME_LIMITS, extractClaudeJsonMcpServers, normalizeClaudeHomePath } from '@harness-forge/shared'

/** A file that was found but not used, and why (one short English phrase, never a content). */
export interface CollectedSkip {
  readonly path: string
  readonly reason: string
}

/** The files an intake collected (paths relative to the `.claude` folder, `.claude.json` as `CLAUDE_JSON_PATH`). */
export interface CollectedHome {
  readonly files: readonly ClaudeHomeFile[]
  readonly skipped: readonly CollectedSkip[]
  readonly diagnostics: readonly ClaudeImportDiagnostic[]
}

/** Characters of a skipped path kept in a plan. */
const SKIPPED_PATH_MAX_CHARS = 256

type DefinitionKind = 'agent' | 'command' | 'skill' | 'style'

const DEFINITION_KINDS: ReadonlySet<ClaudeHomeFileKind> = new Set(['agent', 'command', 'skill', 'style'])

const KIND_PLURALS: Readonly<Record<DefinitionKind, string>> = { agent: 'agents', command: 'commands', skill: 'skills', style: 'output styles' }

/** The byte cap of one file of each kind (`CLAUDE_HOME_LIMITS`). */
export const HOME_FILE_BYTE_CAPS: Readonly<Record<ClaudeHomeFileKind, number>> = {
  'agent': CLAUDE_HOME_LIMITS.definitionBytes,
  'command': CLAUDE_HOME_LIMITS.definitionBytes,
  'skill': CLAUDE_HOME_LIMITS.definitionBytes,
  'style': CLAUDE_HOME_LIMITS.definitionBytes,
  'settings': CLAUDE_HOME_LIMITS.settingsBytes,
  'instructions': CLAUDE_HOME_LIMITS.claudeMdBytes,
  'claude-json': CLAUDE_HOME_LIMITS.claudeJsonBytes,
}

/** `1 MiB`, `64 KiB` or `n bytes`. */
export function formatBytes(bytes: number): string {
  if (bytes % 1_048_576 === 0)
    return `${bytes / 1_048_576} MiB`
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`
}

/** A path as it may appear in a plan: control characters replaced, cut. */
export function shownPath(path: string): string {
  const line = path.replace(/[\p{Cc}\p{Cf}]/gu, '?')
  return line.length <= SKIPPED_PATH_MAX_CHARS ? line : `${line.slice(0, SKIPPED_PATH_MAX_CHARS - 3)}...`
}

/** What `admit` decided for a path: read it (within `maxBytes`), or not (already recorded as skipped). */
export type Admission
  = | { readonly ok: true, readonly path: string, readonly kind: ClaudeHomeFileKind, readonly maxBytes: number }
    | { readonly ok: false }

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Admits the files of one intake: `admit(path, size)` before a file is read (allowlist, duplicates, the per-kind and
 * total caps against the declared size), `add(admission, bytes, linked)` after (the actual size checked again, UTF-8,
 * `.claude.json` reduced). `result()` lists the files in path order.
 */
export class HomeCollector {
  readonly #files = new Map<string, ClaudeHomeFile>()
  readonly #skipped: CollectedSkip[] = []
  readonly #diagnostics: ClaudeImportDiagnostic[] = []
  readonly #seen = new Set<string>()
  readonly #perKind: Record<DefinitionKind, number> = { agent: 0, command: 0, skill: 0, style: 0 }
  #total = 0

  /** Records a path that is not read (shown without content). */
  skip(path: string, reason: string): void {
    this.#skipped.push({ path: shownPath(path), reason })
  }

  /** Records a problem of the whole intake (one English sentence, never a value). */
  diagnostic(level: ClaudeImportDiagnostic['level'], code: string, message: string): void {
    this.#diagnostics.push({ level, code, message })
  }

  /** Decides whether a file of `size` bytes (declared or `fstat`) at `path` is read; records the reason when not. */
  admit(path: string, size: number): Admission {
    const normalized = normalizeClaudeHomePath(path)
    const kind = normalized === null ? null : classifyClaudeHomePath(normalized)
    if (normalized === null || kind === null) {
      this.skip(path, 'not on the import allowlist')
      return { ok: false }
    }
    if (this.#seen.has(normalized)) {
      this.skip(normalized, 'listed twice')
      return { ok: false }
    }
    this.#seen.add(normalized)
    const cap = HOME_FILE_BYTE_CAPS[kind]
    if (!Number.isSafeInteger(size) || size < 0 || size > cap) {
      this.skip(normalized, `larger than ${formatBytes(cap)}`)
      return { ok: false }
    }
    if (this.#total + size > CLAUDE_HOME_LIMITS.totalBytes) {
      this.skip(normalized, `over the ${formatBytes(CLAUDE_HOME_LIMITS.totalBytes)} import limit`)
      return { ok: false }
    }
    if (DEFINITION_KINDS.has(kind)) {
      const definitionKind = kind as DefinitionKind
      if (this.#perKind[definitionKind] >= CLAUDE_HOME_LIMITS.definitionsPerKindMax) {
        this.skip(normalized, `more than ${CLAUDE_HOME_LIMITS.definitionsPerKindMax} ${KIND_PLURALS[definitionKind]}`)
        return { ok: false }
      }
      this.#perKind[definitionKind]++
    }
    this.#total += size
    return { ok: true, path: normalized, kind, maxBytes: cap }
  }

  /** Keeps the bytes of an admitted file (decoded as UTF-8; `.claude.json` reduced to its MCP server maps). */
  add(admission: Admission, bytes: Uint8Array, linked = false): void {
    if (!admission.ok)
      return
    if (bytes.byteLength > admission.maxBytes) {
      this.skip(admission.path, `larger than ${formatBytes(admission.maxBytes)}`)
      return
    }
    let text: string
    try {
      text = utf8.decode(bytes)
    }
    catch {
      this.skip(admission.path, 'not a text file')
      return
    }
    if (admission.kind === 'claude-json') {
      const reduced = reduceClaudeJson(text)
      text = ''
      for (const entry of reduced.diagnostics)
        this.diagnostic(entry.level, entry.code, entry.message)
      if (reduced.text === null)
        return
      text = reduced.text
    }
    this.#files.set(admission.path, linked ? { path: admission.path, text, linked: true } : { path: admission.path, text })
  }

  result(): CollectedHome {
    const files = [...this.#files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { files, skipped: [...this.#skipped], diagnostics: [...this.#diagnostics] }
  }
}

/**
 * `.claude.json` reduced to `{ mcpServers, projects: { <path>: { mcpServers } } }` (the only keys the planner reads):
 * every other key (accounts, keys, histories) is gone before the text is kept in a plan. The diagnostics of the
 * reduction (invalid JSON, unusable projects, too many projects) are returned here, so the planner, which reads the
 * reduced text again, does not repeat them; null when nothing could be read.
 */
export function reduceClaudeJson(text: string): { readonly text: string | null, readonly diagnostics: readonly ClaudeImportDiagnostic[] } {
  const extracted = extractClaudeJsonMcpServers(text)
  const failed = extracted.diagnostics.some(entry => entry.level === 'error')
  if (failed)
    return { text: null, diagnostics: extracted.diagnostics }
  const projects: Record<string, unknown> = {}
  for (const project of extracted.projects)
    Object.defineProperty(projects, project.path, { value: { mcpServers: project.servers }, enumerable: true, writable: true, configurable: true })
  return { text: JSON.stringify({ mcpServers: extracted.servers, projects }), diagnostics: extracted.diagnostics }
}
