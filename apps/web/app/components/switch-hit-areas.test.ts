// @vitest-environment node
// Coarse-pointer hit areas of switches (docs/UI.md, touch targets of at least 40px): the shadcn `Switch` draws its hit
// area as an absolute `::after` (`after:-inset-y-2`) that counts from inside its 1px border, so every `<Switch>` in a
// .vue file carries `pointer-coarse:after:-inset-y-3` (default size: 16.4 + 2 * 12 = 40.4px) or, with `size="sm"`,
// `pointer-coarse:after:-inset-y-3.5` (12 + 2 * 14 = 40px). The class may be static (`class`), a string literal in
// `:class`, or an UPPER_CASE script constant named in `:class`.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appDir = fileURLToPath(new URL('..', import.meta.url))

const DEFAULT_CLASS = 'pointer-coarse:after:-inset-y-3'
const SMALL_CLASS = 'pointer-coarse:after:-inset-y-3.5'

/** The components of the v1.8.1 backlog item "a coarse-pointer hit area for the switches that have none". */
const COMPONENTS = [
  'components/settings/ProviderRow.vue',
  'components/settings/GeneralSettings.vue',
  'components/settings/AppearanceSettings.vue',
  'components/settings/ModelsTable.vue',
  'components/settings/data/DataImportSection.vue',
  'components/settings/data/DataExportSection.vue',
  'components/plugins/forms/SchemaField.vue',
  'components/plugins/wizard/WizardModelsStep.vue',
  'components/plugins/mcp/McpServersPanel.vue',
  'components/plugins/detail/PluginToolsTable.vue',
  'components/plugins/detail/PluginHeader.vue',
  'components/plugins/list/PluginCard.vue',
  'components/share/ShareOptionSwitches.vue',
]

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

/** The attribute text of every `<Switch ...>` tag (a `>` inside a quoted value, as in `=>`, does not end the tag). */
function switchTags(source: string): string[] {
  const start = source.indexOf('<template')
  if (start < 0)
    return []
  const template = source.slice(start)
  const tags: string[] = []
  for (const match of template.matchAll(/<Switch(?=[\s/>])/g)) {
    const from = match.index + match[0].length
    let quoted = false
    let end = from
    while (end < template.length && (quoted || template[end] !== '>')) {
      if (template[end] === '"')
        quoted = !quoted
      end++
    }
    tags.push(template.slice(from, end).replace(/\/$/, ''))
  }
  return tags
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const attr of tag.matchAll(/([:@#\w.-]+)(?:="([^"]*)")?/g))
    found.set(attr[1] ?? '', attr[2] ?? '')
  return found
}

/** `const NAME = '...'` string constants of the script. */
function stringConstants(source: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const constant of source.matchAll(/\bconst ([A-Z][A-Z0-9_]*) = '([^']*)'/g))
    found.set(constant[1] ?? '', constant[2] ?? '')
  return found
}

/** Class tokens of a tag: the static `class`, string literals in `:class` and the constants it names. */
function classTokens(attrs: Map<string, string>, constants: Map<string, string>): Set<string> {
  const parts = [attrs.get('class') ?? '']
  const bound = attrs.get(':class') ?? attrs.get('v-bind:class') ?? ''
  for (const literal of bound.matchAll(/'([^']*)'/g))
    parts.push(literal[1] ?? '')
  for (const name of bound.replace(/'[^']*'/g, '').matchAll(/\b[A-Z][A-Z0-9_]*\b/g))
    parts.push(constants.get(name[0]) ?? '')
  return new Set(parts.join(' ').split(/\s+/).filter(Boolean))
}

/** One line per `<Switch>` of the source without the coarse-pointer hit area its size needs. */
function missingHitAreas(source: string): string[] {
  const constants = stringConstants(source)
  return switchTags(source).flatMap((tag) => {
    const attrs = attributes(tag)
    const expected = attrs.get('size') === 'sm' ? SMALL_CLASS : DEFAULT_CLASS
    if (classTokens(attrs, constants).has(expected))
      return []
    const name = attrs.get(':data-testid') ?? attrs.get(':id') ?? attrs.get('id') ?? attrs.get(':aria-label') ?? '?'
    return [`<Switch ${name}> needs ${expected}`]
  })
}

function read(path: string): string {
  return readFileSync(join(appDir, path), 'utf8')
}

describe('switch hit areas', () => {
  it('reads static classes, :class literals and script constants by switch size', () => {
    const sm = `const SWITCH_CLASS = '${SMALL_CLASS}'\n`
    expect(missingHitAreas(`<template><Switch class="mt-0.5 ${DEFAULT_CLASS}" /></template>`)).toEqual([])
    expect(missingHitAreas(`<template><Switch :class="cn('mt-0.5', '${DEFAULT_CLASS}')" /></template>`)).toEqual([])
    expect(missingHitAreas(`${sm}<template><Switch size="sm" :class="cn(ABOVE, SWITCH_CLASS)" /></template>`)).toEqual([])
    expect(missingHitAreas(`<template><Switch @update:model-value="v => save(v)" /></template>`)).toHaveLength(1)
    expect(missingHitAreas(`<template><Switch size="sm" class="${DEFAULT_CLASS}" /></template>`)).toHaveLength(1)
    expect(missingHitAreas(`<template><Switch class="${SMALL_CLASS}" /></template>`)).toHaveLength(1)
    expect(missingHitAreas(`<template><SwitchRoot class="x" /></template>`)).toEqual([])
  })

  it.each(COMPONENTS)('%s gives every switch a 40px coarse-pointer hit area', (path) => {
    const source = read(path)
    expect(switchTags(source).length).toBeGreaterThan(0)
    expect(missingHitAreas(source)).toEqual([])
  })

  it('every switch of every .vue file has one', () => {
    const offenders = vueFiles(appDir).flatMap(file =>
      missingHitAreas(readFileSync(file, 'utf8')).map(hit => `${relative(appDir, file)}: ${hit}`))
    expect(offenders).toEqual([])
  })

  it('keeps the hit areas of wrapping rows apart on coarse pointers', () => {
    // Share options that wrap onto a second line are 40px rows each, so neighbouring hit areas never overlap.
    expect(read('components/share/ShareOptionSwitches.vue')).toMatch(/v-for="field in SHARE_OPTION_FIELDS"[^>]*class="[^"]*pointer-coarse:min-h-10/)
    // Below `sm` a provider row has a 12px gap before the Configure line, so the switch's area stays clear of it.
    expect(read('components/settings/ProviderRow.vue')).toContain('gap-y-2 px-4 py-3 pointer-coarse:gap-y-3')
  })
})
