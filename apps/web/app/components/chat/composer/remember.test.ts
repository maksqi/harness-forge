import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { projectSummary, rememberResult, settings } from '~/utils/testing/fixtures'
import { defaultTarget, REMEMBER_TARGET_KEY, REMEMBER_TARGETS, rememberErrorText, rememberToast } from './remember'

describe('remember', () => {
  it('lists the targets, the project ones needing a project chat', () => {
    expect(REMEMBER_TARGETS).toEqual([
      { value: 'project-file', needsProject: true },
      { value: 'project-instructions', needsProject: true },
      { value: 'global', needsProject: false },
    ])
    expect(REMEMBER_TARGET_KEY).toBe('hf-remember-target')
  })

  it('defaults to the last enabled choice, else the project file in project chats and global elsewhere', () => {
    expect(defaultTarget(true, null)).toBe('project-file')
    expect(defaultTarget(false, null)).toBe('global')
    expect(defaultTarget(true, 'project-instructions')).toBe('project-instructions')
    expect(defaultTarget(false, 'project-instructions')).toBe('global')
    expect(defaultTarget(false, 'global')).toBe('global')
    expect(defaultTarget(true, 'nope')).toBe('project-file')
  })

  it('says where the note went', () => {
    expect(rememberToast(rememberResult(), 'harness-forge')).toBe('Saved to AGENTS.md')
    expect(rememberToast(rememberResult({ created: true, project: projectSummary({ name: 'website' }) }), null)).toBe('Created AGENTS.md in website')
    expect(rememberToast(rememberResult({ target: 'project-instructions', file: undefined, project: projectSummary({ name: 'website' }) }), null))
      .toBe('Saved to the instructions of website')
    expect(rememberToast({ target: 'global', settings: settings() }, null)).toBe('Saved to your custom instructions')
  })

  it('maps 413 to the file size message and keeps the server message otherwise', () => {
    expect(rememberErrorText(new HarnessError({ code: 'payload_too_large', message: 'Too large.' }))).toBe('The file would be larger than 1 MB.')
    expect(rememberErrorText(new HarnessError({ code: 'validation_error', message: 'The chat has no project.' }))).toBe('The chat has no project.')
  })
})
