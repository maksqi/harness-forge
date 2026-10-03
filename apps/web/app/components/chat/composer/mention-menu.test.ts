import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { projectFileEntry } from '~/utils/testing/fixtures'
import {
  mentionCountLabel,
  mentionErrorMessage,
  mentionRowLabel,
  pathBaseName,
  projectAttachErrorText,
  replaceMentionToken,
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
