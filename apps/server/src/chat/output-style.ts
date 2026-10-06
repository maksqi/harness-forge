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
// C37 stub (P11-0b): always the builtin `default` (nothing changes in the instructions), no notice.
import type { HarnessUIMessage, NoticeData, Settings } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { ChatRecord } from '../services/chats/types.ts'
import type { CustomizationCatalog } from '../services/customizations/types.ts'
import type { AppDeps } from '../types.ts'
import { BUILTIN_OUTPUT_STYLES, DEFAULT_OUTPUT_STYLE } from '@harness-forge/shared'

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

/**
 * The output style of a chat-model run (see the module comment). Never rejects but for an abort of `input.signal`.
 * C37 stub: always `DEFAULT_RUN_OUTPUT_STYLE`, no notice.
 */
export async function resolveRunOutputStyle(input: OutputStyleInput): Promise<ResolvedOutputStyle> {
  input.signal.throwIfAborted()
  return { style: DEFAULT_RUN_OUTPUT_STYLE, notices: [] }
}
