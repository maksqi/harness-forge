// The current state an import plan is compared with (ADR-055; W12.3-T3): `ClaudeImportBaseline` of the shared
// planner, built fresh for every plan and again for every apply (the statuses are re-checked).
//
// - definitions: every personal definition with its raw markdown (`customizations.exportBackup()`);
// - reservedNames: the builtin entries of the global catalog (the parser refuses reserved names on its own);
// - hooks: the personal hook rows as `claudeImportHookIdentity` texts (built from the `hooks` table: type, command or
//   prompt, timeout, model and the handler options), so an imported hook is `unchanged` on the next import;
// - mcpServers: every MCP server id with `claudeImportMcpFingerprint(transport)` (user and plugin servers share the id
//   space; env and header NAMES only, the DTO never carries values);
// - shellRules: the global shell rule prefixes; toolDenies: the tools with a stored `deny` override;
// - instructions / outputStyle: the global settings; styles: the output style names of the global catalog.
// Any other encoding of hooks or servers would make every status miss: only the two shared helpers are used.
import type { ClaudeImportBaseline } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import { claudeImportHookIdentity, claudeImportMcpFingerprint } from '@harness-forge/shared'
import { hooks } from '../../db/schema.ts'

type DefinitionKind = ClaudeImportBaseline['definitions'][number]['kind']

const DEFINITION_KINDS: ReadonlySet<string> = new Set(['agent', 'command', 'skill', 'style'])

function isDefinitionKind(kind: string): kind is DefinitionKind {
  return DEFINITION_KINDS.has(kind)
}

/** The handler of a personal hook row as `claudeImportHookIdentity` reads it (absent fields left out). */
export function hookRowHandler(row: typeof hooks.$inferSelect): Record<string, unknown> {
  const handler: Record<string, unknown> = { type: row.type === 'prompt' ? 'prompt' : 'command' }
  if (row.type === 'prompt') {
    if (row.prompt !== null)
      handler.prompt = row.prompt
    if (row.model !== null)
      handler.model = row.model
  }
  else {
    handler.command = row.command
  }
  if (row.timeout !== null)
    handler.timeout = row.timeout
  const options = row.options ?? {}
  if (options.args !== undefined)
    handler.args = [...options.args]
  if (options.async === true)
    handler.async = true
  if (options.if !== undefined)
    handler.if = options.if
  if (options.statusMessage !== undefined)
    handler.statusMessage = options.statusMessage
  if (options.continueOnBlock === true)
    handler.continueOnBlock = true
  return handler
}

/** Builds the baseline of the planner from the services (see the module comment). */
export async function buildClaudeImportBaseline(deps: AppDeps): Promise<ClaudeImportBaseline> {
  const [backup, catalog, rows, servers, rules, prefs, settings] = await Promise.all([
    deps.customizations.exportBackup(),
    deps.customizations.catalog(null),
    deps.db.select().from(hooks),
    deps.mcp.list(),
    deps.shellRules.list(),
    deps.tools.prefs(),
    deps.settings.get(),
  ])
  const reservedNames: { kind: DefinitionKind, name: string }[] = []
  const styles = new Set<string>()
  for (const entry of catalog.entries) {
    if (entry.source === 'builtin' && isDefinitionKind(entry.kind))
      reservedNames.push({ kind: entry.kind, name: entry.name })
    if (entry.kind === 'style' && entry.state !== 'invalid')
      styles.add(entry.name)
  }
  return {
    definitions: backup.items.map(item => ({ kind: item.kind, name: item.name, content: item.content })),
    reservedNames,
    hooks: rows.map(row => claudeImportHookIdentity(row.event, row.matcher, hookRowHandler(row))),
    mcpServers: servers.map(server => ({ id: server.id, fingerprint: claudeImportMcpFingerprint(server.transport) })),
    shellRules: rules.filter(rule => rule.projectId === null).map(rule => rule.prefix),
    toolDenies: [...prefs].filter(([, pref]) => pref.override === 'deny').map(([name]) => name),
    instructions: settings.instructions,
    styles: [...styles],
    outputStyle: settings.outputStyle,
  }
}
