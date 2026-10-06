// Claude model aliases (Phase 12, ADR-058; open point 9). Signature FROZEN after P12-0b (C44 stub); W12.7 implements it.
//
// `resolveClaudeModel(alias, context)` is the one resolver of the Claude model names a definition or a hook may name
// (`model: sonnet` in an agent, a command, a skill or a prompt hook; `modelAlias` of the parsed fields, normalized by the
// shared `claudeModelAlias`: `sonnet`, `opus`, `haiku`, `fable` or a full `claude-…` id). Its users: prompt hooks (W12.5,
// the handler's `model`), children (W12.6, an agent's `modelAlias`, plugin agents included) and commands and skills
// (W12.7, `model:` on `/name`). The order W12.7 implements: the setting `modelAliases` (the model ref of the alias) → for
// a full `claude-…` id, `anthropic:<id>` when it resolves → null, which means "the caller's existing fallback" (the
// chat's model, the default sub-agent model, the hook model) with the caller's notice or warning.
//
// The C44 stub answers null for every alias: every caller keeps its v1.7 behavior (a Claude model name runs on the
// fallback). Never throws; rejects only when `context.signal` aborts. Model names are logged at debug only.
import type { ModelAliases } from '@harness-forge/shared'
import type { ProviderService } from '../providers/types.ts'

/** What `resolveClaudeModel` reads. */
export interface ClaudeModelContext {
  /** The setting `modelAliases` (`Settings.modelAliases`): the model ref of each alias, or null (= the fallback). */
  readonly modelAliases: Readonly<ModelAliases> | null | undefined
  /** The providers (`deps.providers`): a full `claude-…` id runs as `anthropic:<id>` only when that model resolves. */
  readonly providers: Pick<ProviderService, 'resolveModel'>
  /** Aborts a resolution in flight (the run's signal). */
  readonly signal?: AbortSignal
}

/**
 * The model ref a Claude model name runs on (see the module comment), or null for the caller's existing fallback. The
 * C44 stub answers null (after honoring an aborted `signal`).
 */
export async function resolveClaudeModel(_alias: string, context: ClaudeModelContext): Promise<string | null> {
  context.signal?.throwIfAborted()
  return null
}
