// Pure helpers of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 9.13, 11.8, 15): the copy of the events
// (label, description, whether the matcher matches tools), the actions of a row's menu, the editor's draft, a row's
// state badge and meta line, the matcher preview (over the shared `compileMatcher` / `hookTargetNames`), the Claude
// Code `hooks` JSON of rows (Copy as JSON), the hook import (over the shared `readSettingsHooks` / `readHooksConfig`),
// the tab's copy and the delete confirmation. Hook configurations are read only by the shared `util/hooks.ts`. No Vue,
// no stores. Signatures frozen from Gate P11-0b (C39); W11.8 owns the bodies (P11-A).
// Phase 12 (ADR-056, ADR-057; C46 declares, W12.12 implements; frozen from Gate P12-0b): the 13 events (`HOOK_EVENT_INFO` +
// `promptAllowed` and the matcher subject), the prompt type and the handler fields of the draft, the project target of
// the editor (`ProjectHookTarget`), the row action `trust-plugin` (Review plugin… of an untrusted plugin's hook) and
// `promptError`. W12.12 (P12-A) adds: the final copy of the five new events, prompt hooks and the handler fields in the
// rows, Copy as JSON and the import (`http` / `mcp_tool` / `agent` handlers noted as ignored), the editor's field rules
// (`argsError`, `ifError`, `statusMessageError`, `promptEventError`), the request bodies of a draft (`hookCreateBody`,
// `hookPatch`), the project settings files (`PROJECT_HOOK_FILES`) and the splice of a handler into a settings file's
// `hooks` key (`spliceProjectHook`, used by the hooks store's `saveProjectHook`), and the lines of the project
// section's file problems (`hookFileNotice`).
import type { HookCreate, HookDiagnostic, HookEntry, HookEvent, HookMatcherSubject, HookSpec, HookUpdate, PersonalHook, PromptHookSpec } from '@harness-forge/shared'
import {
  checkHookIf,
  claudeToolName,
  compileMatcher,
  HOOK_EVENTS,
  HOOK_LIMITS,
  HOOK_MATCHER_SUBJECTS,
  hookTargetNames,
  PROMPT_HOOK_EVENTS,
  readHooksConfig,
  readSettingsHooks,
  TOOL_HOOK_EVENTS,
} from '@harness-forge/shared'

/**
 * The actions of a hook row's menu (docs/UI.md 9.13); + Phase 12 (9.14): `trust-plugin` (Review plugin…, the hook of a
 * plugin that is not trusted) and `edit` / `delete` on project rows (the hook editor in project mode; removing the
 * handler from its settings file).
 */
export type HookAction = 'edit' | 'duplicate' | 'toggle' | 'copy-json' | 'delete' | 'review' | 'open-plugin' | 'trust-plugin'

/**
 * The editor's fields (`timeout` in seconds; null = the default 60 s, 30 s for a prompt hook). + Phase 12 (ADR-057): the
 * handler type and its fields; absent = a command hook with the Phase 11 defaults (`type: 'command'`, no prompt, no
 * model, `continueOnBlock: false`, no `args`, not `async`, no `if`, no `statusMessage`).
 */
export interface HookDraft {
  event: HookEvent
  matcher: string
  command: string
  timeout: number | null
  enabled: boolean
  /** + Phase 12: the handler type. */
  type?: 'command' | 'prompt'
  /** + Phase 12 (prompt hooks): the prompt (`$ARGUMENTS` = the event as JSON). */
  prompt?: string
  /** + Phase 12 (prompt hooks): a model ref or a Claude alias; null = the Hook model setting. */
  model?: string | null
  /** + Phase 12 (prompt hooks on PreToolUse / PostToolUse): a "not ok" answer is fed back instead of ending the turn. */
  continueOnBlock?: boolean
  /** + Phase 12 (command hooks): the exec-form arguments (`command` is then the program). */
  args?: string[]
  /** + Phase 12 (command hooks): runs detached; its output is not read. */
  async?: boolean
  /** + Phase 12 (tool events): the `if` rule (`Bash(git *)`); '' = none. */
  if?: string
  /** + Phase 12: the activity label while it runs; '' = "Running hook…". */
  statusMessage?: string
}

/**
 * Where the hook editor writes in project mode (Phase 12, ADR-056): the project, its settings file, the event and the
 * handler's position in the file's `hooks` key (null indexes = a new handler, appended to a group of its matcher).
 */
export interface ProjectHookTarget {
  projectId: string
  path: string
  event: HookEvent
  groupIndex: number | null
  handlerIndex: number | null
}

const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(TOOL_HOOK_EVENTS)
const PROMPT_EVENTS: ReadonlySet<HookEvent> = new Set(PROMPT_HOOK_EVENTS)
/** Events whose prompt hooks read `continueOnBlock` (`promptHookOutcome` of the shared `util/hooks.ts`). */
const CONTINUE_ON_BLOCK_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse'])

const EVENT_DESCRIPTIONS: Readonly<Record<HookEvent, string>> = {
  PreToolUse: 'Before a tool runs. It can block the call, allow it without asking or change its input.',
  PostToolUse: 'After a tool finished. It can give the agent feedback.',
  UserPromptSubmit: 'When you send a message, before the agent reads it. It can add context or block the message.',
  Notification: 'When the agent needs your attention, like an approval.',
  Stop: 'When the agent finishes a reply. It can make it continue.',
  SubagentStop: 'When a sub-agent finishes. It can make it continue.',
  PreCompact: 'Before the conversation is compacted.',
  SessionStart: 'When a chat\'s first reply starts, and again after a compaction. It can add context.',
  // Phase 12 (ADR-057; docs/UI.md 15).
  PostToolUseFailure: 'After a tool call failed. It can give the agent feedback.',
  PermissionRequest: 'When harness-forge is about to ask you to approve a tool call. It can allow or deny the call.',
  SubagentStart: 'When a sub-agent starts. It can add context for the sub-agent.',
  PostCompact: 'After the conversation was compacted.',
  SessionEnd: 'When you delete a chat.',
}

