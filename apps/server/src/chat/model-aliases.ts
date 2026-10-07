// Claude model aliases (Phase 12, ADR-058; open point 9). Signature FROZEN after P12-0b (C44 stub); W12.7 implements it.
//
// `resolveClaudeModel(alias, context)` is the one resolver of the Claude model names a definition or a hook may name
// (`model: sonnet` in an agent, a command, a skill or a prompt hook; `modelAlias` of the parsed fields, normalized by the
// shared `claudeModelAlias`: `sonnet`, `opus`, `haiku`, `fable` or a full `claude-…` id). Its users: prompt hooks (W12.5,
// the handler's `model`), children (W12.6, an agent's `modelAlias`, plugin agents included) and commands and skills
// (W12.7, `model:` on `/name`). The order:
//   1. the name is normalized again with `claudeModelAlias` (lowercased, `[1m]` dropped, `opusplan` read as `opus`); a
//      name that is no Claude model name answers null;
//   2. the setting `modelAliases`: the model ref the user picked for `sonnet` / `opus` / `haiku` / `fable` (returned as
//      it is: the caller resolves it and falls back with its notice when it cannot run);
//   3. a full `claude-…` id: `anthropic:<id>` when that model resolves (`providers.resolveModel`: the Anthropic provider
//      is configured and knows the model);
//   4. null, which means "the caller's existing fallback" (the chat's model, the default sub-agent model, the hook model)
//      with the caller's notice or warning.
// Never throws; rejects only when `context.signal` aborts. Model names are logged at debug only (by the callers).
import type { ModelAliases } from '@harness-forge/shared'
import type { ProviderService } from '../providers/types.ts'
import { claudeModelAlias, safeParseModelRef } from '@harness-forge/shared'

/** What `resolveClaudeModel` reads. */
export interface ClaudeModelContext {
  /** The setting `modelAliases` (`Settings.modelAliases`): the model ref of each alias, or null (= the fallback). */
  readonly modelAliases: Readonly<ModelAliases> | null | undefined
  /** The providers (`deps.providers`): a full `claude-…` id runs as `anthropic:<id>` only when that model resolves. */
  readonly providers: Pick<ProviderService, 'resolveModel'>
  /** Aborts a resolution in flight (the run's signal). */
  readonly signal?: AbortSignal
}

/** The provider a full Claude model id runs on. */
export const CLAUDE_MODEL_PROVIDER_ID = 'anthropic'

/** The short Claude model names of the `modelAliases` setting. */
const SHORT_ALIASES: ReadonlySet<string> = new Set(['sonnet', 'opus', 'haiku', 'fable'])

/** The model ref the setting `modelAliases` names for a short alias, or null. */
function settingRef(aliases: Readonly<ModelAliases> | null | undefined, alias: string): string | null {
  if (typeof aliases !== 'object' || aliases === null || !SHORT_ALIASES.has(alias) || !Object.hasOwn(aliases, alias))
    return null
  const value = (aliases as Readonly<Record<string, unknown>>)[alias]
  return typeof value === 'string' && safeParseModelRef(value) !== null ? value : null
}

/**
 * The model ref a Claude model name runs on (see the module comment), or null for the caller's existing fallback.
 * Rejects only with the abort of `context.signal`.
 */
export async function resolveClaudeModel(alias: string, context: ClaudeModelContext): Promise<string | null> {
  context.signal?.throwIfAborted()
  const name = typeof alias === 'string' ? claudeModelAlias(alias) : null
  if (name === null)
    return null
  const configured = settingRef(context.modelAliases, name)
  if (configured !== null)
    return configured
  if (!name.startsWith('claude-'))
    return null
  const modelRef = `${CLAUDE_MODEL_PROVIDER_ID}:${name}`
  if (safeParseModelRef(modelRef) === null)
    return null
  try {
    const resolved = await context.providers.resolveModel(modelRef, context.signal === undefined ? {} : { signal: context.signal })
    context.signal?.throwIfAborted()
    return resolved.entry.kind === 'chat' ? modelRef : null
  }
  catch (error) {
    if (context.signal?.aborted === true)
      throw error
    return null
  }
}
