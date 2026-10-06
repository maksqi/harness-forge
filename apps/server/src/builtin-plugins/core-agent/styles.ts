// The builtin output styles of the catalog (Phase 11, ADR-051; open point 5 of the phase doc): `default`,
// `explanatory` and `learning`, the `source: 'builtin'` style entries of `GET /customizations?kind=style` (listed by
// `services/customizations/builtins.ts`, W11.6), always active, lowest precedence, in menu order. Their names are
// reserved (`BUILTIN_OUTPUT_STYLE_NAMES`: a definition or a plugin style with one of them is refused). The texts come
// from `BUILTIN_OUTPUT_STYLES` of `@harness-forge/shared` (the web shows the same labels and descriptions); this module
// adapts them to the shape of a parsed style file (`StyleDefinitionFields`), like `agents.ts` does for the builtin
// agent types. `default` has an empty body: it adds no instruction block (`outputStyleBlock` returns null).
//
// P11-0b (C38): FROZEN after Gate P11-0b with the `core-agent` manifest. These styles are not registered through
// `ctx.outputStyles` (the builtin names are reserved there); `core-agent` keeps `engines.harness` `^1.4.0`.
import type { BuiltinOutputStyleName, StyleDefinitionFields } from '@harness-forge/shared'
import { BUILTIN_OUTPUT_STYLES } from '@harness-forge/shared'

/** One builtin output style, in the fields of a parsed style file. */
export interface BuiltinStyleDefinition extends StyleDefinitionFields {
  /** The style name (`chats.settings.outputStyle`, `projects.output_style`, the setting `outputStyle`). */
  readonly name: BuiltinOutputStyleName
}

/** The builtin styles in menu order (`BUILTIN_OUTPUT_STYLE_NAMES`): frozen copies of the shared texts. */
export const BUILTIN_STYLE_DEFINITIONS: readonly BuiltinStyleDefinition[] = Object.freeze(BUILTIN_OUTPUT_STYLES.map(style => Object.freeze({
  name: style.name,
  label: style.label,
  description: style.description,
  keepCodingInstructions: style.keepCodingInstructions,
  content: style.content,
} satisfies BuiltinStyleDefinition)))

/** The builtin style named `name` (exact, case-sensitive), or null. */
export function builtinStyleDefinition(name: string): BuiltinStyleDefinition | null {
  return BUILTIN_STYLE_DEFINITIONS.find(definition => definition.name === name) ?? null
}