/** What the editor knows of an event. */
export interface HookEventInfo {
  /** Claude Code's spelling. */
  label: string
  description: string
  /** The matcher is matched against tool names. */
  toolMatcher: boolean
  /** + Phase 12: prompt hooks may use the event (`PROMPT_HOOK_EVENTS`). */
  promptAllowed: boolean
  /** + Phase 12: what the matcher is tested against (`HOOK_MATCHER_SUBJECTS`); null = no matcher. */
  matcher: HookMatcherSubject | null
}

/** The events in `HOOK_EVENTS` order: the label, the description, the matcher and whether prompt hooks may use them. */
export const HOOK_EVENT_INFO: Readonly<Record<HookEvent, HookEventInfo>> = Object.fromEntries(
  HOOK_EVENTS.map(event => [event, {
    label: event,
    description: EVENT_DESCRIPTIONS[event],
    toolMatcher: TOOL_EVENTS.has(event),
    promptAllowed: PROMPT_EVENTS.has(event),
    matcher: HOOK_MATCHER_SUBJECTS[event],
  }]),
) as Record<HookEvent, HookEventInfo>

/** The copy of the tab, the rows, the editor and the import (docs/UI.md 9.13, 9.14, 15). */
export const HOOK_COPY: Readonly<Record<string, string>> = {
  runHooks: 'Run hooks',
  runHooksHelp: 'Shell commands that run at points of the agent\'s work, like before a tool call. Off: no command hook runs, from any source.',
  shellOff: 'Hooks are turned off on this server (HF_WORKSPACE_SHELL=0).',
  safeMode: 'Hooks are turned off on this server (safe mode).',
  personalEmpty: 'No personal hooks yet. A hook runs a shell command when something happens, like before a tool call.',
  allTools: 'All tools',
  needsApproval: 'Needs approval',
  approved: 'Approved',
  off: 'Off',
  offOnServer: 'Off on this server',
  invalid: 'Invalid',
  pluginNotTrusted: 'Plugin not trusted',
  codeHook: 'Code hook',
  copied: 'Copied hook as JSON',
  deleted: 'Deleted hook',
  warning: 'Hooks run shell commands on your server with harness-forge\'s permissions, without asking, whenever their event happens. Only add commands you understand.',
  matcherHelp: 'Tool names separated by |. Claude Code names work too (Bash, Read, Write, Edit, Grep, Glob, WebFetch). Leave it empty or use * for every tool.',
  matcherInvalid: 'Use tool names, | and * only.',
  // The runner (workspace/shell.ts) prefers /bin/bash and falls back to /bin/sh.
  commandHelp: 'Runs with bash (or sh when bash is missing) in the project folder (outside projects, in a private folder). It gets the event as JSON on stdin; exit code 2 blocks with stderr as the reason.',
  commandMissing: 'Add the command.',
  timeoutInvalid: 'Enter a whole number from 1 to 600.',
  saved: 'Hook saved',
  passwordPrompt: 'Saving a hook needs your password.',
  importTitle: 'Import hooks',
  importHelp: 'Paste Claude Code settings JSON (the whole file or its "hooks" object).',
  invalidJson: 'This isn\'t valid JSON.',
  noHooks: 'No hooks found.',
  // Phase 12 (ADR-056, ADR-057; docs/UI.md 9.14, 15).
  typeCommand: 'Command',
  typePrompt: 'Prompt',
  promptWarning: 'A prompt hook asks a model about every matching event, using tokens each time. Its answer can block a call or make the agent continue, never allow one.',
  promptHelp: 'The model reads this with the event as JSON. $ARGUMENTS marks where the JSON goes; without it, the JSON is added at the end.',
  hookModel: 'Hook model',
  automaticModel: 'the provider\'s small model',
  continueOnBlock: 'Continue on block',
  continueOnBlockHelp: 'The reason goes back to the agent as feedback instead of ending the turn.',
  agentMatcher: 'Agent types',
  agentMatcherHelp: 'Agent type names separated by |, like explore|general. Leave it empty for every sub-agent.',
  args: 'Arguments',
  argsHelp: 'One per line. With arguments, the command is the program and each argument is passed as written, without a shell.',
  async: 'Run in the background',
  asyncHelp: 'The hook doesn\'t hold up the agent; it can\'t block a call or add context.',
  ifLabel: 'Only when',
  ifHelp: 'A tool name or a Bash rule such as Bash(npm run *). Other rules never run.',
  statusMessage: 'Status message',
  statusMessageHelp: 'Shown in the chat while the hook runs.',
  where: 'Where',
  personal: 'Personal',
  inBackground: 'In the background',
  reviewPlugin: 'Review plugin…',
  noLongerExists: 'This hook no longer exists.',
  reload: 'Load from disk',
  overwrite: 'Overwrite',
}

/** "Prompt hooks work only for {events}." (the seven events of ADR-057). */
export const PROMPT_EVENTS_TEXT = `Prompt hooks work only for ${PROMPT_HOOK_EVENTS.slice(0, -1).join(', ')} and ${PROMPT_HOOK_EVENTS.at(-1)}.`

/** "Runs with {model} (Settings → General → Agent → Hook model). It answers ok, or not ok with a reason." */
export function promptModelLine(model: string, fromSetting: boolean): string {
  return fromSetting
    ? `Runs with ${model} (Settings → General → Agent → Hook model). It answers ok, or not ok with a reason.`
    : `Runs with ${model}. It answers ok, or not ok with a reason.`
}

/** "Saved {path}." or "Saved {path}. {n} items need your approval." (docs/UI.md 9.14). */
export function projectSavedText(path: string, pending: number): string {
  if (pending <= 0)
    return `Saved ${path}.`
  return `Saved ${path}. ${pending === 1 ? '1 item needs' : `${pending} items need`} your approval.`
}

/** "{file} changed on disk after you opened it." */
export function staleFileText(path: string): string {
  return `${path} changed on disk after you opened it.`
}

/** The state badge of a row (null = an active personal or plugin hook: no badge). */
export function hookStateBadge(entry: HookEntry): { label: string, tone: 'muted' | 'warning' | 'destructive' | 'success' } | null {
  switch (entry.state) {
    case 'pending':
      // A plugin hook waits for its plugin's trust; a project hook for its approval.
      return { label: entry.source === 'plugin' ? HOOK_COPY.pluginNotTrusted! : HOOK_COPY.needsApproval!, tone: 'warning' }
    case 'off':
      return { label: HOOK_COPY.off!, tone: 'muted' }
    case 'invalid':
      return { label: HOOK_COPY.invalid!, tone: 'destructive' }
    case 'blocked':
      return { label: HOOK_COPY.offOnServer!, tone: 'muted' }
    default:
      return entry.source === 'project' ? { label: HOOK_COPY.approved!, tone: 'success' } : null
  }
}

