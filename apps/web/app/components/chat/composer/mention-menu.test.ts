import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { mcpResourceEntry, projectFileEntry } from '~/utils/testing/fixtures'
import {
  mentionCountLabel,
  mentionErrorMessage,
  mentionRowLabel,
  pathBaseName,
  projectAttachErrorText,
  replaceMentionToken,
  replaceResourceToken,
  resourceAttachErrorText,
  resourceCountLabel,
  resourceIconKind,
  resourceOptionLabel,
  resourcesUnavailableText,
  resourceTitle,
} from './mention-menu'

describe('mention menu helpers', () => {
  it('replaces the token with a file mention and one blank', () => {
    expect(replaceMentionToken('Fix @pa', { start: 4, end: 7 }, projectFileEntry('src/parser.ts')))
      .toEqual({ text: 'Fix @src/parser.ts ', caret: 19, keepOpen: false })
    // An existing blank after the token is reused; the caret goes after it.
    expect(replaceMentionToken('@pa next', { start: 0, end: 3 }, projectFileEntry('a.ts')))
      .toEqual({ text: '@a.ts next', caret: 6, keepOpen: false })
    // formatMention quotes paths with blanks (and already starts with "@").
    expect(replaceMentionToken('@"my n', { start: 0, end: 6 }, projectFileEntry('my notes.md')))
      .toEqual({ text: '@"my notes.md" ', caret: 15, keepOpen: false })
    // A path that cannot be a mention removes the token (the chip still carries the file).
    expect(replaceMentionToken('x @q', { start: 2, end: 4 }, projectFileEntry('say "hi".txt')))
      .toEqual({ text: 'x ', caret: 2, keepOpen: false })
  })

  it('replaces the token with @folder/ and keeps the menu open', () => {
    expect(replaceMentionToken('@pars', { start: 0, end: 5 }, projectFileEntry('src/parsers', 'dir')))
      .toEqual({ text: '@src/parsers/', caret: 13, keepOpen: true })
    expect(replaceMentionToken('@my', { start: 0, end: 3 }, projectFileEntry('my dir', 'dir')))
      .toEqual({ text: '@"my dir/"', caret: 9, keepOpen: true })
  })

  it('splits a row into the base name and its folder with the matched runs', () => {
    expect(mentionRowLabel(projectFileEntry('src/parser.ts'), 'pars')).toEqual({
      name: [{ text: 'pars', match: true }, { text: 'er.ts', match: false }],
      folder: [{ text: 'src/', match: false }],
    })
    expect(mentionRowLabel(projectFileEntry('src/parsers', 'dir'), '')).toEqual({
      name: [{ text: 'parsers', match: false }, { text: '/', match: false }],
      folder: [{ text: 'src/', match: false }],
    })
    // A subsequence match spans the folder and the name.
    const label = mentionRowLabel(projectFileEntry('src/app/main.ts'), 'sam')
    expect(label.folder.filter(run => run.match).map(run => run.text).join('') + label.name.filter(run => run.match).map(run => run.text).join(''))
      .toHaveLength(3)
    expect(mentionRowLabel(projectFileEntry('README.md'), 'zzz')).toEqual({ name: [{ text: 'README.md', match: false }], folder: [] })
  })

  it('names base names, counts and errors', () => {
    expect(pathBaseName('src/parser.ts')).toBe('parser.ts')
    expect(pathBaseName('README.md')).toBe('README.md')
    expect(pathBaseName('src/parsers/')).toBe('parsers')
    expect(mentionCountLabel(0)).toBe('No matching files')
    expect(mentionCountLabel(1)).toBe('1 file')
    expect(mentionCountLabel(12)).toBe('12 files')
    expect(mentionErrorMessage(new HarnessError({ code: 'validation_error', message: 'The folder is missing.' }))).toBe('The project folder is unavailable.')
    expect(mentionErrorMessage(new HarnessError({ code: 'internal_error', message: 'Boom.' }))).toBe('Couldn\'t search files.')
    expect(mentionErrorMessage(null)).toBe('Couldn\'t search files.')
  })

  it('explains why a project file cannot be attached', () => {
    expect(projectAttachErrorText(new HarnessError({ code: 'payload_too_large', message: 'Too large.' }))).toBe('Files can be up to 5 MB.')
    expect(projectAttachErrorText(new HarnessError({ code: 'not_found', message: 'File x not found.' }))).toBe('The file no longer exists.')
    const type = new HarnessError({ code: 'validation_error', message: 'Unsupported type.', details: { issues: [{ path: ['file'], message: 'Unsupported type.', code: 'custom' }] } })
    expect(projectAttachErrorText(type)).toBe('Attach images, PDFs or text files.')
    const path = new HarnessError({ code: 'validation_error', message: 'path: A .git path cannot be attached.', details: { issues: [{ path: ['path'], message: 'A .git path cannot be attached.', code: 'custom' }] } })
    expect(projectAttachErrorText(path)).toBe('path: A .git path cannot be attached.')
    expect(projectAttachErrorText(new HarnessError({ code: 'validation_error', message: 'The project folder is unavailable.' }))).toBe('The project folder is unavailable.')
  })
})

