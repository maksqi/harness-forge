// Plugin code hooks of the Phase 11 events (plugin API 1.5.0, ADR-048; PLUGINS.md 9): `ctx.hooks.on` handlers of the
// `HookMap` events that match a command hook event run through the registry's hook runner (`registry.hooks.run`: in
// call order, each guarded by 3 s, 5 consecutive failures disable a handler) together with the command hooks of that
// event, and their output joins the combination as a `plugin` outcome:
//
//   UserPromptSubmit -> 'prompt.submit'  ({ block?, context? })     Stop         -> 'run.stop'       ({ continue? })
//   SessionStart     -> 'session.start'  ({ context? })             SubagentStop -> 'subagent.stop'  ({ continue? })
//   PreCompact       -> 'compact.before' (observe only)             Notification -> 'notification'   (observe only)
//
// `PreToolUse` / `PostToolUse` have no entry here: their code hooks (`tool.approve`, `tool.before`, `tool.after`) run
// in the chat pipeline's approval and tool wrapper. The kill switches never stop code hooks (trusted in-process code).
import type { HookName } from '@harness-forge/plugin-sdk'
import type { HookEvent, HookOutcome } from '@harness-forge/shared'
import type { Registry } from '../../registry/types.ts'
import type { HookRunInput, HookScope } from './types.ts'
import { LIMITS } from '@harness-forge/shared'

/** The code hook event that runs with a command hook event. */
export const CODE_HOOK_EVENTS = {
  UserPromptSubmit: 'prompt.submit',
  SessionStart: 'session.start',
  Stop: 'run.stop',
  SubagentStop: 'subagent.stop',
  PreCompact: 'compact.before',
  Notification: 'notification',
} as const satisfies Partial<Record<HookEvent, HookName>>

export type CodeHookName = (typeof CODE_HOOK_EVENTS)[keyof typeof CODE_HOOK_EVENTS]

/**
 * The code hook events `GET /hooks` lists (`kind: 'code'`): the six above and `tool.after`, whose `context` output (plugin
 * API 1.5.0) the tool wrapper feeds to the model.
 */
export const LISTED_CODE_HOOKS: readonly HookName[] = [...Object.values(CODE_HOOK_EVENTS), 'tool.after']

const LISTED: ReadonlySet<string> = new Set(LISTED_CODE_HOOKS)

/** True for a code hook event `GET /hooks` lists. */
export function isListedCodeHook(name: string): boolean {
  return LISTED.has(name)
}

/** The code hook event of a command hook event, or null. */
export function codeHookOf(event: HookEvent): CodeHookName | null {
  return (CODE_HOOK_EVENTS as Partial<Record<HookEvent, CodeHookName>>)[event] ?? null
}

/** The plugins (in call order, once each) with a handler of `name`; `isActive` filters the owners. */
export function codeHookPlugins(registry: Pick<Registry, 'hooks'>, name: HookName, isActive: (pluginId: string) => boolean): string[] {
  const ids: string[] = []
  for (const hook of registry.hooks.list(name)) {
    if (!ids.includes(hook.pluginId) && isActive(hook.pluginId))
      ids.push(hook.pluginId)
  }
  return ids
}

/** A non-empty text of a handler's output field, capped; null otherwise. */
function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string')
    return null
  const trimmed = value.trim()
  if (trimmed === '')
    return null
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** The outcome of the code hooks of one event (`status: 'blocked'` for a block or a continuation). */
function codeOutcome(fields: { readonly block?: string | null, readonly context?: string | null }): HookOutcome {
  const block = fields.block ?? null
  return {
    status: block === null ? 'ok' : 'blocked',
    decision: null,
    reason: block,
    context: fields.context ?? null,
    continue: true,
    stopReason: null,
    systemMessage: null,
    suppressOutput: false,
    error: null,
    diagnostics: [],
  }
}

/** A text form of a sub-agent's report (`subagent.stop`). */
function reportText(output: unknown): string {
  if (typeof output === 'string')
    return output
  if (output === undefined || output === null)
    return ''
  try {
    return JSON.stringify(output) ?? ''
  }
  catch {
    return ''
  }
}

/** The `type` of a `task` call input (`subagent.stop`). */
function taskType(input: unknown): string {
  const type = typeof input === 'object' && input !== null ? (input as { type?: unknown }).type : undefined
  return typeof type === 'string' && type !== '' ? type : 'general'
}

/**
 * Runs the code hooks of `event` (every active plugin's handlers, through `registry.hooks.run`) and reads their output;
 * null when the event has no code hook event or (`Notification`) the notification type is not one code hooks know.
 */
export async function runCodeHooks(registry: Pick<Registry, 'hooks'>, event: HookEvent, scope: HookScope, input: HookRunInput): Promise<HookOutcome | null> {
  const base = { chatId: scope.chatId, modelRef: scope.modelRef }
  switch (event) {
    case 'UserPromptSubmit': {
      const output: { block?: string, context?: string } = {}
      await registry.hooks.run('prompt.submit', {
        ...base,
        prompt: input.prompt ?? '',
        projectId: scope.projectId,
        ...(input.command === undefined ? {} : { command: input.command }),
      }, output)
      return codeOutcome({ block: textOf(output.block, LIMITS.hookReasonMaxChars), context: textOf(output.context, LIMITS.hookContextMaxChars) })
    }
    case 'SessionStart': {
      const output: { context?: string } = {}
      await registry.hooks.run('session.start', { ...base, source: input.sessionSource === 'compact' ? 'compact' : 'startup', projectId: scope.projectId }, output)
      return codeOutcome({ context: textOf(output.context, LIMITS.hookContextMaxChars) })
    }
    case 'Stop': {
      const output: { continue?: string } = {}
      await registry.hooks.run('run.stop', { ...base, origin: scope.origin, hookActive: input.stopHookActive === true, projectId: scope.projectId }, output)
      return codeOutcome({ block: textOf(output.continue, LIMITS.hookReasonMaxChars) })
    }
    case 'SubagentStop': {
      const output: { continue?: string } = {}
      const task = input.tool
      await registry.hooks.run('subagent.stop', {
        ...base,
        type: taskType(task?.input),
        toolCallId: task?.callId ?? '',
        report: reportText(task?.output),
        hookActive: input.stopHookActive === true,
      }, output)
      return codeOutcome({ block: textOf(output.continue, LIMITS.hookReasonMaxChars) })
    }
    case 'PreCompact':
      await registry.hooks.run('compact.before', { ...base, trigger: input.trigger === 'manual' ? 'manual' : 'auto', focus: input.customInstructions ?? null }, undefined)
      return codeOutcome({})
    case 'Notification':
      if (input.notificationType !== 'permission_prompt')
        return null
      await registry.hooks.run('notification', { ...base, type: 'permission_prompt', message: input.message ?? '' }, undefined)
      return codeOutcome({})
    default:
      return null
  }
}