/**
 * The muted second line of a row: the source ("Personal", "Project", the plugin's name), then "timeout {n}s" (when set)
 * and the settings file of a project hook; a code hook adds "Code hook". + Phase 12: "In the background" (`async`) and
 * "Only when {rule}" (`if`).
 */
export function hookRowMeta(entry: HookEntry, pluginName: (id: string) => string): string[] {
  const items: string[] = []
  if (entry.source === 'personal')
    items.push('Personal')
  else if (entry.source === 'project')
    items.push('Project')
  else
    items.push(entry.pluginId ? pluginName(entry.pluginId) : 'Plugin')
  if (entry.kind === 'command') {
    if (entry.timeout !== null)
      items.push(`timeout ${entry.timeout}s`)
    if (entry.path)
      items.push(entry.path)
    if (entry.async && entry.type !== 'prompt')
      items.push(HOOK_COPY.inBackground!)
    if (entry.if?.trim())
      items.push(`Only when ${entry.if.trim()}`)
  }
  else {
    items.push(HOOK_COPY.codeHook!)
  }
  return items
}

/** True for a matcher that matches every tool (empty, `*`, or an alternative made of wildcards only). */
export function matchesEveryTool(matcher: string | null | undefined): boolean {
  const text = matcher?.trim() ?? ''
  if (text === '' || text === '*')
    return true
  return text.split('|').some(part => part.trim() !== '' && part.trim().replace(/\.\*/g, '*').split('*').every(piece => piece === ''))
}

/** The matcher text of a row: "All tools" for an every-tool matcher of a tool event, else the matcher (or null). */
export function hookMatcherText(entry: HookEntry): string | null {
  if (entry.kind !== 'command')
    return null
  if (TOOL_EVENTS.has(entry.event))
    return matchesEveryTool(entry.matcher) ? HOOK_COPY.allTools! : entry.matcher!.trim()
  return entry.matcher?.trim() || null
}

/** The first non-empty line of a prompt (rows and import items show it instead of a command). */
export function promptFirstLine(prompt: string | null | undefined): string {
  const lines = (prompt ?? '').split(/\r?\n/)
  return (lines.find(line => line.trim() !== '') ?? '').trim()
}

/** An exec-form command as one line: the program, then each argument (quoted when it holds blanks or quotes). */
export function execFormText(command: string, args: readonly string[] | null | undefined): string {
  if (!args || args.length === 0)
    return command
  const words = args.map(arg => (arg === '' || /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg))
  return [command, ...words].join(' ')
}

/**
 * What a row or an import item shows as its handler (+ Phase 12): the prompt's first line of a prompt hook, else the
 * command with its exec-form arguments.
 */
export function hookDraftText(draft: HookDraft): string {
  return draft.type === 'prompt' ? promptFirstLine(draft.prompt) : execFormText(draft.command, draft.args)
}

/** Names listed in a preview before "and {n} more". */
const PREVIEW_NAMES_MAX = 8

/** "shell (Bash)": a harness tool with its Claude Code name. */
function toolLabel(tool: string): string {
  const claude = claudeToolName(tool)
  return claude ? `${tool} (${claude})` : tool
}

function listText(names: readonly string[]): string {
  if (names.length <= PREVIEW_NAMES_MAX)
    return names.join(', ')
  return `${names.slice(0, PREVIEW_NAMES_MAX).join(', ')} and ${names.length - PREVIEW_NAMES_MAX} more`
}

/**
 * The matcher preview of the editor (docs/UI.md 9.13): the tools of `tools` (harness names) the matcher matches under
 * their harness or Claude Code names, as "Matches {list}" (the harness names with the Claude alias in brackets), "No tool
 * is named {name} now." for alternatives that match nothing, or the invalid-matcher text (`ok` false). An every-tool
 * matcher has no text (the help says it) and matches every tool.
 */
export function matcherPreview(matcher: string, tools: readonly string[]): { ok: boolean, matches: string[], text: string } {
  const compiled = compileMatcher(matcher)
  if (!compiled.ok)
    return { ok: false, matches: [], text: HOOK_COPY.matcherInvalid! }
  const known = [...new Set(tools)]
  if (matchesEveryTool(matcher))
    return { ok: true, matches: known, text: '' }
  const matches = known.filter(tool => hookTargetNames(tool).some(name => compiled.test(name)))
  const unknown: string[] = []
  for (const part of matcher.split('|')) {
    const alternative = part.trim()
    if (alternative === '' || unknown.includes(alternative))
      continue
    const single = compileMatcher(alternative)
    if (single.ok && !known.some(tool => hookTargetNames(tool).some(name => single.test(name))))
      unknown.push(alternative)
  }
  const lines: string[] = []
  if (matches.length > 0)
    lines.push(`Matches ${listText(matches.map(toolLabel))}`)
  if (unknown.length > 0)
    lines.push(`No tool is named ${unknown.join(', ')} now.`)
  return { ok: true, matches, text: lines.join('. ') }
}

// ---------- drafts ----------

/** The handler fields of a draft that only some hooks set (added only when set, so plain drafts stay small). */
function handlerExtras(source: { args?: readonly string[] | null, async?: boolean | null, if?: string | null, statusMessage?: string | null }, type: 'command' | 'prompt'): Partial<HookDraft> {
  const extras: Partial<HookDraft> = {}
  if (type === 'command' && source.args && source.args.length > 0)
    extras.args = [...source.args]
  if (type === 'command' && source.async === true)
    extras.async = true
  if (source.if?.trim())
    extras.if = source.if.trim()
  if (source.statusMessage?.trim())
    extras.statusMessage = source.statusMessage.trim()
  return extras
}

