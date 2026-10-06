// Project definition files edited from the UI (Phase 12, ADR-056; API.md section 4.35): the agent, command, skill and
// output style files of a project's `.claude` / `.harness` folders, the `hooks` key of its four settings files and the
// `mcpServers` key of its `.mcp.json`. Writes are checked against the sha256 the editor loaded (`409 stale`), go through
// the workspace path guard and the file lock, are not journaled (`workspace.changed { source: 'user' }`) and never
// approve anything: the result says how many project items wait for an approval.
import { z } from 'zod'
import { sha256HexSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { hasControlChars, utf8ByteLength } from '../util/text.ts'

/** The kinds of editable project files. */
export const PROJECT_DEFINITION_FILE_KINDS = ['agent', 'command', 'skill', 'style', 'settings', 'mcp'] as const
export type ProjectDefinitionFileKind = (typeof PROJECT_DEFINITION_FILE_KINDS)[number]

/** Kind of an editable project file: a definition (markdown), a settings file (`hooks` key) or `.mcp.json`. */
export const projectDefinitionFileKindSchema = z.enum(PROJECT_DEFINITION_FILE_KINDS)

/** The project-relative path of `.mcp.json`. */
export const PROJECT_MCP_JSON_PATH = '.mcp.json'

/** Characters of an editable project path. */
export const PROJECT_DEFINITION_PATH_MAX_CHARS = 512

const ROOTS: ReadonlySet<string> = new Set(['.claude', '.harness'])
const SETTINGS_FILES: ReadonlySet<string> = new Set(['settings.json', 'settings.local.json'])
const SEGMENT = /^[^/\\]+$/
const MARKDOWN_STEM = /^[^/\\]+\.md$/i
/** Subfolders below `commands/` (the command catalog reads up to 3 levels). */
const COMMAND_DEPTH_MAX = 3

/**
 * The kind of an editable project file, or null when the path is not one (Phase 12, ADR-056): a POSIX path relative to
 * the project folder, at most 512 characters, no empty, `.` or `..` segment, no backslash, no control character, and one
 * of `.claude|.harness/agents/<name>.md`, `…/commands/[<folder>/…]<name>.md` (at most 3 subfolders),
 * `…/skills/<name>/SKILL.md`, `…/output-styles/<name>.md`, `…/settings.json`, `…/settings.local.json` or `.mcp.json`.
 * The server still resolves the path with the workspace path guard (no links, sensitive names refused).
 */
export function projectDefinitionPathKind(path: string): ProjectDefinitionFileKind | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > PROJECT_DEFINITION_PATH_MAX_CHARS || hasControlChars(path))
    return null
  if (path === PROJECT_MCP_JSON_PATH)
    return 'mcp'
  const segments = path.split('/')
  if (!segments.every(segment => SEGMENT.test(segment) && segment !== '.' && segment !== '..'))
    return null
  const [root = '', folder = '', ...rest] = segments
  if (!ROOTS.has(root))
    return null
  if (rest.length === 0)
    return SETTINGS_FILES.has(folder) ? 'settings' : null
  const file = rest[rest.length - 1] ?? ''
  switch (folder) {
    case 'agents':
      return rest.length === 1 && MARKDOWN_STEM.test(file) ? 'agent' : null
    case 'output-styles':
      return rest.length === 1 && MARKDOWN_STEM.test(file) ? 'style' : null
    case 'commands':
      return rest.length <= COMMAND_DEPTH_MAX + 1 && MARKDOWN_STEM.test(file) ? 'command' : null
    case 'skills':
      return rest.length === 2 && file === 'SKILL.md' ? 'skill' : null
    default:
      return null
  }
}

/** True for a markdown definition kind (`agent`, `command`, `skill`, `style`): the only kinds that can be deleted. */
export function isMarkdownDefinitionKind(kind: ProjectDefinitionFileKind): kind is 'agent' | 'command' | 'skill' | 'style' {
  return kind !== 'settings' && kind !== 'mcp'
}

/** An editable project path (`projectDefinitionPathKind` is not null). */
export const projectDefinitionPathSchema = z
  .string()
  .refine(
    value => projectDefinitionPathKind(value) !== null,
    'Use a definition file under .claude/ or .harness/ (agents, commands, skills/<name>/SKILL.md, output-styles), a settings file or .mcp.json.',
  )

/** A problem of the file (parser diagnostics of the definition, the hooks or the `.mcp.json`); never quotes contents. */
export const projectDefinitionDiagnosticSchema = z.object({
  level: z.enum(['error', 'warning', 'info']),
  code: z.string().min(1).max(64),
  message: z.string().max(1000),
  /** 1-based line, when known. */
  line: z.int().min(1).optional(),
})
export type ProjectDefinitionDiagnostic = z.infer<typeof projectDefinitionDiagnosticSchema>

