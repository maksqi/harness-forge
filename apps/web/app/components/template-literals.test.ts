// @vitest-environment node
// Guard against vuejs/language-tools#6240: vue-tsc 3.3.12 rewrites every `//` in the generated props object of a
// component (`new Component({ ... })`) into a block comment, including `//` inside string literals. A URL in a
// component prop value (`placeholder="https://..."` or `:placeholder="'https://...'"`) then corrupts the generated
// code, and every later use of the surrounding `v-for` / `v-slot` variable loses its type. URLs belong in script
// constants. JavaScript comments inside bound values (for example in `:class="cn(...)"`) are fine.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appDir = fileURLToPath(new URL('..', import.meta.url))

function vueFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      out.push(...vueFiles(path))
    else if (entry.name.endsWith('.vue'))
      out.push(path)
  }
  return out
}

/** True when `//` appears inside a quoted or template string literal of a bound expression. */
function quotedSlashes(expression: string): boolean {
  let quote = ''
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]
    if (quote) {
      if (char === '\\')
        i++
      else if (char === quote)
        quote = ''
      else if (char === '/' && expression[i + 1] === '/')
        return true
    }
    else if (char === '\'' || char === '`') {
      quote = char
    }
  }
  return false
}

/** Attribute values of PascalCase (component) tags that put `//` into a string literal of the generated code. */
function slashedPropValues(source: string): string[] {
  const start = source.indexOf('<template')
  if (start < 0)
    return []
  const found: string[] = []
  const tags = /<([A-Z][\w.]*)\b([^>]*?)\/?>/g
  for (const tag of source.slice(start).matchAll(tags)) {
    const attrs = tag[2] ?? ''
    for (const attr of attrs.matchAll(/([:@#\w.-]+)="([^"]*)"/g)) {
      const name = attr[1] ?? ''
      const value = attr[2] ?? ''
      const bound = name.startsWith(':') || name.startsWith('v-bind') || name.startsWith('@') || name.startsWith('v-')
      const literal = bound ? quotedSlashes(value) : value.includes('//')
      if (literal)
        found.push(`<${tag[1]}> ${name}="${value}"`)
    }
  }
  return found
}

describe('component prop values', () => {
  it('flags string literals with // and ignores comments in bound expressions', () => {
    expect(slashedPropValues('<template><Input placeholder="https://a.example/x" /></template>')).toHaveLength(1)
    expect(slashedPropValues(`<template><Input :placeholder="x ? 'https://a' : 'b'" /></template>`)).toHaveLength(1)
    expect(slashedPropValues('<template><Input :placeholder="URL" /></template>')).toEqual([])
    expect(slashedPropValues(`<template><Box :class="cn(\n  'a',\n  // note\n  'b')" /></template>`)).toEqual([])
    expect(slashedPropValues('<template><input placeholder="https://a.example/x"></template>')).toEqual([])
  })

  it('keep URL literals out of component props in every .vue file', () => {
    const offenders = vueFiles(appDir).flatMap(file =>
      slashedPropValues(readFileSync(file, 'utf8')).map(hit => `${relative(appDir, file)}: ${hit}`))
    expect(offenders).toEqual([])
  })
})