/** The editor's draft of a command hook (Duplicate, Copy to personal, edit); a code hook gives an empty draft. */
export function draftFromHook(entry: HookEntry): HookDraft {
  if (entry.kind !== 'command')
    return { event: 'PreToolUse', matcher: '', command: '', timeout: null, enabled: true }
  const base: HookDraft = { event: entry.event, matcher: entry.matcher ?? '', command: entry.command, timeout: entry.timeout, enabled: entry.state !== 'off' }
  if (entry.type === 'prompt') {
    return {
      ...base,
      command: '',
      type: 'prompt',
      prompt: entry.prompt ?? '',
      model: entry.model ?? null,
      continueOnBlock: entry.continueOnBlock ?? false,
      ...handlerExtras(entry, 'prompt'),
    }
  }
  return { ...base, ...handlerExtras(entry, 'command') }
}

/** + Phase 12: the editor's draft of a personal hook (edit mode). */
export function draftFromPersonal(hook: PersonalHook): HookDraft {
  const base: HookDraft = { event: hook.event, matcher: hook.matcher ?? '', command: '', timeout: hook.timeout, enabled: hook.enabled }
  if (hook.type === 'prompt') {
    return { ...base, type: 'prompt', prompt: hook.prompt, model: hook.model, continueOnBlock: hook.continueOnBlock ?? false, ...handlerExtras(hook, 'prompt') }
  }
  return { ...base, command: hook.command, ...handlerExtras(hook, 'command') }
}

/** Every field of a draft (the Phase 12 fields with their defaults). */
export type FullHookDraft = Required<Omit<HookDraft, 'model'>> & { model: string | null }

/** + Phase 12: `draft` with every field set (absent Phase 12 fields take their defaults). */
export function fullDraft(draft: HookDraft): FullHookDraft {
  return {
    event: draft.event,
    matcher: draft.matcher,
    command: draft.command,
    timeout: draft.timeout,
    enabled: draft.enabled,
    type: draft.type ?? 'command',
    prompt: draft.prompt ?? '',
    model: draft.model ?? null,
    continueOnBlock: draft.continueOnBlock ?? false,
    args: draft.args ? [...draft.args] : [],
    async: draft.async ?? false,
    if: draft.if ?? '',
    statusMessage: draft.statusMessage ?? '',
  }
}

/** A draft as the server stores it: trimmed, the fields that do not apply to its type or event dropped. */
interface NormalHook {
  type: 'command' | 'prompt'
  event: HookEvent
  matcher: string | null
  command: string
  args: string[]
  async: boolean
  prompt: string
  model: string | null
  continueOnBlock: boolean
  timeout: number | null
  enabled: boolean
  if: string | null
  statusMessage: string | null
}

function normalize(draft: HookDraft): NormalHook {
  const full = fullDraft(draft)
  const prompt = full.type === 'prompt'
  return {
    type: full.type,
    event: full.event,
    matcher: full.matcher.trim() || null,
    command: prompt ? '' : full.command.trim(),
    args: prompt ? [] : full.args,
    async: !prompt && full.async,
    prompt: prompt ? full.prompt.trim() : '',
    model: prompt ? full.model?.trim() || null : null,
    continueOnBlock: prompt && CONTINUE_ON_BLOCK_EVENTS.has(full.event) && full.continueOnBlock,
    timeout: full.timeout,
    enabled: full.enabled,
    if: TOOL_EVENTS.has(full.event) ? full.if.trim() || null : null,
    statusMessage: full.statusMessage.trim() || null,
  }
}

/**
 * + Phase 12: the body of `POST /hooks` for a draft: a command hook (`args`, `async`, `if` and `statusMessage` only when
 * set) or a prompt hook (`type: 'prompt'`; `model` when set, `continueOnBlock` only on PreToolUse / PostToolUse). `if`
 * is kept only on tool events.
 */
