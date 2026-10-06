import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { hookData, styleEntry } from '~/utils/testing/fixtures'
import {
  automaticStyle,
  automaticStyleLine,
  isDefaultStyle,
  manageStylesHref,
  missingStyle,
  refusalOf,
  refusalSourceLine,
  refusalTitle,
  resolveStyleQuery,
  styleOptions,
  styleSourceText,
  styleTriggerName,
} from './output-style'

describe('refusalOf', () => {
  it('maps a hook-blocked conflict with its record', () => {
    const error = new HarnessError({ code: 'conflict', message: 'Do not paste keys.', details: { reason: 'hook-blocked', hook: hookData({ event: 'UserPromptSubmit', outcome: 'blocked', toolCallId: undefined, toolName: undefined }) } })
    expect(refusalOf(error)).toEqual({ code: 'hook-blocked', reason: 'Do not paste keys.', event: 'UserPromptSubmit', source: 'project', command: null })
  })

  it('maps a hook-blocked conflict without a valid record and an untrusted conflict', () => {
    const blocked = new HarnessError({ code: 'conflict', message: 'Blocked.', details: { reason: 'hook-blocked', hook: { id: 'x' } } })
    expect(refusalOf(blocked)).toEqual({ code: 'hook-blocked', reason: 'Blocked.', event: null, source: null, command: null })
    const untrusted = new HarnessError({ code: 'conflict', message: 'Approve it first.', details: { reason: 'untrusted' } })
    expect(refusalOf(untrusted)).toMatchObject({ code: 'untrusted', reason: 'Approve it first.' })
  })

  it('is null for other errors', () => {
    expect(refusalOf(new HarnessError({ code: 'conflict', message: 'Busy', details: { reason: 'run-active' } }))).toBeNull()
    expect(refusalOf(new HarnessError({ code: 'not_found', message: 'Gone' }))).toBeNull()
    expect(refusalOf(null)).toBeNull()
    expect(refusalOf(new Error('boom'))).toBeNull()
  })
})

describe('the style options (P11-0b first versions)', () => {
  it('lists the built-ins first, then the active styles of the catalog', () => {
    const options = styleOptions([styleEntry(), styleEntry({ name: 'off-style', state: 'off' })])
    expect(options.map(option => option.name)).toEqual(['default', 'explanatory', 'learning', 'terse'])
    expect(options[3]).toMatchObject({ label: 'Terse', source: 'project', available: true })
    expect(automaticStyle('terse', 'default', options)?.name).toBe('terse')
    expect(automaticStyle(null, 'learning', options)?.name).toBe('learning')
    expect(resolveStyleQuery('auto', options)).toEqual({ style: null })
    expect(resolveStyleQuery('TERSE', options)).toEqual({ style: 'terse' })
    expect(resolveStyleQuery('nope', options)).toHaveProperty('error')
  })
})

describe('styleOptions', () => {
  const entries = [
    styleEntry({ name: 'zeta', label: 'Zeta', source: 'plugin', pluginId: 'fun-pack', path: undefined }),
    styleEntry(),
    styleEntry({ name: 'brief', label: 'Brief', source: 'user', path: undefined }),
    styleEntry({ name: 'alpha', label: undefined, source: 'project', path: '.claude/output-styles/alpha.md' }),
    styleEntry({ name: 'shadowed', state: 'shadowed' }),
    styleEntry({ name: 'broken', state: 'invalid', description: '' }),
    styleEntry({ name: 'paused', source: 'user', enabled: false, state: 'off' }),
    // A catalog may list the built-ins too; they keep their shared labels and their place.
    styleEntry({ name: 'learning', label: 'Learning (catalog)', source: 'builtin', path: undefined }),
    { ...styleEntry({ name: 'reviewer' }), kind: 'agent' as const },
  ]

  it('offers the built-ins, then personal, project and plugin styles by label, without inactive ones', () => {
    const options = styleOptions(entries)
    expect(options.map(option => `${option.source}:${option.name}`)).toEqual([
      'builtin:default',
      'builtin:explanatory',
      'builtin:learning',
      'user:brief',
      'project:alpha',
      'project:terse',
      'plugin:zeta',
    ])
    expect(options.find(option => option.name === 'learning')?.label).toBe('Learning')
    // A style without a label shows its name.
    expect(options.find(option => option.name === 'alpha')?.label).toBe('alpha')
    expect(options.every(option => option.available)).toBe(true)
  })

  it('resolves Automatic to the project style, else the global default; null for a missing one', () => {
    const options = styleOptions(entries)
    expect(automaticStyle(' terse ', 'learning', options)?.name).toBe('terse')
    expect(automaticStyle('', 'learning', options)?.name).toBe('learning')
    expect(automaticStyle(null, 'gone', options)).toBeNull()
    expect(automaticStyle('gone', 'default', options)).toBeNull()
    expect(automaticStyle(null, '', options)).toBeNull()
  })

  it('resolves /output-style by name, then by label, case-insensitively; auto and automatic mean Automatic', () => {
    const options = styleOptions(entries)
    expect(resolveStyleQuery(' Automatic ', options)).toEqual({ style: null })
    expect(resolveStyleQuery('LEARNING', options)).toEqual({ style: 'learning' })
    expect(resolveStyleQuery('Brief', options)).toEqual({ style: 'brief' })
    expect(resolveStyleQuery('zeta', options)).toEqual({ style: 'zeta' })
    expect(resolveStyleQuery('paused', options)).toEqual({ error: 'Unknown output style "paused". Use auto, default, explanatory, learning or a style from the menu.' })
    expect(resolveStyleQuery('gone', [...options, missingStyle('gone', options)!])).toHaveProperty('error')
  })
})

