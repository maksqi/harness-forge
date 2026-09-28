import type { ProviderDefinition } from '@harness-forge/plugin-sdk'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { PROVIDER_DEFINITIONS } from '../builtin-plugins/core-providers/index.ts'
import { validateProviderDefinition } from './validate.ts'

function unused(): never {
  throw new Error('unused')
}

function provider(extra: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return { id: 'acme', name: 'Acme', credentials: [], createLanguageModel: unused, ...extra }
}

function failure(definition: ProviderDefinition): HarnessError {
  try {
    validateProviderDefinition('acme', definition)
  }
  catch (error) {
    if (error instanceof HarnessError)
      return error
    throw error
  }
  throw new Error('expected a validation error')
}

describe('validateProviderDefinition: plugin API 1.1.0 members (ADR-028, ADR-029)', () => {
  const MEDIA_MEMBERS = ['createImageModel', 'imageParams', 'createTranscriptionModel', 'createSpeechModel', 'transcriptionOptions'] as const

  it('accepts the media members as functions, and definitions without them', () => {
    expect(() => validateProviderDefinition('acme', provider())).not.toThrow()
    expect(() => validateProviderDefinition('acme', provider({
      createImageModel: unused,
      imageParams: () => undefined,
      createTranscriptionModel: unused,
      createSpeechModel: unused,
      transcriptionOptions: () => undefined,
    }))).not.toThrow()
    // An explicit undefined is the same as an absent member.
    expect(() => validateProviderDefinition('acme', provider({ createImageModel: undefined }))).not.toThrow()
  })

  it.each(MEDIA_MEMBERS)('rejects a %s that is not a function with validation_error naming the member', (member) => {
    for (const value of ['nope', 42, null, {}, true]) {
      const error = failure({ ...provider(), [member]: value } as unknown as ProviderDefinition)
      expect(error.code).toBe('validation_error')
      expect(error.message).toBe(`Provider "acme": "${member}" must be a function.`)
      expect(error.details).toEqual({ issues: [{ path: [member], message: error.message, code: 'custom' }] })
    }
  })

  it('still checks the members of plugin API 1.0', () => {
    for (const member of ['listModels', 'validate', 'reasoning', 'mapError'])
      expect(failure({ ...provider(), [member]: 'nope' } as unknown as ProviderDefinition).message).toBe(`Provider "acme": "${member}" must be a function.`)
    expect(failure({ ...provider(), createLanguageModel: undefined } as unknown as ProviderDefinition).message).toBe('Provider "acme": "createLanguageModel" must be a function.')
  })

  it('accepts every builtin provider definition', () => {
    for (const definition of PROVIDER_DEFINITIONS)
      expect(() => validateProviderDefinition('core-providers', definition), definition.id).not.toThrow()
  })

  it('validates the voices of seed models (unique, at most 100)', () => {
    expect(() => validateProviderDefinition('acme', provider({ seedModels: [{ id: 'say', kind: 'speech', voices: ['a', 'b'] }] }))).not.toThrow()
    expect(failure(provider({ seedModels: [{ id: 'say', kind: 'speech', voices: ['a', 'a'] }] })).code).toBe('validation_error')
    const many = Array.from({ length: 101 }, (_, index) => `voice-${index}`)
    expect(failure(provider({ seedModels: [{ id: 'say', kind: 'speech', voices: many }] })).code).toBe('validation_error')
  })
})
