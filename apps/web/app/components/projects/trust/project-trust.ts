// Pure helpers of the project trust and project MCP dialogs (Phase 11, ADR-049, ADR-050; docs/UI.md 7.33, 11.8, 15):
// the groups of the trust dialog (Hooks · MCP servers · Commands with shell lines, filtered by Needs review / All), an
// item's title, state, exact command text, details and warnings, the Approve label, the stale and orphaned notes, the
// selection rules (what survives a refetch), a project MCP variable's state and placeholder and a server's status
// text. No Vue, no stores. The signatures of C39 are frozen from Gate P11-0b; the other exports are W11.9's.
import type { ProjectMcpList, ProjectMcpServer, ProjectTrustList, TrustApproval, TrustItem, TrustItemKind } from '@harness-forge/shared'
import type { StatusDotStatus } from '~/components/common/status'

type ProjectMcpVariable = ProjectMcpList['variables'][number]

/** The group order of the dialog. */
const GROUP_ORDER: readonly TrustItemKind[] = ['hook', 'mcp', 'command']

/** The group headings (docs/UI.md 7.33). */
export const TRUST_GROUP_LABELS: Readonly<Record<TrustItemKind, string>> = {
  hook: 'Hooks',
  mcp: 'MCP servers',
  command: 'Commands with shell lines',
}

/** The kind as the item's accessible name says it ("{kind} {label}, {state}"). */
export const TRUST_KIND_NAMES: Readonly<Record<TrustItemKind, string>> = {
  hook: 'Hook',
  mcp: 'MCP server',
  command: 'Command',
}

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