describe('mention menu helpers: MCP resources (Phase 14)', () => {
  it('replaces the token with the resource mention and one blank', () => {
    expect(replaceResourceToken('See @READ', { start: 4, end: 9 }, mcpResourceEntry()))
      .toEqual({ text: 'See @github:repo://owner/name/README.md ', caret: 40, keepOpen: false })
    // An existing blank after the token is reused; the caret goes after it.
    expect(replaceResourceToken('@re now', { start: 0, end: 3 }, mcpResourceEntry({ serverId: 'fs', uri: 'file:///notes.md' })))
      .toEqual({ text: '@fs:file:///notes.md now', caret: 21, keepOpen: false })
    // A URI that cannot be written as a mention (a blank, no scheme) only removes the token.
    expect(replaceResourceToken('x @a y', { start: 2, end: 4 }, mcpResourceEntry({ uri: 'file:///my notes.md' })))
      .toEqual({ text: 'x  y', caret: 2, keepOpen: false })
  })

  it('titles, icons and names a resource row', () => {
    expect(resourceTitle(mcpResourceEntry({ title: 'Read me' }))).toBe('Read me')
    expect(resourceTitle(mcpResourceEntry({ title: '  ' }))).toBe('README.md')
    expect(resourceTitle(mcpResourceEntry({ name: '' }))).toBe('repo://owner/name/README.md')
    expect(['text/markdown', 'application/json', 'application/ld+json', 'image/png', 'application/pdf', 'application/zip', undefined].map(resourceIconKind))
      .toEqual(['text', 'text', 'text', 'image', 'pdf', 'file', 'file'])
    expect(resourceOptionLabel(mcpResourceEntry())).toBe('README.md, GitHub, text/markdown')
    expect(resourceOptionLabel(mcpResourceEntry({ mimeType: undefined, serverName: '' }))).toBe('README.md, github')
  })

  it('counts the resources and names the servers that are not connected', () => {
    expect([0, 1, 7].map(resourceCountLabel)).toEqual(['No matching resources', '1 resource', '7 resources'])
    expect(resourcesUnavailableText([])).toBeNull()
    expect(resourcesUnavailableText(['Linear', ' ', 'docs'])).toBe('Not listed: Linear, docs (not connected).')
  })

  it('says why a resource cannot be attached', () => {
    expect(resourceAttachErrorText(new HarnessError({ code: 'payload_too_large', message: 'Too large.', details: { limitBytes: 5_242_880 } }), 'big.log', 'GitHub'))
      .toBe('This resource is larger than 5 MB.')
    expect(resourceAttachErrorText(new HarnessError({ code: 'conflict', message: 'Sign in first.', details: { reason: 'needs-auth' } }), 'README.md', 'Linear'))
      .toBe('Sign in to Linear first.')
    expect(resourceAttachErrorText(new HarnessError({ code: 'conflict', message: 'Busy.', details: { reason: 'run-active' } }), 'README.md', 'Linear'))
      .toBe('Couldn\'t attach README.md.')
    expect(resourceAttachErrorText(new HarnessError({ code: 'provider_unreachable', message: 'Not connected.' }), 'README.md', 'GitHub'))
      .toBe('Couldn\'t attach README.md.')
    expect(resourceAttachErrorText(null, 'README.md', 'GitHub')).toBe('Couldn\'t attach README.md.')
  })
})
