// Skills (Phase 10, ADR-045; ARCHITECTURE.md 6.25, API.md 4.25). Signature FROZEN after P10-0b (C31 stub); W10.5
// implements it.
//
// `loadSkill(context, name, signal)` is what the run binds as `AgentRunScope.loadSkill` (`pipeline.ts`), for
// `core-agent`'s `skill` tool: the active skill `name` of the run's catalog snapshot (`context.catalog.skill(name)`),
// its body read and validated again (`deps.customizations.load(entry, signal)`), as a `SkillOutput` (`content` at most
// `LIMITS.customizationContentBytes`, `truncated`); a project skill also gets its folder (`baseDir`, project-relative)
// and its supporting files (`files`, relative to `baseDir`: `walkWorkspace` from the skill folder, depth 3, at most
// `LIMITS.skillFilesListedMax`, no links, no hidden or secret-looking names). An unknown, disabled or unreadable skill
// rejects with a `HarnessError` whose message lists the available skills (the tool error the model reads). Skill bodies
// are never logged at info.
//
// P10-0b stub: every call rejects with `not_found` ("Skills are not available yet."); the `skill` tool is offered only
// when the catalog has skills, and the C30 catalog has none before W10.1.
import type { SkillOutput } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { CustomizationCatalog } from '../services/customizations/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { AppDeps } from '../types.ts'
import { HarnessError } from '@harness-forge/shared'

/** The error of the P10-0b stub. */
export const SKILLS_UNAVAILABLE_TEXT = 'Skills are not available yet.'

/** What `loadSkill` reads (bound once per run by the pipeline). */
export interface SkillLoadContext {
  /** The services (`customizations.load`, the redactor). */
  readonly deps: AppDeps
  /** The run's catalog snapshot (`PreparedRun.catalog`). */
  readonly catalog: CustomizationCatalog
  /** The run's open project folder (the root of a project skill's folder), or null. */
  readonly workspace: OpenWorkspace | null
  readonly logger: Logger
}

/** Loads one skill of the run's catalog (see the module comment). */
export async function loadSkill(context: SkillLoadContext, name: string, signal: AbortSignal): Promise<SkillOutput> {
  void context
  signal.throwIfAborted()
  throw new HarnessError({ code: 'not_found', message: SKILLS_UNAVAILABLE_TEXT, details: { name } })
}