/** `GET /projects/:id/definitions/file?path`: the file as it is on disk (a missing file is `exists: false`, not `404`). */
export const projectDefinitionFileSchema = z.object({
  path: projectDefinitionPathSchema,
  kind: projectDefinitionFileKindSchema,
  exists: z.boolean(),
  /** The raw text (definitions at most 64 KiB, settings files and `.mcp.json` at most 256 KiB); null when missing. */
  content: z.string().nullable(),
  /** SHA-256 of the bytes on disk; send it back as `expectedSha256`. Null when missing. */
  sha256: sha256HexSchema.nullable(),
  diagnostics: z.array(projectDefinitionDiagnosticSchema).max(200),
})
export type ProjectDefinitionFile = z.infer<typeof projectDefinitionFileSchema>

/** Query of `GET /projects/:id/definitions/file`. */
export const projectDefinitionQuerySchema = z.object({
  path: projectDefinitionPathSchema,
})
export type ProjectDefinitionQuery = z.infer<typeof projectDefinitionQuerySchema>

/** Query of `DELETE /projects/:id/definitions/file` (markdown definitions only; a skill folder left empty is removed). */
export const projectDefinitionRemoveQuerySchema = z.object({
  path: projectDefinitionPathSchema.refine((value) => {
    const kind = projectDefinitionPathKind(value)
    return kind !== null && isMarkdownDefinitionKind(kind)
  }, 'Only agent, command, skill and output style files can be deleted.'),
  /** The sha256 the editor loaded; another content on disk is `409` (`stale`). */
  expectedSha256: sha256HexSchema,
})
export type ProjectDefinitionRemoveQuery = z.infer<typeof projectDefinitionRemoveQuerySchema>

/** The sha256 the editor loaded, or null = the file must not exist yet (else `409` `stale`). */
const expectedSha256Schema = sha256HexSchema.nullable()

/** A JSON object value of a settings `hooks` key or of `.mcp.json` `mcpServers` (checked by the server's parsers). */
const jsonObjectSchema = z.record(z.string().max(256), z.unknown())

/**
 * Body of `PUT /projects/:id/definitions/file` (strict), by path kind: a definition takes the raw markdown (`content`,
 * parsed with `parseDefinition`: an `error` diagnostic is `400` with `details.diagnostics`); a settings file takes its
 * `hooks` key (every other key and the key order are kept; null removes the key; checked with `readHooksConfig`);
 * `.mcp.json` takes its `mcpServers` key (null removes it; checked with `parseMcpJson`). No fresh auth and no idle rule:
 * nothing written here runs before a fresh approval.
 */
export const projectDefinitionWriteBodySchema = z
  .union([
    z.strictObject({
      path: projectDefinitionPathSchema,
      expectedSha256: expectedSha256Schema,
      content: z
        .string()
        .min(1)
        .refine(value => utf8ByteLength(value) <= LIMITS.customizationContentBytes, 'Definitions are limited to 64 KB.'),
    }),
    z.strictObject({
      path: projectDefinitionPathSchema,
      expectedSha256: expectedSha256Schema,
      hooks: jsonObjectSchema.nullable(),
    }),
    z.strictObject({
      path: z.literal(PROJECT_MCP_JSON_PATH),
      expectedSha256: expectedSha256Schema,
      mcpServers: jsonObjectSchema.nullable(),
    }),
  ])
  .superRefine((body, ctx) => {
    const kind = projectDefinitionPathKind(body.path)
    if (kind === null)
      return
    const expected = 'content' in body ? 'definition' : 'hooks' in body ? 'settings' : 'mcp'
    const actual = isMarkdownDefinitionKind(kind) ? 'definition' : kind
    if (expected !== actual) {
      const field = actual === 'definition' ? '"content"' : actual === 'settings' ? '"hooks"' : '"mcpServers"'
      ctx.addIssue({ code: 'custom', path: ['path'], message: `This file takes ${field}.` })
    }
  })
export type ProjectDefinitionWriteBody = z.infer<typeof projectDefinitionWriteBodySchema>

/** Response of `PUT /projects/:id/definitions/file`. */
export const projectDefinitionWriteResultSchema = z.object({
  path: projectDefinitionPathSchema,
  /** SHA-256 of the bytes written (the next `expectedSha256`). */
  sha256: sha256HexSchema,
  /** The file did not exist before. */
  created: z.boolean(),
  /** Warnings and infos of the saved file (it has no `error`: such content is refused with `400`). */
  diagnostics: z.array(projectDefinitionDiagnosticSchema).max(200),
  /** Saving never approves: the project's executable items that now wait for an approval (`POST /projects/:id/trust`). */
  trust: z.object({ pending: z.int().min(0) }),
})
export type ProjectDefinitionWriteResult = z.infer<typeof projectDefinitionWriteResultSchema>