export function hookCreateBody(draft: HookDraft): HookCreate {
  const hook = normalize(draft)
  const extras = {
    ...(hook.if === null ? {} : { if: hook.if }),
    ...(hook.statusMessage === null ? {} : { statusMessage: hook.statusMessage }),
  }
  if (hook.type === 'prompt') {
    return {
      type: 'prompt',
      event: hook.event,
      matcher: hook.matcher,
      prompt: hook.prompt,
      ...(hook.model === null ? {} : { model: hook.model }),
      timeout: hook.timeout,
      ...(hook.continueOnBlock ? { continueOnBlock: true } : {}),
      enabled: hook.enabled,
      ...extras,
    }
  }
  return {
    event: hook.event,
    matcher: hook.matcher,
    command: hook.command,
    timeout: hook.timeout,
    enabled: hook.enabled,
    ...(hook.args.length > 0 ? { args: hook.args } : {}),
    ...(hook.async ? { async: true } : {}),
    ...extras,
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/**
 * + Phase 12: the body of `PATCH /hooks/:id` that turns `hook` into `draft`: only the changed fields; a changed type sends
 * `type` with every field of the new type (command and prompt fields never mix); a cleared `args`, `if`,
 * `statusMessage` or `model` is sent as null. An unchanged draft gives `{}`.
 */
export function hookPatch(hook: PersonalHook, draft: HookDraft): HookUpdate {
  const before = normalize(draftFromPersonal(hook))
  const after = normalize(draft)
  const patch: HookUpdate = {}
  if (before.type !== after.type) {
    patch.type = after.type
    if (after.type === 'prompt') {
      patch.prompt = after.prompt
      patch.model = after.model
      if (after.continueOnBlock)
        patch.continueOnBlock = true
    }
    else {
      patch.command = after.command
      if (after.args.length > 0)
        patch.args = after.args
      if (after.async)
        patch.async = true
    }
  }
  else if (after.type === 'prompt') {
    if (after.prompt !== before.prompt)
      patch.prompt = after.prompt
    if (after.model !== before.model)
      patch.model = after.model
    if (after.continueOnBlock !== before.continueOnBlock)
      patch.continueOnBlock = after.continueOnBlock
  }
  else {
    if (after.command !== before.command)
      patch.command = after.command
    if (!sameList(after.args, before.args))
      patch.args = after.args.length > 0 ? after.args : null
    if (after.async !== before.async)
      patch.async = after.async
  }
  if (after.event !== before.event)
    patch.event = after.event
  if (after.matcher !== before.matcher)
    patch.matcher = after.matcher
  if (after.timeout !== before.timeout)
    patch.timeout = after.timeout
  if (after.enabled !== before.enabled)
    patch.enabled = after.enabled
  if (after.if !== before.if)
    patch.if = after.if
  if (after.statusMessage !== before.statusMessage)
    patch.statusMessage = after.statusMessage
  return patch
}

/**
 * + Phase 12: one handler of a Claude Code `hooks` object for a draft (`{ type: 'command', command, args?, timeout?,
 * async?, if?, statusMessage? }` or `{ type: 'prompt', prompt, model?, timeout?, continueOnBlock?, if?, statusMessage?
 * }`), the keys set only when they apply.
 */
export function hookHandlerJson(draft: HookDraft): Record<string, unknown> {
  const hook = normalize(draft)
  const handler: Record<string, unknown> = hook.type === 'prompt'
    ? { type: 'prompt', prompt: hook.prompt, ...(hook.model === null ? {} : { model: hook.model }) }
    : { type: 'command', command: hook.command, ...(hook.args.length > 0 ? { args: hook.args } : {}) }
  if (hook.timeout !== null)
    handler.timeout = hook.timeout
  if (hook.async)
    handler.async = true
  if (hook.continueOnBlock)
    handler.continueOnBlock = true
  if (hook.if !== null)
    handler.if = hook.if
  if (hook.statusMessage !== null)
    handler.statusMessage = hook.statusMessage
  return handler
}

/**
 * The Claude Code `hooks` object of command rows, pretty-printed (`{ "hooks": { <Event>: [{ matcher?, hooks: [{ type:
 * "command", command, timeout? }] }] } }`): rows of the same event and matcher share one group, in row order; events
 * follow `HOOK_EVENTS` order. Code hooks are left out. + Phase 12: prompt rows give `type: "prompt"` handlers, and the
 * handler fields (`args`, `async`, `if`, `statusMessage`, `model`, `continueOnBlock`) are kept.
 */
export function hookJson(entries: readonly HookEntry[]): string {
  const groups = new Map<HookEvent, { matcher: string | null, hooks: Record<string, unknown>[] }[]>()
  for (const entry of entries) {
    if (entry.kind !== 'command')
      continue
    const matcher = entry.matcher?.trim() || null
    const handler = hookHandlerJson(draftFromHook(entry))
    const list = groups.get(entry.event) ?? []
    const group = list.find(item => item.matcher === matcher)
    if (group)
      group.hooks.push(handler)
    else
      list.push({ matcher, hooks: [handler] })
    groups.set(entry.event, list)
  }
  const hooks: Record<string, unknown[]> = {}
  for (const event of HOOK_EVENTS) {
    const list = groups.get(event)
    if (list)
      hooks[event] = list.map(group => (group.matcher === null ? { hooks: group.hooks } : { matcher: group.matcher, hooks: group.hooks }))
  }
  return JSON.stringify({ hooks }, null, 2)
}

// ---------- import ----------

/** One handler of an import preview. */
export interface ImportedHook {
  draft: HookDraft
  /** False for a handler the server would refuse (an invalid matcher): unchecked and disabled. */
  valid: boolean
  /** Why it is invalid, else null. */
  message: string | null
}

/** Pasted or chosen files above this size are refused (docs/UI.md 9.13). */
export const HOOK_IMPORT_MAX_BYTES = 256 * 1024

/** Characters of a handler type quoted in a note. */
const TYPE_SHOWN_MAX = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimeout(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= HOOK_LIMITS.timeoutMaxSec ? value : null
}

/** The raw group and handler a diagnostic points at, or null. */
function rawAt(config: Record<string, unknown>, event: HookEvent, [group, handler]: readonly [number, number]): { group: Record<string, unknown>, handler: unknown } | null {
  const groups = config[event]
  const rawGroup = Array.isArray(groups) ? groups[group] : undefined
  if (!isRecord(rawGroup) || !Array.isArray(rawGroup.hooks))
    return null
  return { group: rawGroup, handler: rawGroup.hooks[handler] }
}

/** The draft of a handler in a group with an invalid matcher (for such a group the reader returns no item). */
function rawDraft(config: Record<string, unknown>, event: HookEvent, position: readonly [number, number]): HookDraft | null {
  const raw = rawAt(config, event, position)
  if (!raw || !isRecord(raw.handler))
    return null
  const handler = raw.handler
  const matcher = typeof raw.group.matcher === 'string' ? raw.group.matcher : ''
  const base = { event, matcher, timeout: validTimeout(handler.timeout), enabled: true }
  if (handler.type === 'prompt' && typeof handler.prompt === 'string' && handler.prompt.trim() !== '')
    return { ...base, command: '', type: 'prompt', prompt: handler.prompt.trim().slice(0, HOOK_LIMITS.promptMaxChars), model: null, continueOnBlock: false }
  if (handler.type !== 'command' || typeof handler.command !== 'string' || handler.command.trim() === '')
    return null
  return { ...base, command: handler.command.trim().slice(0, HOOK_LIMITS.commandMaxChars) }
}

/** The `type` of the raw handler a diagnostic points at, cleaned for a note, or null. */
function rawType(config: unknown, diagnostic: HookDiagnostic): string | null {
  if (!isRecord(config) || !diagnostic.event || !diagnostic.position)
    return null
  const raw = rawAt(config, diagnostic.event, diagnostic.position)
  const type = raw && isRecord(raw.handler) ? raw.handler.type : undefined
  if (typeof type !== 'string')
    return null
  const clean = type.replace(/\p{Cc}/gu, '').trim()
  return clean === '' ? null : clean.slice(0, TYPE_SHOWN_MAX)
}

/** The shared reader's messages of the handler types it does not run (`unsupported-type`), by type. */
const UNSUPPORTED_TYPE_PREFIXES: readonly (readonly [string, string])[] = [
  ['HTTP hooks are not supported', 'http'],
  ['MCP tool hooks are not supported', 'mcp_tool'],
  ['Agent hooks are not supported', 'agent'],
]

/** The handler type an `unsupported-type` message names (`http`, `mcp_tool`, `agent`), else null. */
function unsupportedTypeOf(message: string): string | null {
  return UNSUPPORTED_TYPE_PREFIXES.find(([prefix]) => message.startsWith(prefix))?.[1] ?? null
}

/** The event name of the shared reader's `unknown-event` message ('The event "X" is not supported; …'), else null. */
function unknownEventName(message: string): string | null {
  const head = 'The event "'
  const tail = '" is not supported'
  if (!message.startsWith(head))
    return null
  const end = message.indexOf(tail, head.length)
  return end > head.length ? message.slice(head.length, end) : null
}

/** The note of a diagnostic the preview leaves out, or null (ignored fields stay quiet). */
function noteOf(diagnostic: HookDiagnostic, config: unknown): string | null {
  if (diagnostic.code === 'ignored-field')
    return null
  if (diagnostic.code === 'unsupported-type') {
    const type = rawType(config, diagnostic) ?? unsupportedTypeOf(diagnostic.message)
    if (type !== null && type !== 'prompt' && type !== 'command')
      return `Ignored: ${type} hooks aren't supported.`
    return `Ignored: ${diagnostic.message}`
  }
  const where = diagnostic.event ? `${diagnostic.event}: ` : ''
  return `${where}${diagnostic.message}`
}

/** The draft of a command handler the shared reader returned. */
function commandDraftOf(spec: HookSpec): HookDraft {
  return { event: spec.event, matcher: spec.matcher ?? '', command: spec.command, timeout: spec.timeoutSec, enabled: true, ...handlerExtras(spec, 'command') }
}

/** The draft of a prompt handler the shared reader returned. */
function promptDraftOf(spec: PromptHookSpec): HookDraft {
  return {
    event: spec.event,
    matcher: spec.matcher ?? '',
    command: '',
    timeout: spec.timeoutSec,
    enabled: true,
    type: 'prompt',
    prompt: spec.prompt,
    model: spec.model,
    continueOnBlock: spec.continueOnBlock,
    ...handlerExtras(spec, 'prompt'),
  }
}

/**
 * Reads pasted Claude Code settings JSON (the whole file, through the shared `readSettingsHooks`, or its `hooks`
 * object, through `readHooksConfig`) into drafts, in file order: valid handlers and handlers of a group with an
 * invalid matcher (`valid` false, "Use tool names, | and * only."), the notes of what was left out (unknown events,
 * other problems) and the error of an unreadable text ("This isn't valid JSON.", "No hooks found."). + Phase 12: prompt
 * handlers and the handler fields are read too; `http`, `mcp_tool` and `agent` handlers are noted as "Ignored: {type}
 * hooks aren't supported.".
 */
export function importHooks(text: string): { items: ImportedHook[], notes: string[], error: string | null } {
  const source = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  if (source.trim() === '')
    return { items: [], notes: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  }
  catch {
    return { items: [], notes: [], error: HOOK_COPY.invalidJson! }
  }
  if (!isRecord(parsed))
    return { items: [], notes: [], error: HOOK_COPY.noHooks! }
  const wholeFile = Object.hasOwn(parsed, 'hooks')
  const config = wholeFile ? parsed.hooks : parsed
  const result = wholeFile
    ? readSettingsHooks(source, { file: 'settings.json', maxBytes: HOOK_IMPORT_MAX_BYTES, prompts: true })
    : readHooksConfig(parsed, { source: 'personal', prompts: true })

  const order = isRecord(config) ? Object.keys(config) : []
  const ready = (draft: HookDraft, position: readonly [number, number]): { at: [number, number, number], item: ImportedHook } => ({
    at: [order.indexOf(draft.event), position[0], position[1]],
    item: { draft, valid: true, message: null },
  })
  const positioned = [
    ...result.items.map(spec => ready(commandDraftOf(spec), spec.position)),
    ...result.prompts.map(spec => ready(promptDraftOf(spec), spec.position)),
  ]
  const notes: string[] = []
  for (const diagnostic of result.diagnostics) {
    const matcherProblem = (diagnostic.code === 'invalid-matcher' || diagnostic.code === 'too-long') && diagnostic.event && diagnostic.position
    const draft = matcherProblem && isRecord(config) ? rawDraft(config, diagnostic.event!, diagnostic.position!) : null
    if (draft && diagnostic.position) {
      positioned.push({
        at: [order.indexOf(draft.event), diagnostic.position[0], diagnostic.position[1]],
        item: { draft, valid: false, message: HOOK_COPY.matcherInvalid! },
      })
      continue
    }
    const note = noteOf(diagnostic, config)
    if (note && !notes.includes(note))
      notes.push(note)
  }
  positioned.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2])
  const items = positioned.map(entry => entry.item)
  if (items.length === 0) {
    const fileProblem = result.diagnostics.find(diagnostic => diagnostic.code === 'too-large')
    return { items, notes: notes.filter(note => note !== fileProblem?.message), error: fileProblem?.message ?? HOOK_COPY.noHooks! }
  }
  return { items, notes, error: null }
}

