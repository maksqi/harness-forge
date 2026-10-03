import type { ProviderDefinition, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ToolRegisterOptions } from './types.ts'
import { HarnessError, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PROVIDER_DEFINITIONS } from '../builtin-plugins/core-providers/index.ts'
import { createWorkspaceTools } from '../builtin-plugins/core-workspace/index.ts'
import { createMemoryLogger } from '../logger.ts'
import { validateProviderDefinition, validateToolDefinition } from './validate.ts'

function unused(): never {
  throw new Error('unused')
}

function provider(extra: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return { id: 'acme', name: 'Acme', credentials: [], createLanguageModel: unused, ...extra }
}

function thrown(run: () => void): HarnessError {
  try {
    run()
  }
  catch (error) {
    if (error instanceof HarnessError)
      return error
    throw error
  }
  throw new Error('expected a validation error')
}

function failure(definition: ProviderDefinition): HarnessError {
  return thrown(() => validateProviderDefinition('acme', definition))
}

function tool(extra: Record<string, unknown> = {}): ToolDefinition {
  return {
    name: 'read_notes',
    description: 'Reads the notes.',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => 'ok',
    ...extra,
  } as ToolDefinition
}

function toolFailure(definition: ToolDefinition, options?: ToolRegisterOptions): HarnessError {
  return thrown(() => validateToolDefinition(definition, options))
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

describe('validateToolDefinition: workspace access (plugin API 1.2.0, ADR-032)', () => {
  it.each(['read', 'write', 'execute'] as const)('accepts workspace "%s"', (workspace) => {
    expect(() => validateToolDefinition(tool({ workspace }))).not.toThrow()
  })

  it('accepts a tool without workspace access (absent or explicitly undefined)', () => {
    expect(() => validateToolDefinition(tool())).not.toThrow()
    expect(() => validateToolDefinition(tool({ workspace: undefined }))).not.toThrow()
  })

  it.each([
    ['"admin"', 'admin'],
    ['"Read"', 'Read'],
    ['""', ''],
    ['number', 1],
    ['object', null],
    ['object', ['read']],
    ['boolean', true],
  ])('rejects workspace %s with validation_error naming the tool', (shown, workspace) => {
    const error = toolFailure(tool({ workspace }))
    expect(error.code).toBe('validation_error')
    expect(error.message).toBe(`Tool "read_notes": "workspace" must be "read", "write" or "execute" (got ${shown}).`)
    expect(error.details).toEqual({ issues: [{ path: ['workspace'], message: error.message, code: 'custom' }] })
  })

  it('accepts every core-workspace tool with its documented access', () => {
    const tools = createWorkspaceTools({ logger: createMemoryLogger().logger, platform: 'linux' })
    expect(tools.map(definition => definition.name)).toEqual(Object.keys(WORKSPACE_TOOL_ACCESS))
    for (const definition of tools) {
      expect(() => validateToolDefinition(definition), definition.name).not.toThrow()
      expect(definition.workspace).toBe(WORKSPACE_TOOL_ACCESS[definition.name as keyof typeof WORKSPACE_TOOL_ACCESS])
    }
  })
})
