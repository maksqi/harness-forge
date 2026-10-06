// The host of a sub-agent (Phase 10, C31-T5; ADR-043, ADR-046, ARCHITECTURE.md 6.22 / 6.26). COMPLETE and FROZEN after
// P10-0b; Phase 11 (C37, ADR-048) adds the hooks handle; FROZEN again after P11-0b.
//
// A child (`subagent/{index,tools}.ts`) and the context guard and summarizer it runs (`compaction/{guard,summarize}.ts`)
// read their host only through the structural `ChildSession`, never through the pipeline's `RunSession`:
// - a foreground child's host is its parent run's `RunSession` (`pipeline.ts`), which satisfies `ChildSession` as it is
//   (the usage rows and the extra cost go to the parent reply, the run signal stops the child);
// - a background child's host is the detached session `createDetachedSession` builds for its task (W10.4 builds it from
//   the `BackgroundLaunchInput`, W10.3's `runDetachedChild` runs the child on it): the task's own signal (its Stop, the
//   deadline) is the "run signal", the launching assistant message keeps the usage rows, and the child's extra cost goes
//   to `onExtraCost` (the task output's `costUsd`), never into a reply that is already saved.
// `ChildSession` has no `inject` / `writeTransient`: a child never adds chunks to a transcript. The context guard of a chat
// run places its marker, notices and activity through a `HostSession` (a `ChildSession` that also places step-boundary
// chunks, `RunSession`); a silent guard (a child's) needs only a `ChildSession`. The run scope a child writes with is not
// part of the session: the runner gets the parent's scope and copies it for the child (`childRunScope`,
// `subagent/tools.ts`), so the child's journal rows stay under the launching message.
// Phase 11 (ADR-048): `ChildSession.hooks` is the hooks handle of the host (`ChildHooksSource`, `chat/hooks.ts`): a
// foreground child's is its parent run's `RunHooks` (`RunSession.hooks`, over the run's one snapshot), a background
// child's the `detachedHooks(…)` its task builds from a snapshot of its own (`DetachedSessionInput.hooks`, W11.2). A child
// takes `hooks.forChild(<parent task call id>/)`: `PreToolUse` (an `ask` is denied, never a card), `PostToolUse` (the
// model text goes into the child's own composer) and `SubagentStop` (W11.2); never `UserPromptSubmit`, `SessionStart` or
// `Stop`, and nothing of a child's hooks is stored. Absent or null = no hooks (every v1.6 host). It lives on the host,
// never on the `ToolCallContext`, so no plugin can reach it.
// Phase 12 (C44, ADR-057 / ADR-058; COMPLETE and FROZEN after P12-0b):
// - `SubagentStart`: before a child's step 0 (foreground and background) the runner calls
//   `ChildHooks.subagentStart({ id: <parent task call id>, type: <agent type> }, signal)` (`hooks.ts`; matched on the
//   agent type and its Claude Code names); the context it answers goes into the child's first user message
//   (`childFirstMessage`: a `<hook-context event="SubagentStart">` text part after the prompt), and the child's later
//   events carry the agent (`agent_id` / `agent_type`). Without hooks the first message is the prompt alone (v1.7).
// - The child spec (`ChildAgentSpec`): what an agent definition adds to its child (`maxTurns` → the child's step limit
//   `childMaxSteps`, the preloaded `skills` text → the child's instructions, `disallowedTools` → removed from its tools
//   before the definition's `tools`). W12.6 computes it from the definition; `DEFAULT_CHILD_SPEC` keeps the v1.7 child.
// - `HostHooks.postCompact`: `PostCompact` right after the context guard's automatic compaction marker.
import type { HarnessUIMessage, ReasoningEffort, Settings } from '@harness-forge/shared'
import type { ModelMessage } from 'ai'
import type { Logger } from '../../logger.ts'
import type { ChatRecord } from '../../services/chats/types.ts'
import type { HookEventResult } from '../../services/hooks/types.ts'
import type { AppDeps } from '../../types.ts'
import type { ChildHooksSource, PostCompactInput, PreCompactInput } from '../hooks.ts'
import type { HarnessDataChunk } from '../pipeline.ts'
import { hookModelText, LIMITS } from '@harness-forge/shared'

