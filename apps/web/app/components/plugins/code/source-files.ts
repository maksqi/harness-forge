// File helpers of the Source tab (docs/UI.md 8.10, docs/API.md 5.18): editor languages by extension, the nested file
// tree built from the flat listing, new-file path rules, the byte columns of build diagnostics and small formatters.
import type { BuildDiagnostic, PluginFileEntry } from '@harness-forge/shared'
import { pluginFilePathSchema } from '@harness-forge/shared'

export type SourceLanguage = 'javascript' | 'typescript' | 'json' | 'markdown' | 'text'

/** Extensions offered for new files (docs/UI.md 8.10). */
export const NEW_FILE_EXTENSIONS = ['.js', '.mjs', '.ts', '.json', '.md'] as const

/** The editor language of a path: `.js/.mjs/.cjs` JavaScript, `.ts/.mts/.cts` TypeScript, JSON, Markdown, else text. */
export function languageOf(path: string): SourceLanguage {
  const lower = path.toLowerCase()
  if (/\.(?:[cm]?js|jsx)$/.test(lower))
    return 'javascript'
  if (/\.(?:[cm]?ts|tsx)$/.test(lower))
    return 'typescript'
  if (lower.endsWith('.json'))
    return 'json'
  if (lower.endsWith('.md') || lower.endsWith('.markdown'))
    return 'markdown'
  return 'text'
}

/** Last segment of a relative path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Folder part of a relative path ('' at the root). */
export function folderOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  /** The listing entry (folders created implicitly by a deeper file have none). */
  entry: PluginFileEntry | null
  children: FileTreeNode[]
}

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  for (const node of nodes)
    sortNodes(node.children)
  return nodes
}

/** Nested tree of the flat listing: folders first, then files, each by name. */
export function buildFileTree(entries: readonly PluginFileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = []
  const folders = new Map<string, FileTreeNode>()
  const folder = (path: string): FileTreeNode[] => {
    if (path === '')
      return root
    let node = folders.get(path)
    if (!node) {
      node = { name: baseName(path), path, type: 'dir', entry: null, children: [] }
      folders.set(path, node)
      folder(folderOf(path)).push(node)
    }
    return node.children
  }
  for (const entry of entries) {
    if (entry.type === 'dir') {
      folder(entry.path)
      const node = folders.get(entry.path)
      if (node)
        node.entry = entry
    }
    else {
      folder(folderOf(entry.path)).push({ name: baseName(entry.path), path: entry.path, type: 'file', entry, children: [] })
    }
  }
  return sortNodes(root)
}

/** Every folder path of a tree (for "expand all"). */
export function folderPaths(nodes: readonly FileTreeNode[]): string[] {
  return nodes.flatMap(node => (node.type === 'dir' ? [node.path, ...folderPaths(node.children)] : []))
}

export interface ExistingPaths {
  files: ReadonlySet<string>
  folders: ReadonlySet<string>
}

/** Paths of the listing, split into files and folders (letter case folded: file systems may ignore it). */
export function existingPaths(entries: readonly PluginFileEntry[]): ExistingPaths {
  const files = new Set<string>()
  const folders = new Set<string>()
  for (const entry of entries)
    (entry.type === 'dir' ? folders : files).add(entry.path.toLowerCase())
  return { files, folders }
}

/** The problem with the path of a new (or renamed) file, or null. */
export function newFilePathProblem(path: string, existing: ExistingPaths): string | null {
  const trimmed = path.trim()
  if (trimmed === '')
    return 'Enter a file name.'
  if (!pluginFilePathSchema.safeParse(trimmed).success)
    return 'Use a relative path such as lib/util.mjs: letters, digits, ".", "_" and "-", separated by "/".'
  if (trimmed.split('/').some(segment => segment.startsWith('.')))
    return 'Hidden files and folders (names starting with ".") cannot be created here.'
  if (!NEW_FILE_EXTENSIONS.some(extension => trimmed.toLowerCase().endsWith(extension)))
    return `Use one of these extensions: ${NEW_FILE_EXTENSIONS.join(', ')}.`
  const folded = trimmed.toLowerCase()
  if (existing.files.has(folded) || existing.folders.has(folded))
    return 'A file or folder with this name already exists.'
  for (let folder = folderOf(folded); folder !== ''; folder = folderOf(folder)) {
    if (existing.files.has(folder))
      return `"${folder}" is a file, not a folder.`
  }
  return null
}

/**
 * The 0-based UTF-16 index of a 1-based UTF-8 byte column (esbuild reports byte columns). `lineText` is the line the
 * column belongs to.
 */
export function byteColumnToIndex(lineText: string, byteColumn: number): number {
  const target = Math.max(0, byteColumn - 1)
  let bytes = 0
  let index = 0
  for (const char of lineText) {
    if (bytes >= target)
      break
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    index += char.length
  }
  return index
}

/** "3 problems", "1 problem", "" for none. */
export function problemsText(diagnostics: readonly BuildDiagnostic[]): string {
  const count = diagnostics.length
  return count === 0 ? '' : `${count} ${count === 1 ? 'problem' : 'problems'}`
}

/** "12:04" in the user's locale. */
export function clockTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(at))
}

/** "12:04:07" in the user's locale (log lines). */
export function logTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(at))
}

/**
 * SHA-256 hex of the UTF-8 text (the etag the server computes), or null where Web Crypto is unavailable (plain HTTP on
 * a non-local host); the caller then reads the file again.
 */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle)
    return null
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }
  catch {
    return null
  }
}
