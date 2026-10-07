// Diagnostics of the project definition editor (Phase 12, ADR-056): the parser diagnostics of a definition
// (`parseDefinition`), a settings file's hooks (`readSettingsHooks` / `readHooksConfig`) and `.mcp.json`
// (`parseMcpJson`) mapped to the flat `ProjectDefinitionDiagnostic { level, code, message, line? }` of the API, and the
// `400` of content with an `error` diagnostic. Messages come from the shared parsers, which never quote file contents,
// commands or values; a hook diagnostic is prefixed with its event and position, a server diagnostic with the server
// name (a key the user wrote, cut and cleaned).
import type { DefinitionDiagnostic, HookDiagnostic, McpConfigDiagnostic, ProjectDefinitionDiagnostic } from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'

/** Diagnostics answered at most (`projectDefinitionFileSchema.diagnostics`). */
export const PROJECT_DEFINITION_DIAGNOSTICS_MAX = 200
/** Characters of a diagnostic message (`projectDefinitionDiagnosticSchema.message`). */
const MESSAGE_MAX_CHARS = 1000
/** Characters of a diagnostic code (`projectDefinitionDiagnosticSchema.code`). */
const CODE_MAX_CHARS = 64
/** Characters of a server name shown in a message. */
const SERVER_SHOWN_MAX_CHARS = 64
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu

function entry(level: ProjectDefinitionDiagnostic['level'], code: string, message: string, line?: number): ProjectDefinitionDiagnostic {
  const cleanCode = code.slice(0, CODE_MAX_CHARS) || 'invalid'
  const cleanMessage = message.length > MESSAGE_MAX_CHARS ? `${message.slice(0, MESSAGE_MAX_CHARS - 1)}…` : message
  return line !== undefined && Number.isInteger(line) && line >= 1
    ? { level, code: cleanCode, message: cleanMessage, line }
    : { level, code: cleanCode, message: cleanMessage }
}

/** One diagnostic of the editor itself (a read or splice problem). */
export function diagnostic(level: ProjectDefinitionDiagnostic['level'], code: string, message: string): ProjectDefinitionDiagnostic {
  return entry(level, code, message)
}

/** The diagnostics of `parseDefinition` (level, code, message and line; never the catalog fields). */
export function fromDefinitionDiagnostics(list: readonly DefinitionDiagnostic[]): ProjectDefinitionDiagnostic[] {
  return list.slice(0, PROJECT_DEFINITION_DIAGNOSTICS_MAX).map(item => entry(item.level, item.code, item.message, item.line))
}

/** The diagnostics of the hooks reader, each prefixed with its event (and `group g, hook h`, 1-based) when known. */
export function fromHookDiagnostics(list: readonly HookDiagnostic[]): ProjectDefinitionDiagnostic[] {
  return list.slice(0, PROJECT_DEFINITION_DIAGNOSTICS_MAX).map((item) => {
    let prefix = ''
    if (item.event !== undefined) {
      prefix = item.position === undefined
        ? `${item.event}: `
        : `${item.event} (group ${item.position[0] + 1}, hook ${item.position[1] + 1}): `
    }
    return entry(item.level, item.code, `${prefix}${item.message}`)
  })
}

/** The diagnostics of `parseMcpJson`, prefixed with the server name when the diagnostic is about one server. */
export function fromMcpDiagnostics(list: readonly McpConfigDiagnostic[]): ProjectDefinitionDiagnostic[] {
  return list.slice(0, PROJECT_DEFINITION_DIAGNOSTICS_MAX).map((item) => {
    const name = item.server?.replace(CONTROL_CHARACTERS, '?').slice(0, SERVER_SHOWN_MAX_CHARS)
    return entry(item.level, item.code, name === undefined || name === '' ? item.message : `Server "${name}": ${item.message}`)
  })
}

/** True when a diagnostic is an `error` (the content cannot be saved). */
export function hasErrorDiagnostic(list: readonly ProjectDefinitionDiagnostic[]): boolean {
  return list.some(item => item.level === 'error')
}

/** At most `PROJECT_DEFINITION_DIAGNOSTICS_MAX` diagnostics. */
export function capDiagnostics(list: readonly ProjectDefinitionDiagnostic[]): ProjectDefinitionDiagnostic[] {
  return list.slice(0, PROJECT_DEFINITION_DIAGNOSTICS_MAX)
}

/**
 * `400 validation_error` of content that cannot be saved (API.md 5.36): the message of the first `error` diagnostic,
 * every diagnostic in `details.diagnostics` and one issue on `issuePath` (`content`, `hooks`, `mcpServers`).
 */
export function invalidContent(diagnostics: readonly ProjectDefinitionDiagnostic[], issuePath: string): HarnessError {
  const first = diagnostics.find(item => item.level === 'error')
  const message = first?.message ?? 'The file is not valid.'
  return new HarnessError({
    code: 'validation_error',
    message,
    details: { diagnostics: capDiagnostics(diagnostics), issues: [{ path: [issuePath], message, code: 'custom' }] },
  })
}
