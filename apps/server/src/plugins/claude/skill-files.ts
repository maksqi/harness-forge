// Supporting files of plugin skills (Phase 12, ADR-053; ARCHITECTURE.md 6.33 "Skill files"): the `skill` tool lists the
// files of a plugin skill's folder and reads one with its `file` input (W12.7 calls these helpers from `chat/skills.ts`;
// W12.1 implements them). `read_file` is not widened to plugin folders.
//
// The final rules: `root` is the realpath of an active plugin's folder, `baseDir` the plugin-relative skill folder
// (`SkillDefinition.baseDir`; `.` = the plugin root), `file` a relative path inside that folder (≤ 512 characters). Every
// path resolves through `resolveWorkspacePath` / `openWorkspaceFile` with the skill folder's realpath as the root: no
// links anywhere on the path, regular files only, not hidden, not secret-looking (`isSecretLookingPath`), not binary, at
// most `LIMITS.skillFileReadBytes` (cut beyond, `truncated`); the list has at most `LIMITS.skillFilesListedMax` files,
// 3 levels deep, sorted. C43 stubs with the final signatures (P12-0b): the list is empty and a read is `not_found`.
import type { PluginSkillFile } from './types.ts'
import { HarnessError } from '@harness-forge/shared'

/**
 * The supporting files of the skill folder `baseDir` of the plugin at `root`, relative to the skill folder (POSIX,
 * sorted, `SKILL.md` itself left out). Rejects only when `signal` aborts.
 */
export async function listPluginSkillFiles(_root: string, _baseDir: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  return []
}

/**
 * One supporting file of the skill folder `baseDir` of the plugin at `root`. Throws `validation_error` for a path the
 * guard refuses (outside the folder, a link, hidden, secret-looking, binary) and `not_found` for a missing file.
 */
export async function readPluginSkillFile(_root: string, _baseDir: string, file: string, signal?: AbortSignal): Promise<PluginSkillFile> {
  signal?.throwIfAborted()
  throw new HarnessError({ code: 'not_found', message: `The skill file ${file.slice(0, 512)} was not found.` })
}