/** "Found {n} hooks" / "Found 1 hook". */
export function foundHooksText(count: number): string {
  return `Found ${count} ${count === 1 ? 'hook' : 'hooks'}`
}

/** "Add {n} hooks" / "Add 1 hook". */
export function addHooksText(count: number): string {
  return `Add ${count} ${count === 1 ? 'hook' : 'hooks'}`
}

/** "Added {n} hooks" / "Added 1 hook". */
export function addedHooksText(count: number): string {
  return `Added ${count} ${count === 1 ? 'hook' : 'hooks'}`
}

// ---------- the project section's file problems ----------

/**
 * One line of the project section's file problems (docs/UI.md 9.14): "{file}: {message}" for errors and warnings,
 * "{file}: The hook event {event} isn't supported." (`unknown-event`, info) and "{file}: {type} hooks aren't
 * supported." (`unsupported-type`); null for the other info-level diagnostics (ignored fields stay quiet).
 */
export function hookFileNotice(diagnostic: Pick<HookDiagnostic, 'level' | 'code' | 'message' | 'file'>): string | null {
  const file = diagnostic.file ? `${diagnostic.file}: ` : ''
  if (diagnostic.code === 'unknown-event') {
    const name = unknownEventName(diagnostic.message)
    return `${file}${name ? `The hook event ${name} isn't supported.` : diagnostic.message}`
  }
  if (diagnostic.code === 'unsupported-type') {
    const type = unsupportedTypeOf(diagnostic.message)
    return `${file}${type ? `${type} hooks aren't supported.` : diagnostic.message}`
  }
  if (diagnostic.level === 'info')
    return null
  return `${file}${diagnostic.message}`
}

