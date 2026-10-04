import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { projectSummary, rememberResult, settings } from '~/utils/testing/fixtures'
import {
  defaultTarget,
  REMEMBER_NEEDS_PROJECT,
  REMEMBER_TARGET_KEY,
  REMEMBER_TARGETS,
  REMEMBER_TEXT_MAX,
  REMEMBER_TOO_LONG,
  rememberCounter,
  rememberErrorText,
  rememberTargetCopy,
  rememberToast,
} from './remember'

describe('remember', () => {
  it('lists the targets, the project ones needing a project chat', () => {
    expect(REMEMBER_TARGETS).toEqual([
      { value: 'project-file', needsProject: true },
      { value: 'project-instructions', needsProject: true },
      { value: 'global', needsProject: false },
    ])
    expect(REMEMBER_TARGET_KEY).toBe('hf-remember-target')
    expect(REMEMBER_NEEDS_PROJECT).toBe('Open a chat in a project to use this.')
  })

  it('names each target with its project and file', () => {
    const website = { name: 'website', instructionsFile: 'AGENTS.md' as const }
    expect(rememberTargetCopy('project-file', website)).toEqual({ label: 'AGENTS.md in website', description: 'Added as a line at the end of the file.' })
    expect(rememberTargetCopy('project-file', { ...website, instructionsFile: 'CLAUDE.md' }).label).toBe('CLAUDE.md in website')
    expect(rememberTargetCopy('project-file', { ...website, instructionsFile: null }).label).toBe('AGENTS.md in website (new file)')
    expect(rememberTargetCopy('project-instructions', website)).toEqual({
      label: 'Instructions of website',
      description: 'Kept by harness-forge and sent with this project\'s chats.',
    })
    expect(rememberTargetCopy('global', null)).toEqual({ label: 'Custom instructions', description: 'Sent with every chat.' })
    expect(rememberTargetCopy('project-file', null).label).toBe('AGENTS.md in a project (new file)')
    expect(rememberTargetCopy('project-instructions', null).label).toBe('Instructions of a project')
  })

  it('counts with thousands separators and caps the note at 2,000 characters', () => {
    expect(REMEMBER_TEXT_MAX).toBe(2000)
    expect(rememberCounter(36)).toBe('36 / 2,000')
    expect(rememberCounter(2001)).toBe('2,001 / 2,000')
    expect(REMEMBER_TOO_LONG).toBe('Use at most 2,000 characters.')
  })

  it('defaults to the last enabled choice, else the project file in project chats and global elsewhere', () => {
    expect(defaultTarget(true, null)).toBe('project-file')
    expect(defaultTarget(false, null)).toBe('global')
    expect(defaultTarget(true, 'project-instructions')).toBe('project-instructions')
    expect(defaultTarget(true, 'global')).toBe('global')
    expect(defaultTarget(false, 'project-instructions')).toBe('global')
    expect(defaultTarget(false, 'project-file')).toBe('global')
    expect(defaultTarget(false, 'global')).toBe('global')
    expect(defaultTarget(true, 'nope')).toBe('project-file')
    expect(defaultTarget(true, '"global"')).toBe('project-file')
  })

  it('says where the note went', () => {
    expect(rememberToast(rememberResult(), 'harness-forge')).toBe('Saved to AGENTS.md')
    expect(rememberToast(rememberResult({ file: 'CLAUDE.md' }), 'harness-forge')).toBe('Saved to CLAUDE.md')
    expect(rememberToast(rememberResult({ created: true, project: projectSummary({ name: 'website' }) }), null)).toBe('Created AGENTS.md in website')
    expect(rememberToast(rememberResult({ target: 'project-instructions', file: undefined, project: projectSummary({ name: 'website' }) }), null))
      .toBe('Saved to the instructions of website')
    expect(rememberToast(rememberResult({ target: 'project-instructions', file: undefined, project: undefined }), 'docs'))
      .toBe('Saved to the instructions of docs')
    expect(rememberToast({ target: 'global', settings: settings() }, null)).toBe('Saved to your custom instructions')
  })

  it('maps 413, the instructions cap and an unavailable folder, and keeps the server message otherwise', () => {
    const cap = 'The instructions would be longer than 20,000 characters. Shorten them in Settings first.'
    expect(rememberErrorText(new HarnessError({ code: 'payload_too_large', message: 'Too large.' }))).toBe('The file would be larger than 1 MB.')
    expect(rememberErrorText(new HarnessError({
      code: 'validation_error',
      message: 'Too big.',
      details: { issues: [{ path: ['instructions'], message: 'Too big.', code: 'too_big' }] },
    }))).toBe(cap)
    expect(rememberErrorText(new HarnessError({ code: 'validation_error', message: 'The instructions would be longer than 20000 characters.' }))).toBe(cap)
    expect(rememberErrorText(new HarnessError({ code: 'validation_error', message: 'Custom instructions can be at most 20,000 characters.' }))).toBe(cap)
    expect(rememberErrorText(new HarnessError({ code: 'validation_error', message: 'The project folder /srv/x is not available: missing' })))
      .toBe('The project folder is unavailable.')
    expect(rememberErrorText(new HarnessError({ code: 'validation_error', message: 'The project folder is unavailable.' })))
      .toBe('The project folder is unavailable.')
    expect(rememberErrorText(new HarnessError({ code: 'validation_error', message: 'The chat has no project.' }))).toBe('The chat has no project.')
    expect(rememberErrorText(new HarnessError({ code: 'validation_error', message: 'AGENTS.md is a symbolic link.' }))).toBe('AGENTS.md is a symbolic link.')
    expect(rememberErrorText(new HarnessError({ code: 'not_found', message: 'Chat x not found.' }))).toBe('Chat x not found.')
  })

  it('maps the memory route\'s own wording (W10.6, API.md 5.29)', () => {
    const cap = 'The instructions would be longer than 20,000 characters. Shorten them in Settings first.'
    const issue = (path: string[], message: string) =>
      new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
    expect(rememberErrorText(issue(['text'], 'The global instructions would be longer than 20,000 characters with this line.'))).toBe(cap)
    expect(rememberErrorText(issue(['text'], 'The project instructions would be longer than 20,000 characters with this line.'))).toBe(cap)
    expect(rememberErrorText(issue(['chatId'], 'The project folder /srv/website is not available: The folder does not exist.')))
      .toBe('The project folder is unavailable.')
    const noProject = 'This chat has no project: Remember can save to the project only from a chat of a project.'
    expect(rememberErrorText(issue(['chatId'], noProject))).toBe(noProject)
    const link = 'AGENTS.md is a symbolic link: Remember never writes through a link.'
    expect(rememberErrorText(issue([], link))).toBe(link)
    expect(rememberErrorText(new HarnessError({ code: 'payload_too_large', message: 'AGENTS.md would be larger than 1 MiB with this line; shorten the file first.' })))
      .toBe('The file would be larger than 1 MB.')
  })
})