/** What a child reads of the run it belongs to (`RunContext.prepared` of a chat run fits). */
export interface ChildHostRun {
  /**
   * The settings of the run (a child reads `subagentModelRef`, `subagentMaxSteps`, `instructions`; its context guard
   * `autoCompact`; its summarizer `compactModelRef`).
   */
  readonly settings: Settings
  /** The chat (its own `instructions`). */
  readonly chat: { readonly settings: Pick<ChatRecord['settings'], 'instructions'> }
  /** The path the run started from (the guard's todo snapshot and marker count; `[]` for a detached child). */
  readonly history: readonly HarnessUIMessage[]
  /** The continued message of an approval continuation, else null (always null for a detached child). */
  readonly continued: HarnessUIMessage | null
}

/** The context of a child's host (`RunContext` of a chat run fits). */
export interface ChildHostContext {
  /** The services (providers, usage rows, registry, plugins, tool prefs, MCP, `env.workspaceShell`, the redactor). */
  readonly deps: AppDeps
  readonly prepared: ChildHostRun
  /** The host's signal: the parent run's (a foreground child), or the task's own (a background child). */
  readonly run: { readonly signal: AbortSignal }
  /** The reasoning effort of the run (the child's provider reasoning options). */
  readonly reasoningEffort: ReasoningEffort
  readonly logger: Logger
  /** The clock (epoch ms). */
  readonly now: () => number
}

/** What a child needs from its host (see the module comment). `RunSession` satisfies it structurally. */
export interface ChildSession {
  readonly ctx: ChildHostContext
  readonly chatId: string
  /** The assistant message the child belongs to (the reply, or the launching message of a background task). */
  readonly assistantId: string
  /** Adds an estimated extra cost (a child's or its summarizer's); ignores values that are not finite and positive. */
  readonly addExtraCost: (usd: number) => void
  /**
   * The hooks of the host (Phase 11, see the module comment): `forChild(prefix)` gives one child its hooks. Absent or
   * null = the child runs no hook.
   */
  readonly hooks?: ChildHooksSource | null
}

/**
 * The hooks of a chat run's host (Phase 11, `RunHooks`): the children's handle plus `PreCompact` for the context guard's
 * automatic compaction (W11.2) and (Phase 12) `PostCompact` after it.
 */
export interface HostHooks extends ChildHooksSource {
  /** Runs `PreCompact` (observe only; the record is placed next to the compaction marker); rejects only on abort. */
  readonly preCompact: (input: PreCompactInput, signal: AbortSignal) => Promise<HookEventResult>
  /** Phase 12: runs `PostCompact` (observe only; the record is placed after the compaction marker); rejects only on abort. */
  readonly postCompact: (input: PostCompactInput, signal: AbortSignal) => Promise<HookEventResult>
}

/**
 * What an agent definition adds to its child (Phase 12, ADR-058; see the module comment). W12.6 computes it from the
 * loaded definition (`maxTurns`, `skills` through `customizations.load`, `disallowedTools`); null fields change nothing.
 */
export interface ChildAgentSpec {
  /** `maxTurns` (1 … `LIMITS.agentMaxTurnsMax`): the child's steps are `min(subagentMaxSteps, maxTurns)`; null = none. */
  readonly maxTurns: number | null
  /**
   * The preloaded `skills` bodies (≤ `LIMITS.agentSkillsPreloadMax` skills, ≤ `LIMITS.agentSkillsPreloadBytes`), added
   * to the child's instructions after the agent's body; null = none.
   */
  readonly skillsText: string | null
  /**
   * `disallowedTools` (harness tool names, `mcp__server__*` prefixes): removed from the child's tools before the
   * definition's `tools` narrows them (restrict-only); null = none.
   */
  readonly disallowedTools: readonly string[] | null
}

/** The spec of a child whose definition adds nothing (every builtin, every v1.7 agent). */
export const DEFAULT_CHILD_SPEC: ChildAgentSpec = Object.freeze({ maxTurns: null, skillsText: null, disallowedTools: null })