// ---------- editor rules ----------

/** The matcher's problem in the editor's words, else null (tool events only). */
export function matcherError(value: string): string | null {
  if (value.trim().length > HOOK_LIMITS.matcherMaxChars)
    return `Use at most ${HOOK_LIMITS.matcherMaxChars} characters.`
  return compileMatcher(value).ok ? null : HOOK_COPY.matcherInvalid!
}

/** A prompt's problem (Phase 12): empty, longer than 16,384 characters or with NUL characters; else null. */
export function promptError(text: string): string | null {
  if (text.trim() === '')
    return 'Add the prompt.'
  if (text.length > HOOK_LIMITS.promptMaxChars)
    return `Use at most ${HOOK_LIMITS.promptMaxChars.toLocaleString('en-US')} characters.`
  if (text.includes('\0'))
    return 'The prompt cannot contain NUL characters.'
  return null
}

/** + Phase 12: "Prompt hooks work only for {events}." for a prompt hook on an event that takes none, else null. */
export function promptEventError(type: 'command' | 'prompt', event: HookEvent): string | null {
  return type === 'prompt' && !PROMPT_EVENTS.has(event) ? PROMPT_EVENTS_TEXT : null
}

/** The command's problem, else null. */
export function commandError(value: string): string | null {
  if (value.trim() === '')
    return HOOK_COPY.commandMissing!
  if (value.length > HOOK_LIMITS.commandMaxChars)
    return `Use at most ${HOOK_LIMITS.commandMaxChars.toLocaleString('en-US')} characters.`
  if (value.includes('\0'))
    return 'The command cannot contain NUL characters.'
  return null
}

/** + Phase 12: the exec-form arguments of the Arguments field (one per line; blank lines are dropped). */
export function parseHookArgs(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line.trim() !== '')
}

/** + Phase 12: the arguments' problem (at most 64, no NUL, at most 4,096 characters with the command), else null. */
export function argsError(args: readonly string[], command: string): string | null {
  if (args.length > HOOK_LIMITS.argsMax)
    return `Use at most ${HOOK_LIMITS.argsMax} arguments.`
  if (args.some(arg => arg.includes('\0')))
    return 'Arguments cannot contain NUL characters.'
  const length = args.reduce((total, arg) => total + arg.length, command.trim().length)
  if (length > HOOK_LIMITS.commandMaxChars)
    return `The command and its arguments are longer than ${HOOK_LIMITS.commandMaxChars.toLocaleString('en-US')} characters.`
  return null
}

/** + Phase 12: the `if` rule's problem (the shared `checkHookIf`; '' = none), else null. */
export function ifError(value: string): string | null {
  const rule = value.trim()
  if (rule === '')
    return null
  if (rule.length > HOOK_LIMITS.ifMaxChars)
    return `Use at most ${HOOK_LIMITS.ifMaxChars} characters.`
  return checkHookIf(rule)
}

/** + Phase 12: the status message's problem (at most 200 characters, no control characters; '' = none), else null. */
export function statusMessageError(value: string): string | null {
  const text = value.trim()
  if (text === '')
    return null
  if (text.length > HOOK_LIMITS.statusMessageMaxChars)
    return `Use at most ${HOOK_LIMITS.statusMessageMaxChars} characters.`
  return /^\P{Cc}*$/u.test(text) ? null : 'Control characters are not allowed.'
}

/** A typed timeout: '' = the default (null), else a whole number from 1 to 600. */
export function parseHookTimeout(text: string): { value: number | null } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '')
    return { value: null }
  const value = /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : Number.NaN
  return Number.isInteger(value) && value >= 1 && value <= HOOK_LIMITS.timeoutMaxSec
    ? { value }
    : { error: HOOK_COPY.timeoutInvalid! }
}

/**
 * The texts of the delete confirmation (docs/UI.md 9.13); + Phase 12: a project hook is removed from its settings file
 * ("It's removed from {path}.").
 */
export function hookDeleteCopy(entry: HookEntry): { title: string, description: string, confirm: string } {
  const path = entry.kind === 'command' && entry.source === 'project' ? entry.path : undefined
  return { title: 'Delete this hook?', description: path ? `It's removed from ${path}.` : 'It stops running at once.', confirm: 'Delete hook' }
}

/** Rows in event order (`HOOK_EVENTS`), then by matcher, then by command (a prompt hook: its prompt); code hooks last. */
export function sortHookEntries(entries: readonly HookEntry[]): HookEntry[] {
  const rank = (entry: HookEntry): number => (entry.kind === 'command' ? HOOK_EVENTS.indexOf(entry.event) : HOOK_EVENTS.length)
  const handler = (entry: Extract<HookEntry, { kind: 'command' }>): string => (entry.type === 'prompt' ? entry.prompt ?? '' : entry.command)
  return [...entries].sort((a, b) => {
    const byEvent = rank(a) - rank(b)
    if (byEvent !== 0)
      return byEvent
    if (a.kind === 'command' && b.kind === 'command')
      return (a.matcher ?? '').localeCompare(b.matcher ?? '') || handler(a).localeCompare(handler(b))
    return a.event.localeCompare(b.event)
  })
}

// ---------- project settings files (Phase 12, ADR-056) ----------

/** The settings files of a project whose `hooks` key the editor writes, lowest precedence first (docs/UI.md 9.13). */
export const PROJECT_HOOK_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.harness/settings.json', '.harness/settings.local.json'] as const

/** True for one of the four project settings files. */
export function isProjectHookFile(path: string): boolean {
  return (PROJECT_HOOK_FILES as readonly string[]).includes(path)
}

/** The project row of `entries` at `target` (its settings file, event and position), or null. */
export function projectEntryAt(entries: readonly HookEntry[], target: Pick<ProjectHookTarget, 'path' | 'event' | 'groupIndex' | 'handlerIndex'>): Extract<HookEntry, { kind: 'command' }> | null {
  if (target.groupIndex === null || target.handlerIndex === null)
    return null
  for (const entry of entries) {
    if (entry.kind === 'command' && entry.source === 'project' && entry.path === target.path && entry.event === target.event
      && entry.position?.[0] === target.groupIndex && entry.position[1] === target.handlerIndex) {
      return entry
    }
  }
  return null
}

