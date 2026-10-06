// The output style of a run (Phase 11, ADR-051, ARCHITECTURE.md 6.31). Signatures FROZEN after P11-0b (C37 stub); the
// implementation is W11.6's.
//
// `resolveRunOutputStyle(input)` runs once while a chat-model run is prepared (`prepare.ts`) and gives
// `PreparedRun.outputStyle`, which `modelStream` hands to `buildRunParams` (`RunParamsInput.outputStyle`, `params.ts`):
// - the name: the chat's choice (`chat.settings.outputStyle`) ?? the project's (`projects.output_style`, read through
//   `deps.projects`) ?? the global setting `outputStyle` (`effectiveStyleName`, SH `util/output-styles.ts`);
// - the style: the run catalog's active entry of kind `style` (builtins `default` / `explanatory` / `learning`, personal
//   rows, `.harness` / `.claude` `output-styles` files, plugin styles), its body loaded again (`customizations.load`);
//   an unknown, inactive or unreadable style falls back to `default` with the notice `output-style-unavailable` (once
//   per chat and model, `alreadyNoticed`);
// - `default` adds nothing to the instructions; any other style's block (`outputStyleBlock`: `Output style: <label>`
//   and the body) goes first, and `keepCodingInstructions: false` drops the workspace tool rules and the todo / task
//   hints (`agentBlocks(…, { codingHints })`). Sub-agents never get a style.
// W11.6 implementation: the builtins (`default`, `explanatory`, `learning`: reserved names, always active, nothing
// shadows them) come straight from `core-agent/styles.ts`; any other name must be the catalog's active style entry and
// its body is read again through `customizations.load` (a personal row, a project file through the discovery guards, a
// plugin registration). The project's choice is read from the project row (`deps.projects.get`), so it applies even
// while the folder is unavailable; a missing project or a failed read counts as "no choice". Style bodies are never
// logged (names, sources and codes at debug only).
import type { CustomizationEntry, HarnessUIMessage, NoticeData, Settings } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { ChatRecord } from '../services/chats/types.ts'
import type { CustomizationCatalog } from '../services/customizations/types.ts'
import type { AppDeps } from '../types.ts'
import { BUILTIN_OUTPUT_STYLES, DEFAULT_OUTPUT_STYLE, effectiveStyleName, isHarnessError } from '@harness-forge/shared'
import { builtinStyleDefinition } from '../builtin-plugins/core-agent/styles.ts'
import { isAbortError } from './errors.ts'
import { NOTICES } from './notices.ts'
import { alreadyNoticed } from './pipeline.ts'

/** The output style a run uses (`PreparedRun.outputStyle`). */
export interface RunOutputStyle {
  /** The effective style name (`default` when the chosen style is unknown or inactive). */
  readonly name: string
  /** The display label (`Output style: <label>`). */
  readonly label: string
  /** The instruction body; empty for `default` (no block). */
  readonly content: string
  /** false drops the workspace tool rules and the todo / task hints from the instructions. */
  readonly keepCodingInstructions: boolean
}

/** What `resolveRunOutputStyle` reads. */
export interface OutputStyleInput {
  readonly deps: Pick<AppDeps, 'projects' | 'customizations'>
  /** The run's catalog snapshot (its `style` entries). */
  readonly catalog: CustomizationCatalog
  /** The chat (its `settings.outputStyle` and project). */
  readonly chat: ChatRecord
  /** The global settings (`outputStyle`). */
  readonly settings: Settings
  /** The path the run continues (the notice is shown once per chat and model). */
  readonly history: readonly HarnessUIMessage[]
  /** The model that runs the turn (`alreadyNoticed`). */
  readonly modelRef: string
  readonly signal: AbortSignal
  readonly logger: Logger
}

/** The style of a run and the notices it adds (`output-style-unavailable`). */
export interface ResolvedOutputStyle {
  readonly style: RunOutputStyle
  readonly notices: NoticeData[]
}

/** The builtin `default` style: no instruction block, the coding instructions kept. */
export const DEFAULT_RUN_OUTPUT_STYLE: RunOutputStyle = Object.freeze((() => {
  const builtin = BUILTIN_OUTPUT_STYLES.find(style => style.name === DEFAULT_OUTPUT_STYLE)
  return {
    name: DEFAULT_OUTPUT_STYLE,
    label: builtin?.label ?? 'Default',
    content: '',
    keepCodingInstructions: true,
  }
})())