/** The items that wait for a review (New and Changed). */
export function pendingItems(list: ProjectTrustList | null): TrustItem[] {
  return list ? list.items.filter(item => item.state === 'pending') : []
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

/** The accessible name of an item's `<article>`: "{kind} {label}, {state}". */
export function trustItemName(item: TrustItem): string {
  return `${TRUST_KIND_NAMES[item.kind]} ${item.label}, ${trustStateText(item)}`
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

/** Characters an argument may hold and still be shown without quotes. */
const PLAIN_ARGUMENT = /^[\w@%+=:,./-]+$/

/** One argument as a POSIX shell would read it back: plain, or in single quotes. */
export function shellQuote(argument: string): string {
  if (PLAIN_ARGUMENT.test(argument))
    return argument
  return `'${argument.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * The exact text of an item, as the `pre` named "Command" shows it: a hook's command; a stdio server's command and its
 * arguments (an argument with spaces or quotes is quoted); an HTTP / SSE server's URL; a command file's `!` lines, one
 * per line. `${VAR}` references are kept as they are written.
 */
export function trustCommandText(item: TrustItem): string {
  switch (item.kind) {
    case 'hook':
      return item.detail.command
    case 'mcp':
      if (item.detail.transport === 'stdio')
        return [item.detail.command ?? '', ...(item.detail.args ?? [])].map((part, index) => (index === 0 ? part : shellQuote(part))).join(' ')
      return item.detail.url ?? ''
    case 'command':
      return item.detail.spans.join('\n')
  }
}

/**
 * The detail lines of an item (docs/UI.md 7.33): "timeout {n}s" (hooks with their own timeout), "Runs {path}" for every
 * referenced file ("Runs {path} (not found)" when its hash is null), "Environment: {names}" and "Headers: {names}" (names
 * only, never values), and "Variables: {name} (set | not set)" from the project's MCP list (names only while it is not
 * loaded).
 */
export function trustItemDetails(item: TrustItem, variables?: readonly ProjectMcpVariable[]): string[] {
  const lines: string[] = []
  if (item.kind === 'hook' && item.detail.timeout !== null)
    lines.push(`timeout ${item.detail.timeout}s`)
  for (const ref of item.refs)
    lines.push(ref.sha256 === null ? `Runs ${ref.path} (not found)` : `Runs ${ref.path}`)
  if (item.kind === 'mcp') {
    if (item.detail.envNames.length > 0)
      lines.push(`Environment: ${item.detail.envNames.join(', ')}`)
    if (item.detail.headerNames.length > 0)
      lines.push(`Headers: ${item.detail.headerNames.join(', ')}`)
    if (item.detail.variables.length > 0) {
      const names = item.detail.variables.map((name) => {
        const variable = variables?.find(entry => entry.name === name)
        if (!variable)
          return name
        return `${name} (${variable.set ? 'set' : 'not set'})`
      })
      lines.push(`Variables: ${names.join(', ')}`)
    }
  }
  return lines
}

/** "Approve {n} items" / "Approve 1 item". */
export function approveLabel(n: number): string {
  return n === 1 ? 'Approve 1 item' : `Approve ${n} items`
}

/** "{n} selected". */
export function selectedText(n: number): string {
  return `${n} selected`
}

/** The toast after an approval: "Approved {n} items in {project}" / "Approved 1 item in {project}". */
export function approvedText(n: number, project: string): string {
  return n === 1 ? `Approved 1 item in ${project}` : `Approved ${n} items in ${project}`
}

/** The toast after a revoke. */
export function revokedText(label: string): string {
  return `Revoked ${label}. It won't run until you approve it again.`
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

/** The orphaned note shows only while no item is marked as changed (that item already explains the mismatch). */
export function showOrphaned(list: ProjectTrustList): boolean {
  return list.orphaned > 0 && !list.items.some(item => item.changed === true)
}

/** The selected hashes that are still pending items of `list` (a refetch keeps only those). */
export function keepSelection(selected: ReadonlySet<string>, list: ProjectTrustList | null): Set<string> {
  const pending = new Set(pendingItems(list).map(item => item.sha256))
  return new Set([...selected].filter(sha256 => pending.has(sha256)))
}

/** How many of the selected hashes are no longer pending items of `list` (the count of the stale alert). */
export function changedCount(selected: ReadonlySet<string>, list: ProjectTrustList | null): number {
  return selected.size - keepSelection(selected, list).size
}

/** The approval body items of the selected hashes, in the list's order (only pending items of the list). */
export function approvalsOf(selected: ReadonlySet<string>, list: ProjectTrustList | null): TrustApproval[] {
  return pendingItems(list)
    .filter(item => selected.has(item.sha256))
    .map(item => ({ kind: item.kind, sha256: item.sha256 }))
}

/** Splits approvals into request-sized batches (`POST /projects/:id/trust` takes at most `size`). */
export function approvalBatches(items: readonly TrustApproval[], size: number): TrustApproval[][] {
  const batches: TrustApproval[][] = []
  for (let start = 0; start < items.length; start += size)
    batches.push(items.slice(start, start + size))
  return batches
}

/** A project MCP variable's state: a stored value, only the `:-default` of `.mcp.json`, or nothing. */
export function variableState(variable: ProjectMcpVariable): 'set' | 'default' | 'missing' {
  if (variable.set)
    return 'set'
  return variable.hint !== null ? 'default' : 'missing'
}

/** A project MCP variable's state: "Stored", "Default: {hint}" or "Not set". */
export function variableStateText(variable: ProjectMcpVariable): string {
  if (variable.set)
    return 'Stored'
  return variable.hint !== null ? `Default: ${variable.hint}` : 'Not set'
}

/**
 * The placeholder of a variable's write-only input: "•••• · stored" while a value is stored (and not marked for
 * removal), "Default: {hint}" when only the default applies (or will after the removal), else empty.
 */
export function variablePlaceholder(variable: ProjectMcpVariable, cleared: boolean): string {
  if (variable.set && !cleared)
    return '•••• · stored'
  return variable.hint !== null ? `Default: ${variable.hint}` : ''
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

/** The status dot of a project MCP server and its sr-only word. */
export function mcpStatusDot(server: ProjectMcpServer): { status: StatusDotStatus, label: string } {
  switch (server.state) {
    case 'pending':
      return { status: 'approval', label: 'Needs approval' }
    case 'needs-variables':
      return { status: 'warning', label: 'Needs variables' }
    case 'idle':
      return { status: 'off', label: 'Idle' }
    case 'connecting':
      return { status: 'running', label: 'Connecting' }
    case 'connected':
      return { status: 'ok', label: 'Connected' }
    case 'error':
      return { status: 'error', label: 'Error' }
    case 'disabled':
      return { status: 'off', label: 'Off' }
  }
}

/** Reconnect is offered for connected, failed and idle servers (docs/UI.md 7.33). */
export function canReconnect(server: ProjectMcpServer): boolean {
  return server.state === 'connected' || server.state === 'error' || server.state === 'idle'
}

/** The exact command (stdio) or URL (HTTP / SSE) of a server, from its trust item; null without one. */
export function mcpServerCommand(trust: TrustItem | null): string | null {
  return trust?.kind === 'mcp' ? trustCommandText(trust) : null
}

/**
 * Phase 12 (ADR-057; C46 declares, W12.13 owns): the state of a group's Select all (docs/UI.md 7.34): every pending item
 * of the group selected (true), none (false) or some ('indeterminate', reka's mixed state).
 */
export function selectAllState(items: readonly TrustItem[], selected: ReadonlySet<string>): boolean | 'indeterminate' {
  const pending = items.filter(item => item.state === 'pending')
  const count = pending.filter(item => selected.has(item.sha256)).length
  if (count === 0)
    return false
  return count === pending.length ? true : 'indeterminate'
}
