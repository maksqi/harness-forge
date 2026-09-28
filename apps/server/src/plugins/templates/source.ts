// Source-code helpers of the code plugin templates (W3.4-T1): the entry header, the default export wrapper for `.mjs`
// (JSDoc-typed object) and `.ts` (`definePlugin`), and safe literals. Templates only embed user input (the plugin name)
// through `jsString()`; comments never contain it unescaped.

/** Language of a scaffolded entry: `js` -> `index.mjs` with JSDoc types, `ts` -> `index.ts` compiled by the host. */
export type TemplateLanguage = 'js' | 'ts'

/** File name of the vendored plugin API types (editor support only; the host ignores the file). */
export const SDK_TYPES_FILE = 'harness-forge.d.ts'

/** The entry file name of a language. */
export function entryFileName(language: TemplateLanguage): string {
  return language === 'ts' ? 'index.ts' : 'index.mjs'
}

/** A single-quoted JavaScript string literal (escapes quotes, backslashes, control and line separator characters). */
export function jsString(value: string): string {
  let out = '\''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\')
      out += '\\\\'
    else if (char === '\'')
      out += '\\\''
    else if (char === '\n')
      out += '\\n'
    else if (char === '\r')
      out += '\\r'
    else if (char === '\t')
      out += '\\t'
    else if (code < 0x20 || code === 0x7F || code === 0x2028 || code === 0x2029)
      out += `\\u${code.toString(16).padStart(4, '0')}`
    else
      out += char
  }
  return `${out}'`
}

/** Text safe inside a `//` comment: one line, no control characters. */
export function commentText(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is replaced
  return value.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ').trim()
}

/** Joins lines with `\n` and ends the file with a newline. */
export function sourceFile(lines: readonly string[]): string {
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

export interface EntryHeaderOptions {
  language: TemplateLanguage
  /** Comment lines under the directives (without `// `). */
  comments: readonly string[]
  /** `import type { ... }` names of a `.ts` entry (besides `definePlugin`). */
  typeImports?: readonly string[]
}

/**
 * First lines of an entry: `// @ts-check` (JavaScript), the reference to the vendored types, the comments and, for
 * TypeScript, the SDK imports (`definePlugin` is aliased to the host shim at build time).
 */
export function entryHeader(options: EntryHeaderOptions): string[] {
  const lines: string[] = []
  if (options.language === 'js')
    lines.push('// @ts-check')
  lines.push(`/// <reference path="./${SDK_TYPES_FILE}" />`)
  for (const comment of options.comments)
    lines.push(comment === '' ? '//' : `// ${comment}`)
  if (options.language === 'ts') {
    lines.push('')
    const types = [...(options.typeImports ?? [])].sort()
    if (types.length > 0)
      lines.push(`import type { ${types.join(', ')} } from '@harness-forge/plugin-sdk'`)
    lines.push('import { definePlugin } from \'@harness-forge/plugin-sdk\'')
  }
  return lines
}

/** Opening line(s) of the default export. */
export function moduleOpen(language: TemplateLanguage): string[] {
  return language === 'ts'
    ? ['export default definePlugin({']
    : ['/** @type {import(\'@harness-forge/plugin-sdk\').PluginModule} */', 'export default {']
}

/** Closing line of the default export. */
export function moduleClose(language: TemplateLanguage): string {
  return language === 'ts' ? '})' : '}'
}

/** A JSDoc (`.mjs`) or annotation (`.ts`) type for a variable declaration: `let x` + type. */
export function typedLet(language: TemplateLanguage, name: string, jsType: string, tsType: string, initial: string): string[] {
  return language === 'ts'
    ? [`let ${name}: ${tsType} = ${initial}`]
    : [`/** @type {${jsType}} */`, `let ${name} = ${initial}`]
}
