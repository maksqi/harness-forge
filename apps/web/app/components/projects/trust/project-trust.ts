// Pure helpers of the project trust and project MCP dialogs (Phase 11, ADR-049, ADR-050; docs/UI.md 7.33, 11.8, 15):
// the groups of the trust dialog (Hooks · MCP servers · Commands with shell lines, filtered by Needs review / All), an
// item's title, state and state text, the warning texts, the Approve label, the stale and orphaned notes, a project
// MCP variable's state text and a server's status text. No Vue, no stores. Signatures frozen from Gate P11-0b (C39);
// W11.9 owns the bodies in P11-A (P11-0b: plain first versions).
import type { ProjectMcpList, ProjectMcpServer, ProjectTrustList, TrustItem, TrustItemKind } from '@harness-forge/shared'

/** The group order of the dialog. */
const GROUP_ORDER: readonly TrustItemKind[] = ['hook', 'mcp', 'command']

/** The state of an item as the dialog shows it: pending without / with `changed`, or approved. */
export function trustItemState(item: TrustItem): 'new' | 'changed' | 'approved' {
  if (item.state === 'approved')
    return 'approved'
  return item.changed ? 'changed' : 'new'
}

/**
 * The groups of the dialog in order (Hooks, MCP servers, Commands with shell lines), only those with items; `pending`
 * keeps the New and Changed items, `all` every item.
 */
export function trustGroups(list: ProjectTrustList, filter: 'pending' | 'all'): { kind: TrustItemKind, items: TrustItem[] }[] {
  const items = filter === 'pending' ? list.items.filter(item => item.state === 'pending') : list.items
  return GROUP_ORDER
    .map(kind => ({ kind, items: items.filter(item => item.kind === kind) }))
    .filter(group => group.items.length > 0)
}

/** An item's title: hooks "{event}" (+ " · {matcher}"), MCP servers their name, commands "/{name}". */
export function trustItemTitle(item: TrustItem): string {
  switch (item.kind) {
    case 'hook':
      return item.detail.matcher ? `${item.detail.event} · ${item.detail.matcher}` : item.detail.event
    case 'mcp':
      return item.detail.name
    case 'command':
      return `/${item.detail.name}`
  }
}

/** "New" / "Changed" / "Approved". */
export function trustStateText(item: TrustItem): string {
  switch (trustItemState(item)) {
    case 'new':
      return 'New'
    case 'changed':
      return 'Changed'
    case 'approved':
      return 'Approved'
  }
}

/** The text of an item warning (docs/UI.md 7.33). */
export function trustWarningText(warning: TrustItem['warnings'][number]): string {
  switch (warning) {
    case 'runs-repository-code':
      return 'Runs code from this repository that isn\'t pinned (like npm test): later changes to that code run without a new approval.'
    case 'private-network':
      return 'Connects to a private network address.'
    case 'referenced-file-missing':
      return 'A file this command runs is missing.'
  }
}

/** "Approve {n} items" / "Approve 1 item". */
export function approveLabel(n: number): string {
  return n === 1 ? 'Approve 1 item' : `Approve ${n} items`
}

/** The stale alert: "{n} items changed while you were reviewing. Check them again." */
export function staleText(n: number): string {
  return n === 1
    ? '1 item changed while you were reviewing. Check it again.'
    : `${n} items changed while you were reviewing. Check them again.`
}

/** The orphaned note: "{n} earlier approvals no longer match: an approved item was removed or renamed." */
export function orphanedText(n: number): string {
  return n === 1
    ? '1 earlier approval no longer matches: an approved item was removed or renamed.'
    : `${n} earlier approvals no longer match: an approved item was removed or renamed.`
}

/** A project MCP variable's state: "Stored", "Default: {hint}" or "Not set". */
export function variableStateText(variable: ProjectMcpList['variables'][number]): string {
  if (variable.set)
    return 'Stored'
  return variable.hint !== null ? `Default: ${variable.hint}` : 'Not set'
}

/** A project MCP server's status text (docs/UI.md 7.33). */
export function mcpStatusText(server: ProjectMcpServer): string {
  switch (server.state) {
    case 'pending':
      return 'Needs approval'
    case 'needs-variables':
      return server.missingVariables.length === 1 ? 'Set 1 variable' : `Set ${server.missingVariables.length} variables`
    case 'idle':
      return 'Starts with the first chat'
    case 'connecting':
      return 'Connecting…'
    case 'connected':
      return server.tools.length === 1 ? 'Connected · 1 tool' : `Connected · ${server.tools.length} tools`
    case 'error':
      return server.error ? `Error: ${server.error.message}` : 'Error'
    case 'disabled':
      return server.error?.message ?? 'Off on this server (safe mode)'
  }
}
