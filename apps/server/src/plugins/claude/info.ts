// The Claude Code plugin info of the inspection and the plugin detail (Phase 12, ADR-053; W12.1-T10;
// `claudePluginInfoSchema`): its identity, the component counts, exactly what the trust consent shows (`executables`:
// every command hook handler with its arguments, every stdio MCP command line and every `` !`cmd` `` span, as written),
// the hosts it declares, its `userConfig` options (the sensitive ones flagged), the parts that are never used and the
// diagnostics, each list capped by its schema limit. Never holds a setting value or a file's contents.
import type { ClaudeDiagnostic, ClaudePluginExecutable, ClaudePluginInfo, ClaudeUserConfigOption } from '@harness-forge/shared'
import type { UnsupportedPart } from './layout.ts'
import { LIMITS } from '@harness-forge/shared'

export interface ClaudeInfoInput {
  readonly name: string
  readonly displayName?: string
  /** The raw version when one is known (`plugin.json`, the entry, the origin sha), else null. */
  readonly version: string | null
  readonly namespace: string
  readonly counts: ClaudePluginInfo['components']
  readonly executables: readonly ClaudePluginExecutable[]
  readonly hosts: readonly string[]
  readonly userConfig: readonly ClaudeUserConfigOption[]
  readonly unsupported: readonly UnsupportedPart[]
  readonly diagnostics: readonly ClaudeDiagnostic[]
}

/** Lists of the info and their caps. */
const HOSTS_MAX = 100
const UNSUPPORTED_MAX = 100

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** The diagnostics capped at `LIMITS.claudePluginDiagnosticsMax` (the last one counts the rest), each field cut. */
export function cappedDiagnostics(list: readonly ClaudeDiagnostic[]): ClaudeDiagnostic[] {
  const max = LIMITS.claudePluginDiagnosticsMax
  const fit = (item: ClaudeDiagnostic): ClaudeDiagnostic => ({
    level: item.level,
    code: cut(item.code, 64),
    message: cut(item.message, 1000),
    ...(item.component === undefined ? {} : { component: cut(item.component, 256) }),
    ...(item.path === undefined ? {} : { path: cut(item.path, LIMITS.workspacePathMaxChars) }),
  })
  if (list.length <= max)
    return list.map(fit)
  return [...list.slice(0, max - 1).map(fit), { level: 'info', code: 'too-many', message: `${list.length - (max - 1)} more problems were found.` }]
}

/** The `claudePluginInfoSchema` value of a read plugin. */
export function claudePluginInfo(input: ClaudeInfoInput): ClaudePluginInfo {
  return {
    name: cut(input.name, 128),
    ...(input.displayName === undefined ? {} : { displayName: cut(input.displayName, 128) }),
    version: input.version === null ? null : cut(input.version, 128),
    namespace: input.namespace,
    components: input.counts,
    executables: input.executables.slice(0, LIMITS.claudePluginExecutablesMax).map(item => ({
      kind: item.kind,
      label: cut(item.label, 200),
      command: cut(item.command, 4096),
    })),
    hosts: [...new Set(input.hosts)].slice(0, HOSTS_MAX).map(host => cut(host, 253)),
    userConfig: input.userConfig.slice(0, LIMITS.claudeUserConfigMax).map(option => ({
      key: cut(option.key, 64),
      title: cut(option.title, 200),
      sensitive: option.sensitive,
      required: option.required,
    })),
    unsupported: input.unsupported.slice(0, UNSUPPORTED_MAX).map(part => ({ component: cut(part.component, 256), reason: cut(part.reason, 300) })),
    diagnostics: cappedDiagnostics(input.diagnostics),
  }
}
