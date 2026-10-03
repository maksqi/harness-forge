// Reading a mentioned project file for `POST /projects/:id/files/attach` (Phase 9, ADR-042, ARCHITECTURE.md 6.21
// "Attach"). Owner: W9.6.
//
// Steps (no `fs` call on the request path without the frozen path guard of `workspace/paths.ts`):
//   1. lexically (`resolve(root, path)`, before any filesystem access): a `.git` segment or a secret-looking name is
//      refused (`validation_error` on `['path']`);
//   2. `resolveWorkspacePath` (input shape, the root is still its own realpath, realpath containment: `../x`, an
//      absolute path outside the root and a link pointing out of it are refused; `not_found` for a missing file), and
//      the same check on the resolved path (a link inside the root to `.env` or into `.git` is refused);
//   3. `readWorkspaceFile` (`O_NOFOLLOW`, a regular file only: a folder or a FIFO is refused; more than
//      `LIMITS.mentionFileMaxBytes` is `payload_too_large` with `details.limitBytes`), and the check once more on the
//      path it resolved (the path may have changed in between).
// The caller stores the bytes through `files.upload(new File([bytes], name))` (type sniffing, pins). `name` is the base
// name of the path as given (a link keeps its own name, like the `@` text).
import { posix, resolve } from 'node:path'
import { LIMITS } from '@harness-forge/shared'
import { isWithin } from '../../plugins/scaffold/paths.ts'
import { hasGitSegment, readWorkspaceFile, resolveWorkspacePath, toWorkspaceRel, workspacePathError } from '../../workspace/paths.ts'
import { isSecretLookingPath } from '../../workspace/sensitive.ts'

/** A project file read for an attach. */
export interface MentionedFile {
  /** Base name of the requested path (the upload name). */
  readonly name: string
  /** Project-relative POSIX path of the file that was read (a link's target). */
  readonly rel: string
  readonly bytes: Uint8Array<ArrayBuffer>
}

/** Refuses a project-relative path with a `.git` segment or a secret-looking name (`validation_error` on `['path']`). */
export function checkAttachablePath(rel: string): void {
  if (hasGitSegment(rel))
    throw workspacePathError(`"${rel}" is inside a .git folder and can't be attached.`)
  if (isSecretLookingPath(rel))
    throw workspacePathError(`"${rel}" looks like a secret file and can't be attached.`)
}

/** Reads the project file `path` of the project folder `root` (a canonical realpath) for an attach (module comment). */
export async function readMentionedFile(root: string, path: string, maxBytes: number = LIMITS.mentionFileMaxBytes): Promise<MentionedFile> {
  const lexical = resolve(root, path)
  const lexicalRel = isWithin(root, lexical) ? toWorkspaceRel(root, lexical) : null
  if (lexicalRel !== null)
    checkAttachablePath(lexicalRel)
  const resolved = await resolveWorkspacePath(root, path)
  checkAttachablePath(resolved.rel)
  const content = await readWorkspaceFile(root, path, { maxBytes })
  checkAttachablePath(content.resolved.rel)
  return {
    name: posix.basename(lexicalRel ?? content.resolved.rel),
    rel: content.resolved.rel,
    bytes: new Uint8Array(content.bytes),
  }
}
