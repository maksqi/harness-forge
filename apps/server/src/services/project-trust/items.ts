// The review items of project trust (Phase 11, ADR-049; API.md 4.32). Owner: W11.3.
//
// A scan item is a project config item of the settings files or `.mcp.json` (`projectConfig.snapshot`) or a project
// command file with `` !`cmd` `` spans (the customization catalog + `customizations.load`); `trustItemDto` maps it to
// the `TrustItem` of `GET /projects/:id/trust` with exactly what would run (commands, arguments, URLs; only the NAMES
// of environment variables, headers and `${VAR}` references, never a value). Phase 12 (W12.5): a hook's detail shows a
// prompt hook (`type: 'prompt'`, the prompt, its model) and the handler fields (`hookDetail`).
import type { TrustHashItem, TrustHookDetail, TrustItem, TrustState, TrustWarning } from '@harness-forge/shared'
import type { ProjectConfigItem, ProjectHookItem, TrustSubject } from '../project-config/types.ts'
import { LIMITS, serverVariables } from '@harness-forge/shared'
import { projectPromptSpec } from '../project-config/hook-items.ts'

/** A project command file whose body holds `` !`cmd` `` spans. */
export interface ProjectCommandItem extends TrustSubject {
  readonly kind: 'command'
  readonly hashItem: Extract<TrustHashItem, { readonly kind: 'command' }>
  /** The project-relative command file (`.harness/commands/status.md`). */
  readonly path: string
  /** `/name`. */
  readonly label: string
  readonly warnings: readonly TrustWarning[]
  /** The catalog command name (no slash). */
  readonly name: string
  readonly spans: readonly string[]
}

/** Every kind of executable project item. */
export type ProjectTrustScanItem = ProjectConfigItem | ProjectCommandItem

const MCP_ARGS_MAX = 64
/** `trustHookDetailSchema` caps of the Phase 12 fields. */
const HOOK_ARGS_MAX = 64
const HOOK_IF_MAX_CHARS = 512
const HOOK_MODEL_MAX_CHARS = 64 + 1 + 256
const HOOK_STATUS_MAX_CHARS = 200

/**
 * The detail of a hook item: exactly what runs (open point 2). A v1 command item keeps the v1.7 shape; Phase 12 adds
 * `args` / `async` / `if` of a command item and `type: 'prompt'`, the prompt, its model and `continueOnBlock` of a prompt
 * item (`command` is '' then), and the `statusMessage` of either.
 */
export function hookDetail(item: ProjectHookItem): TrustHookDetail {
  const { spec } = item
  const prompt = projectPromptSpec(item)
  const common = {
    event: spec.event,
    matcher: spec.matcher,
    timeout: spec.timeoutSec,
    ...(spec.if === undefined ? {} : { if: spec.if.slice(0, HOOK_IF_MAX_CHARS) }),
    ...(spec.statusMessage === undefined ? {} : { statusMessage: spec.statusMessage.slice(0, HOOK_STATUS_MAX_CHARS) }),
  }
  if (prompt !== null) {
    return {
      ...common,
      command: '',
      type: 'prompt',
      prompt: prompt.prompt.slice(0, LIMITS.promptHookPromptMaxChars),
      ...(prompt.model === null ? {} : { model: prompt.model.slice(0, HOOK_MODEL_MAX_CHARS) }),
      ...(prompt.continueOnBlock ? { continueOnBlock: true } : {}),
    }
  }
  return {
    ...common,
    command: spec.command,
    ...(spec.args === undefined ? {} : { args: spec.args.slice(0, HOOK_ARGS_MAX) }),
    ...(spec.async === true ? { async: true } : {}),
  }
}
const MCP_ENV_NAMES_MAX = 64
const MCP_HEADER_NAMES_MAX = 32

/** The review DTO of a scan item with its state (`changed` only on pending items that replaced an approved one). */
export function trustItemDto(item: ProjectTrustScanItem, state: TrustState, changed: boolean): TrustItem {
  const base = {
    sha256: item.sha256,
    state,
    ...(changed && state === 'pending' ? { changed: true } : {}),
    label: item.label,
    path: item.path,
    refs: item.hashItem.refs.slice(0, LIMITS.trustRefFilesMax).map(ref => ({ path: ref.path, sha256: ref.sha256 })),
    warnings: [...item.warnings],
  }
  switch (item.kind) {
    case 'hook':
      return { ...base, kind: 'hook', detail: hookDetail(item) }
    case 'mcp': {
      const { server } = item
      const transport = server.transport
      const variables = [...new Set(serverVariables(transport).map(ref => ref.name))].slice(0, LIMITS.projectMcpVariablesMax)
      return {
        ...base,
        kind: 'mcp',
        detail: transport.type === 'stdio'
          ? {
              name: server.name,
              id: server.id,
              transport: 'stdio',
              command: transport.command,
              args: transport.args.slice(0, MCP_ARGS_MAX),
              envNames: Object.keys(transport.env).slice(0, MCP_ENV_NAMES_MAX),
              headerNames: [],
              variables,
            }
          : {
              name: server.name,
              id: server.id,
              transport: transport.type,
              url: transport.url,
              envNames: [],
              headerNames: Object.keys(transport.headers).slice(0, MCP_HEADER_NAMES_MAX),
              variables,
            },
      }
    }
    case 'command':
      return { ...base, kind: 'command', detail: { name: item.name, spans: [...item.spans] } }
  }
}