/** True when two drafts are the same handler: type, event, matcher, command (with its arguments) or prompt. */
export function sameHandler(a: HookDraft, b: HookDraft): boolean {
  const left = normalize(a)
  const right = normalize(b)
  return left.type === right.type && left.event === right.event && left.matcher === right.matcher
    && left.command === right.command && left.prompt === right.prompt && sameList(left.args, right.args)
}

/** The keys of a raw handler the editor writes; the others (`once`, `shell`, unknown keys) are kept as they are. */
const MANAGED_HANDLER_KEYS: ReadonlySet<string> = new Set(['type', 'command', 'args', 'timeout', 'async', 'asyncRewake', 'if', 'statusMessage', 'prompt', 'model', 'continueOnBlock'])

function groupMatcher(group: Record<string, unknown>): string {
  return typeof group.matcher === 'string' ? group.matcher.trim() : ''
}

/**
 * True when the raw handler at `target` of a file's `hooks` value is the `listed` handler (type, matcher, command with
 * its arguments or prompt): the file still holds what the listing showed.
 */
export function rawHandlerMatches(hooks: unknown, target: Pick<ProjectHookTarget, 'event' | 'groupIndex' | 'handlerIndex'>, listed: HookDraft): boolean {
  if (!isRecord(hooks) || target.groupIndex === null || target.handlerIndex === null)
    return false
  const raw = rawAt(hooks, target.event, [target.groupIndex, target.handlerIndex])
  if (!raw || !isRecord(raw.handler))
    return false
  const handler = raw.handler
  const base = { event: target.event, matcher: groupMatcher(raw.group), timeout: null, enabled: true }
  const draft: HookDraft = handler.type === 'prompt'
    ? { ...base, command: '', type: 'prompt', prompt: typeof handler.prompt === 'string' ? handler.prompt : '' }
    : {
        ...base,
        command: typeof handler.command === 'string' ? handler.command : '',
        ...(Array.isArray(handler.args) && handler.args.every(arg => typeof arg === 'string') ? { args: handler.args as string[] } : {}),
      }
  return sameHandler(draft, listed)
}

/** The result of `spliceProjectHook`. */
export type ProjectHookSplice
  = | { ok: true, hooks: Record<string, unknown> | null }
    | { ok: false, reason: 'missing' | 'invalid', message: string }

/**
 * + Phase 12 (ADR-056): the `hooks` value of a settings file after writing `draft` at `target` (`hooks` is the value the
 * file had, `undefined` when it had none): a new handler (null indexes) joins the first group of its event with the
 * same matcher, else a new group at the end; an edited handler is replaced in place (its group's matcher changes with
 * it when it is the group's only handler), or moves to its new event or matcher group; `draft` null removes the
 * handler. A group or an event left empty is removed; an empty result is null (the key is removed). What the editor
 * does not write is kept (other events and groups as they are; a handler's `once`, `shell` and unknown keys).
 * `missing`: the handler at `target` is not there any more (the file changed); `invalid`: the file's `hooks` is not an
 * object or an event is not a list.
 */
export function spliceProjectHook(hooks: unknown, target: Pick<ProjectHookTarget, 'event' | 'groupIndex' | 'handlerIndex'>, draft: HookDraft | null): ProjectHookSplice {
  if (hooks !== undefined && hooks !== null && !isRecord(hooks))
    return { ok: false, reason: 'invalid', message: 'The "hooks" of this settings file must be an object.' }
  const copy: Record<string, unknown> = isRecord(hooks) ? JSON.parse(JSON.stringify(hooks)) as Record<string, unknown> : {}
  const finish = (): ProjectHookSplice => ({ ok: true, hooks: Object.keys(copy).length === 0 ? null : copy })

  const add = (event: HookEvent, handler: Record<string, unknown>, matcher: string): ProjectHookSplice | null => {
    const groups = copy[event]
    const group = matcher === '' ? { hooks: [handler] } : { matcher, hooks: [handler] }
    if (groups === undefined || groups === null) {
      copy[event] = [group]
      return null
    }
    if (!Array.isArray(groups))
      return { ok: false, reason: 'invalid', message: `The ${event} hooks of this settings file must be a list.` }
    const same = groups.find((item: unknown): item is Record<string, unknown> & { hooks: unknown[] } => isRecord(item) && Array.isArray(item.hooks) && groupMatcher(item) === matcher)
    if (same)
      same.hooks.push(handler)
    else
      groups.push(group)
    return null
  }

  if (target.groupIndex === null || target.handlerIndex === null) {
    if (draft === null)
      return finish()
    return add(draft.event, hookHandlerJson(draft), draft.matcher.trim()) ?? finish()
  }

  const groupIndex = target.groupIndex
  const handlerIndex = target.handlerIndex
  const groups = copy[target.event]
  const group = Array.isArray(groups) ? groups[groupIndex] : undefined
  if (!Array.isArray(groups) || !isRecord(group) || !Array.isArray(group.hooks) || group.hooks[handlerIndex] === undefined)
    return { ok: false, reason: 'missing', message: 'The hook is no longer in this settings file.' }
  const handlers = group.hooks as unknown[]
  const raw = handlers[handlerIndex]

  const remove = (): void => {
    handlers.splice(handlerIndex, 1)
    if (handlers.length === 0)
      groups.splice(groupIndex, 1)
    if (groups.length === 0)
      delete copy[target.event]
  }

  if (draft === null) {
    remove()
    return finish()
  }
  const kept = isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter(([key]) => !MANAGED_HANDLER_KEYS.has(key))) : {}
  const handler = { ...hookHandlerJson(draft), ...kept }
  const matcher = draft.matcher.trim()
  const sameMatcher = groupMatcher(group) === matcher
  if (draft.event === target.event && (sameMatcher || handlers.length === 1)) {
    handlers[handlerIndex] = handler
    if (!sameMatcher) {
      if (matcher === '')
        delete group.matcher
      else
        group.matcher = matcher
    }
    return finish()
  }
  remove()
  return add(draft.event, handler, matcher) ?? finish()
}