/**
 * The step limit of a child (Phase 12): `subagentMaxSteps`, lowered to the spec's `maxTurns` when that is a whole
 * number from 1 to `LIMITS.agentMaxTurnsMax` (anything else is ignored); at least 1.
 */
export function childMaxSteps(subagentMaxSteps: number, spec: Pick<ChildAgentSpec, 'maxTurns'>): number {
  const base = Math.max(1, Math.floor(subagentMaxSteps))
  const turns = spec.maxTurns
  if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1 || turns > LIMITS.agentMaxTurnsMax)
    return base
  return Math.min(base, turns)
}

/**
 * The child's first user message (Phase 12): the task prompt, then the `SubagentStart` context as a second text part
 * (`<hook-context event="SubagentStart">`, `hookModelText`); the prompt alone without a context (the v1.7 message).
 */
export function childFirstMessage(prompt: string, startContext: string | null): ModelMessage {
  const context = typeof startContext === 'string' ? startContext.trim() : ''
  const text = context === '' ? null : hookModelText({ event: 'SubagentStart', outcome: 'context', context }, 'user')
  return {
    role: 'user',
    content: [{ type: 'text', text: prompt }, ...(text === null ? [] : [{ type: 'text' as const, text }])],
  }
}

/** A host that also places step-boundary and transient chunks (a chat run: `RunSession`); the non-silent context guard. */
export interface HostSession extends ChildSession {
  /** The run's hooks (Phase 11): `RunSession.hooks`; absent or null = none. */
  readonly hooks?: HostHooks | null
  /** Queues a chunk for the transcript right before the `start-step` of `stepNumber` (`RunSession.inject`). */
  readonly inject: (chunk: HarnessDataChunk, stepNumber: number) => void
  /** Writes a transient chunk (`data-activity`) at once (`RunSession.writeTransient`). */
  readonly writeTransient: (chunk: HarnessDataChunk) => void
}

/** What `createDetachedSession` needs (the pieces of a `BackgroundLaunchInput` plus the task's signal). */
export interface DetachedSessionInput {
  readonly deps: AppDeps
  readonly chatId: string
  /** The launching assistant message (`BackgroundLaunchInput.messageId`): the message of the child's usage rows. */
  readonly messageId: string
  /** The settings of the launching run. */
  readonly settings: Settings
  /** The chat's own instructions, if any. */
  readonly chatInstructions: string | undefined
  readonly reasoningEffort: ReasoningEffort
  /** The task's own signal (its Stop, the deadline, shutdown): the child's run signal. */
  readonly signal: AbortSignal
  readonly logger: Logger
  /** The clock; default `Date.now`. */
  readonly now?: () => number
  /** Receives the child's extra costs (finite and positive only); default: dropped. */
  readonly onExtraCost?: (usd: number) => void
  /**
   * The hooks of the task (Phase 11, `detachedHooks(…)` over a snapshot of the launching chat's scope, W11.2); absent or
   * null = the child runs no hook.
   */
  readonly hooks?: ChildHooksSource | null
}

/**
 * The host of a background child (see the module comment): no history, no continuation, the task's signal; extra costs
 * go to `onExtraCost`; the hooks are `input.hooks` (null when absent). The returned session and its context are frozen.
 */
export function createDetachedSession(input: DetachedSessionInput): ChildSession {
  const ctx: ChildHostContext = Object.freeze({
    deps: input.deps,
    prepared: Object.freeze({
      settings: input.settings,
      chat: Object.freeze({ settings: Object.freeze(input.chatInstructions === undefined ? {} : { instructions: input.chatInstructions }) }),
      history: Object.freeze([]) as readonly HarnessUIMessage[],
      continued: null,
    }),
    run: Object.freeze({ signal: input.signal }),
    reasoningEffort: input.reasoningEffort,
    logger: input.logger,
    now: input.now ?? Date.now,
  })
  const onExtraCost = input.onExtraCost
  return Object.freeze({
    ctx,
    chatId: input.chatId,
    assistantId: input.messageId,
    addExtraCost: (usd: number): void => {
      if (onExtraCost !== undefined && Number.isFinite(usd) && usd > 0)
        onExtraCost(usd)
    },
    hooks: input.hooks ?? null,
  })
}
