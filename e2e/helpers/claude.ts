// Claude Code ecosystem helpers for the Phase 12 specs (docs/UI.md 2.19, 8.13, 9.14; ADR-053 … ADR-055): temporary
// folders outside the repository, file trees written into them or zipped, and the stub of the import dialog's
// `GET /api/claude-import/home`.
//
// - Fake Claude Code homes, Claude plugin folders and marketplace folders live in `realpath(mkdtemp())` folders below the
//   OS temp folder (`makeTempFolder`), **never inside the repository** (no `.claude/`, `.harness/`, `.claude-plugin/` or
//   `.mcp.json` may land in the checkout); `writeTree` refuses any folder inside the repository unless it is below its
//   `.tmp/` (project folders of the e2e server's workspace root). Every folder is removed after the spec (`cleanup`).
// - The trees mirror the shapes of the server's fixture builders (`apps/server/src/testing/claude-fixtures.ts`), copied
//   and trimmed for the specs: e2e never imports server code for them.
// - Marketplaces use local-folder sources only (no fake remote, no network: they work with `HF_OFFLINE=1`).
// - The server-side scan is never triggered: wherever the import dialog renders, `stubClaudeHome(page)` answers
//   `GET /api/claude-import/home` in the browser (the e2e servers run with `HF_CLAUDE_HOME=0` anyway).
import type { Page } from '@playwright/test'
import type { Buffer } from 'node:buffer'
import type { ClaudeImportHome } from '../../packages/shared/src/index.ts'
import type { ZipEntry } from '../fixtures/zip.ts'
import type { CleanupTask } from './fixtures.ts'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createZip } from '../fixtures/zip.ts'
import { REPO_ROOT } from './server.ts'

// ---------- trees ----------

/** One file of a tree: its text or bytes and, for scripts, its Unix mode (default 0644). */
export interface TreeFile {
  content: string | Uint8Array
  mode?: number
}

/** A file tree: plain relative POSIX paths to a text (mode 0644) or a `TreeFile`. */
export type FileTree = Readonly<Record<string, string | TreeFile>>

/** A script entry (mode 0755). */
export function script(content: string): TreeFile {
  return { content, mode: 0o755 }
}

/** The text of a JSON file (two-space indent, a final newline). */
export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** A markdown file with YAML frontmatter (values written as given; lists as `a, b`). */
export function frontmatterFile(fields: Readonly<Record<string, string | number | boolean | undefined>>, body: string): string {
  const lines = Object.entries(fields).flatMap(([key, value]) => (value === undefined ? [] : [`${key}: ${String(value)}`]))
  return `---\n${lines.join('\n')}\n---\n\n${body.endsWith('\n') ? body : `${body}\n`}`
}

/** Every path of `tree` below `folder/`. */
export function inFolder(folder: string, tree: FileTree): FileTree {
  const prefix = folder.replace(/\/+$/, '')
  return Object.fromEntries(Object.entries(tree).map(([path, entry]) => [`${prefix}/${path}`, entry]))
}

function entryOf(entry: string | TreeFile): Required<TreeFile> {
  return typeof entry === 'string' ? { content: entry, mode: 0o644 } : { content: entry.content, mode: entry.mode ?? 0o644 }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Whether `path` lies inside the repository but not below its `.tmp/`. */
async function insideRepository(path: string): Promise<boolean> {
  const repositories = [resolve(REPO_ROOT), await realpath(REPO_ROOT).catch(() => resolve(REPO_ROOT))]
  const targets = [resolve(path), await realpath(path).catch(() => resolve(path))]
  return targets.some(target => repositories.some(repository => isInside(repository, target) && !isInside(join(repository, '.tmp'), target)))
}

/**
 * Writes `tree` below `root` (folders created; scripts get their mode past the umask). `root` must be absolute and
 * outside the repository, or below its `.tmp/` (a project folder of the e2e workspace root).
 */
export async function writeTree(root: string, tree: FileTree): Promise<void> {
  if (!isAbsolute(root))
    throw new TypeError('writeTree needs an absolute folder.')
  if (await insideRepository(root))
    throw new TypeError(`writeTree refuses ${root}: it lies inside the repository (use makeTempFolder, or a folder below .tmp/).`)
  for (const path of Object.keys(tree).sort()) {
    if (path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..'))
      throw new TypeError(`The tree path ${JSON.stringify(path)} must be a plain relative POSIX path.`)
    const { content, mode } = entryOf(tree[path]!)
    const destination = join(root, ...path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content, { mode })
    await chmod(destination, mode)
  }
}

/** The zip of a tree (entries sorted, scripts with their Unix mode), optionally below one top folder. */
export function zipTree(tree: FileTree, options: { folder?: string } = {}): Buffer {
  const prefix = options.folder === undefined ? '' : `${options.folder.replace(/\/+$/, '')}/`
  const entries: ZipEntry[] = Object.keys(tree).sort().map((path) => {
    const { content, mode } = entryOf(tree[path]!)
    return { name: `${prefix}${path}`, data: content, ...(mode === 0o644 ? {} : { mode }) }
  })
  return createZip(entries)
}

// ---------- temporary folders ----------

export interface TempFolder {
  /** Its absolute path (a realpath: macOS `/var` is a link to `/private/var`). */
  path: string
  /** Removes the folder and everything in it. */
  remove: () => Promise<void>
}

/** A new empty folder below the OS temp folder (`hf-e2e-<label>-…`, outside the repository). */
export async function makeTempFolder(label: string): Promise<TempFolder> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `hf-e2e-${label}-`)))
  if (await insideRepository(path))
    throw new Error(`The OS temp folder ${path} lies inside the repository.`)
  return { path, remove: () => rm(path, { recursive: true, force: true }) }
}

/** `makeTempFolder` + `writeTree`, removed again through `cleanup` (registered first). */
export async function seedTempTree(cleanup: (task: CleanupTask) => void, label: string, tree: FileTree): Promise<TempFolder> {
  const folder = await makeTempFolder(label)
  cleanup(() => folder.remove())
  await writeTree(folder.path, tree)
  return folder
}

// ---------- the import dialog's server home ----------

/** What the e2e servers answer (`HF_CLAUDE_HOME=0`): scanning on the server is turned off. */
export const CLAUDE_HOME_DISABLED: ClaudeImportHome = { available: false, reason: 'disabled', path: null }

/**
 * Answers `GET /api/claude-import/home` in the browser (docs/API.md 4.35; open point 12): the import dialog's third
 * source never reaches the server. Returns a counter of the stubbed requests. `POST /api/claude-import/scan` is refused
 * in the browser too (a spec must never start a server-side scan).
 */
export async function stubClaudeHome(page: Page, home: ClaudeImportHome = CLAUDE_HOME_DISABLED): Promise<{ count: () => number, scans: () => number }> {
  let count = 0
  let scans = 0
  await page.route(url => url.pathname === '/api/claude-import/home', async (route) => {
    count += 1
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(home) })
  })
  await page.route(url => url.pathname === '/api/claude-import/scan', async (route) => {
    scans += 1
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'conflict', message: 'Scanning is turned off on this server (HF_CLAUDE_HOME=0).', details: { reason: 'disabled' } } }),
    })
  })
  return { count: () => count, scans: () => scans }
}
