/**
 * Output styles (Phase 11, ADR-051): the builtin styles and the selection rule. A style is a catalog definition of kind
 * `style` (markdown with `name`, `description`, `keep-coding-instructions`); the effective style of a run is the chat's
 * choice, else the project's, else the global setting `outputStyle`; its block goes first in the main agent's
 * instructions (never in sub-agents'). `default` adds nothing. Pure and isomorphic; never throws.
 * Contract skeleton written by the coordinator in P11-0a (K1); implemented by C35 (the builtin texts included).
 */

export const DEFAULT_OUTPUT_STYLE = 'default'

/** Builtin style names; reserved (a definition with one of these names is `reserved-name`). */
export const BUILTIN_OUTPUT_STYLE_NAMES = ['default', 'explanatory', 'learning'] as const
export type BuiltinOutputStyleName = (typeof BUILTIN_OUTPUT_STYLE_NAMES)[number]

export interface BuiltinOutputStyle {
  readonly name: BuiltinOutputStyleName
  readonly label: string
  readonly description: string
  /** The instructions block body; empty for `default`. */
  readonly content: string
  readonly keepCodingInstructions: boolean
}

/** The first line of a style's instruction block: `Output style: <label>`. */
export const OUTPUT_STYLE_HEADER = 'Output style: '

const EXPLANATORY_CONTENT = [
  'Besides doing the task, help the user understand the code and the choices you make along the way.',
  '',
  '- Before and after you write or change code, add a short note that starts with "Insight:" and gives two or three'
  + ' points: why you chose this approach, which trade-offs you weighed, or which pattern or convention of this codebase'
  + ' the change follows.',
  '- Prefer insights that are specific to this project over general programming facts. Keep each note brief; the notes'
  + ' support the work and never replace it.',
  '- When a part of the codebase matters for the task (how a module fits in, where the data flows, why something is'
  + ' done the way it is), explain it in a few sentences instead of assuming the user already knows it.',
  '',
  'Finish the task completely: the explanations are an addition, never a reason to do less.',
].join('\n')

const LEARNING_CONTENT = [
  'Teach the user while you work, and let them write meaningful parts of the code themselves.',
  '',
  '- Work through the task together. When a piece of the work involves a real decision (a design choice, business'
  + ' logic, error handling, a small algorithm of about five to ten lines), do not write it yourself: prepare the'
  + ' surrounding code, mark the exact place with a "TODO(human)" comment and ask the user to write it.',
  '- Ask in a clearly marked section that starts with "Learn by doing:" and says what to write, where (file and'
  + ' function), what it has to do and what to keep in mind. Ask for one piece at a time and wait for the user\'s'
  + ' answer before you continue.',
  '- Write boilerplate, repetitive and routine code yourself, so the user\'s effort goes into the parts that build'
  + ' understanding.',
  '- Add short notes that start with "Insight:" to explain the reasoning behind your choices and the conventions of'
  + ' this codebase.',
  '- Review what the user wrote kindly and concretely: say what works, point out problems and suggest improvements.',
].join('\n')

/** The builtin styles in menu order. */
export const BUILTIN_OUTPUT_STYLES: readonly BuiltinOutputStyle[] = [
  { name: 'default', label: 'Default', description: 'The agent\'s usual replies.', content: '', keepCodingInstructions: true },
  { name: 'explanatory', label: 'Explanatory', description: 'Explains its choices and the code it touches.', content: EXPLANATORY_CONTENT, keepCodingInstructions: true },
  { name: 'learning', label: 'Learning', description: 'Teaches as it works and asks you to write parts yourself.', content: LEARNING_CONTENT, keepCodingInstructions: true },
]

/** The label used when a style has an empty label. */
const FALLBACK_LABEL = 'Custom'

export function isBuiltinOutputStyle(name: string): name is BuiltinOutputStyleName {
  return typeof name === 'string' && (BUILTIN_OUTPUT_STYLE_NAMES as readonly string[]).includes(name)
}

function chosen(value: string | null | undefined): string | null {
  if (typeof value !== 'string')
    return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** chat ?? project ?? global ?? `default` (empty strings count as unset). */
export function effectiveStyleName(chat: string | null | undefined, project: string | null | undefined, global: string | null | undefined): string {
  return chosen(chat) ?? chosen(project) ?? chosen(global) ?? DEFAULT_OUTPUT_STYLE
}

/**
 * The instruction block of a style (`Output style: <label>`, a blank line, the body; leading and trailing blank space
 * removed), or null for an empty body. An empty label reads `Custom`.
 */
export function outputStyleBlock(style: { readonly label: string, readonly content: string }): string | null {
  if (typeof style !== 'object' || style === null)
    return null
  const content = typeof style.content === 'string' ? style.content.trim() : ''
  if (content === '')
    return null
  const label = typeof style.label === 'string' ? style.label.replace(/\s+/g, ' ').trim() : ''
  return `${OUTPUT_STYLE_HEADER}${label === '' ? FALLBACK_LABEL : label}\n\n${content}`
}