/** Characters of a style name quoted in the notice (the names are validated, this only bounds the text). */
const NOTICE_NAME_MAX_CHARS = 64

/** A chosen name as text, or null (anything else counts as unset). */
function choice(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * The project's style (`projects.output_style`, from the row through `deps.projects.get`), or null: no project, no
 * choice, the project gone or the read failed (logged; the run goes on with the global setting).
 */
async function projectChoice(input: OutputStyleInput): Promise<string | null> {
  const projectId = input.chat?.projectId ?? null
  if (projectId === null)
    return null
  try {
    return choice((await input.deps.projects.get(projectId)).outputStyle)
  }
  catch (error) {
    if (!isHarnessError(error) || error.code !== 'not_found')
      input.logger.warn('output style: project not read', { projectId, err: error })
    return null
  }
}

/** A builtin style as the run uses it, or null for another name. */
export function builtinRunOutputStyle(name: string): RunOutputStyle | null {
  if (name === DEFAULT_OUTPUT_STYLE)
    return DEFAULT_RUN_OUTPUT_STYLE
  const builtin = builtinStyleDefinition(name)
  if (builtin === null)
    return null
  return Object.freeze({ name: builtin.name, label: builtin.label, content: builtin.content, keepCodingInstructions: builtin.keepCodingInstructions })
}

/**
 * The catalog style `name` with its body read again (`customizations.load`), or null when the catalog has no active
 * style of that name or its body cannot be used any more (gone, renamed, invalid). An abort of `signal` rejects.
 */
async function catalogStyle(input: OutputStyleInput, name: string): Promise<RunOutputStyle | null> {
  const entry: CustomizationEntry | null = input.catalog.style(name)
  if (entry === null) {
    input.logger.debug('output style not available', { name })
    return null
  }
  let loaded
  try {
    loaded = await input.deps.customizations.load(entry, input.signal)
  }
  catch (error) {
    if (input.signal.aborted && isAbortError(error))
      throw error
    input.signal.throwIfAborted()
    input.logger.debug('output style not loaded', { name, source: entry.source, code: isHarnessError(error) ? error.code : undefined })
    return null
  }
  input.signal.throwIfAborted()
  const definition = loaded.definition
  if (definition.kind !== 'style' || definition.fields.name !== entry.name)
    return null
  const fields = definition.fields
  const label = [fields.label, entry.label, entry.name].find(text => typeof text === 'string' && text.trim() !== '') ?? entry.name
  input.logger.debug('output style loaded', { name, source: entry.source })
  return {
    name: entry.name,
    label,
    content: typeof fields.content === 'string' ? fields.content : '',
    keepCodingInstructions: fields.keepCodingInstructions === true,
  }
}

/**
 * The output style of a chat-model run (see the module comment). Never rejects but for an abort of `input.signal`: an
 * unknown, inactive or unreadable style gives `default` and the notice `output-style-unavailable`, unless an earlier
 * reply of the same model on this path already shows it (`alreadyNoticed`).
 */
export async function resolveRunOutputStyle(input: OutputStyleInput): Promise<ResolvedOutputStyle> {
  input.signal.throwIfAborted()
  const chatChoice = choice(input.chat?.settings?.outputStyle)
  // The project row is read only when the chat has no choice of its own.
  const project = chatChoice !== null && chatChoice.trim() !== '' ? null : await projectChoice(input)
  input.signal.throwIfAborted()
  const name = effectiveStyleName(chatChoice, project, choice(input.settings?.outputStyle))
  const style = builtinRunOutputStyle(name) ?? await catalogStyle(input, name)
  if (style !== null)
    return { style, notices: [] }
  const notice = NOTICES.outputStyleUnavailable(name.length > NOTICE_NAME_MAX_CHARS ? `${name.slice(0, NOTICE_NAME_MAX_CHARS)}…` : name)
  return { style: DEFAULT_RUN_OUTPUT_STYLE, notices: alreadyNoticed(input.history, notice, input.modelRef) ? [] : [notice] }
}