describe('display helpers', () => {
  const options = styleOptions([styleEntry()])

  it('names sources, the Automatic line and the trigger', () => {
    expect(styleSourceText(options[0]!)).toBe('Built-in')
    expect(styleSourceText({ name: 'brief', source: 'user' })).toBe('Personal')
    expect(styleSourceText({ name: 'terse', source: 'project' })).toBe('Project')
    expect(styleSourceText({ name: 'pirate', source: 'plugin' }, { pirate: 'Fun pack' })).toBe('Fun pack')
    expect(styleSourceText({ name: 'pirate', source: 'plugin' })).toBe('Plugin')

    const terse = options.find(option => option.name === 'terse')!
    expect(automaticStyleLine(terse, { projectName: 'website', projectStyle: 'terse' })).toBe('Uses Terse, set for website')
    expect(automaticStyleLine(terse, { projectName: null, projectStyle: 'terse' })).toBe('Uses Terse, set for this project')
    expect(automaticStyleLine(options[1]!, { projectName: 'website', projectStyle: null })).toBe('Uses Explanatory, your default in Settings')
    expect(automaticStyleLine(null, { projectName: null, projectStyle: null })).toBe('Uses Default, your default in Settings')

    expect(styleTriggerName('Terse', false)).toBe('Output style: Terse')
    expect(styleTriggerName('Default', true)).toBe('Output style: Default (automatic)')
    expect(isDefaultStyle('default')).toBe(true)
    expect(isDefaultStyle('terse')).toBe(false)
  })

  it('keeps a missing chosen style as an unavailable option', () => {
    expect(missingStyle(null, options)).toBeNull()
    expect(missingStyle('terse', options)).toBeNull()
    expect(missingStyle('gone', options)).toEqual({ name: 'gone', label: 'gone', description: '', source: 'user', available: false })
  })

  it('links the Customize tab with the project', () => {
    expect(manageStylesHref(null)).toBe('/settings/customize?tab=output-styles')
    expect(manageStylesHref('prj_a b')).toBe('/settings/customize?tab=output-styles&project=prj_a%20b')
  })

  it('words the refusal', () => {
    const blocked = { code: 'hook-blocked' as const, reason: 'No.', event: 'UserPromptSubmit' as const, source: 'project', command: null }
    expect(refusalTitle(blocked)).toBe('A hook blocked this message')
    expect(refusalSourceLine(blocked)).toBe('UserPromptSubmit · Project hook')
    expect(refusalSourceLine({ ...blocked, source: 'personal' })).toBe('UserPromptSubmit · Personal hook')
    expect(refusalSourceLine({ ...blocked, source: null })).toBe('UserPromptSubmit')
    expect(refusalSourceLine({ ...blocked, event: null })).toBeNull()
    const untrusted = { code: 'untrusted' as const, reason: 'Approve.', event: null, source: null, command: 'deploy' }
    expect(refusalTitle(untrusted)).toBe('/deploy runs shell lines you haven\'t approved.')
    expect(refusalTitle({ ...untrusted, command: null })).toBe('This command runs shell lines you haven\'t approved.')
    expect(refusalSourceLine(untrusted)).toBeNull()
  })
})
