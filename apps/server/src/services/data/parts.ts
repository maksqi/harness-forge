// Attachments referenced by chat messages (ADR-024): the `/api/files/<id>` URLs of `file` and `reasoning-file` parts.
// A backup exports the files they name (`files/index.json` + one blob per content) and an import rewrites them to the
// ids the files were stored under. Other parts (tool inputs and outputs, text, source URLs) are never touched.
import { FILE_ID_PATTERN } from '@harness-forge/shared'
import { FILE_URL_PREFIX, fileUrl } from '../files/index.ts'

/** Part types whose `url` may point at a stored file. */
const FILE_PART_TYPES: ReadonlySet<string> = new Set(['file', 'reasoning-file'])

/** The file id of a stored-file URL (`/api/files/<id>`, nothing before or after it), else null. */
export function fileIdOfUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(FILE_URL_PREFIX))
    return null
  const id = url.slice(FILE_URL_PREFIX.length)
  return FILE_ID_PATTERN.test(id) ? id : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every `file` / `reasoning-file` part of `messages` that points at a stored file, with its file id. */
function* storedFileParts(messages: readonly unknown[]): Generator<{ part: Record<string, unknown>, id: string }> {
  for (const message of messages) {
    const parts = isRecord(message) ? message.parts : undefined
    if (!Array.isArray(parts))
      continue
    for (const part of parts) {
      if (!isRecord(part) || typeof part.type !== 'string' || !FILE_PART_TYPES.has(part.type))
        continue
      const id = fileIdOfUrl(part.url)
      if (id !== null)
        yield { part, id }
    }
  }
}

/** The distinct file ids the parts of `messages` point at, in order of first reference. */
export function referencedFileIds(messages: readonly unknown[]): string[] {
  const ids = new Set<string>()
  for (const { id } of storedFileParts(messages))
    ids.add(id)
  return [...ids]
}

/**
 * Points every file part whose id is a key of `stored` at the mapped id instead (in place). Returns the number of parts
 * that changed.
 */
export function rewriteFileUrls(messages: readonly unknown[], stored: ReadonlyMap<string, string>): number {
  let changed = 0
  for (const { part, id } of storedFileParts(messages)) {
    const target = stored.get(id)
    if (target === undefined || target === id)
      continue
    part.url = fileUrl(target)
    changed += 1
  }
  return changed
}
