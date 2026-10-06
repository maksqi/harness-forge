// The step composer (Phase 9, C26-T1; Phase 11, C37-T4): the fixed order guard → hooks → steer → finalize, the
// carry-forward of returned messages to the next piece, no override when nothing changed, abort propagation, and a
// recording model that sees the returned messages at step N and N+1 (the SDK carries them forward); a PostToolUse
// context of step N reaches the model at step N + 1.
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ModelMessage, ToolSet } from 'ai'
import type { StepInput, StepPiece } from './steps.ts'
import { hookModelText } from '@harness-forge/shared'
import { isStepCount, streamText, tool } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createMemoryLogger, createSilentLogger } from '../logger.ts'
import { createFakeHookSnapshot, fakeHookRecord, fakeHookResult, hookTargetKey } from '../testing/fake-hooks.ts'
import { createRunHooks } from './hooks.ts'
import { composeSteps, createPrepareStep, instructionsText, noopStepPiece } from './steps.ts'

const user = (text: string): ModelMessage => ({ role: 'user', content: text })

function input(messages: ModelMessage[] = [user('hi')], stepNumber = 0): StepInput {
  return { stepNumber, messages, instructions: 'Be brief.', steps: [] }
}

describe('composeSteps', () => {
  it('runs guard, steer and finalize in this order, each on the messages of the previous piece', async () => {
    const seen: { piece: string, messages: ModelMessage[] }[] = []
    const guarded = [user('summary')]
    const steered = [...guarded, user('steer')]
    const compose = composeSteps({
      contextGuard: (step) => {
        seen.push({ piece: 'guard', messages: step.messages })
        return { messages: guarded }
      },
      steer: (step) => {
        seen.push({ piece: 'steer', messages: step.messages })
        return { messages: steered }
      },
      finalize: (step) => {
        seen.push({ piece: 'finalize', messages: step.messages })
        return undefined
      },
      logger: createSilentLogger(),
    })
    const original = [user('hi')]
    expect(await compose(input(original))).toEqual({ messages: steered })
    expect(seen.map(entry => entry.piece)).toEqual(['guard', 'steer', 'finalize'])
    expect(seen[0]!.messages).toBe(original)
    expect(seen[1]!.messages).toBe(guarded)
    expect(seen[2]!.messages).toBe(steered)
  })

  it('returns no override when no piece changed anything (undefined, {} or the same array)', async () => {
    const compose = composeSteps({
      contextGuard: step => ({ messages: step.messages }),
      steer: () => ({}),
      finalize: noopStepPiece,
      logger: createSilentLogger(),
    })
    expect(await compose(input())).toBeUndefined()
    expect(await composeSteps({ contextGuard: noopStepPiece, steer: noopStepPiece, logger: createSilentLogger() })(input())).toBeUndefined()
  })

  it('takes activeTools and instructions from the finalize piece only', async () => {
    const compose = composeSteps({
      contextGuard: () => ({ activeTools: ['ignored'], instructions: 'ignored' }),
      steer: noopStepPiece,
      finalize: () => ({ activeTools: [], instructions: 'Write the final report now.' }),
      logger: createSilentLogger(),
    })
    expect(await compose(input())).toEqual({ activeTools: [], instructions: 'Write the final report now.' })
  })

  it('propagates an abort and skips the later pieces', async () => {
    const later: string[] = []
    const compose = composeSteps({
      contextGuard: async () => {
        throw new DOMException('stopped', 'AbortError')
      },
      steer: () => {
        later.push('steer')
        return undefined
      },
      logger: createSilentLogger(),
    })
    await expect(compose(input())).rejects.toMatchObject({ name: 'AbortError' })
    expect(later).toEqual([])
  })

  it('logs any other failure of a piece and goes on without it', async () => {
    const memory = createMemoryLogger()
    const steered = [user('hi'), user('steer')]
    const compose = composeSteps({
      contextGuard: () => {
        throw new Error('summarizer exploded')
      },
      steer: step => ({ messages: [...step.messages, user('steer')] }),
      logger: memory.logger,
    })
    expect(await compose(input([user('hi')], 3))).toEqual({ messages: steered })
    expect(memory.records).toEqual([expect.objectContaining({ level: 'warn', piece: 'contextGuard', stepNumber: 3 })])
  })
})

describe('instructionsText', () => {
  it('reads strings and system messages', () => {
    expect(instructionsText(undefined)).toBeUndefined()
    expect(instructionsText('plain')).toBe('plain')
    expect(instructionsText({ role: 'system', content: 'one' })).toBe('one')
    expect(instructionsText([{ role: 'system', content: 'one' }, { role: 'system', content: 'two' }])).toBe('one\n\ntwo')
  })
})

// ---------- with the AI SDK ----------

function finish(reason: 'stop' | 'tool-calls'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

/** Two tool steps, then a text step; every call is recorded. */
function recordingModel(calls: LanguageModelV4CallOptions[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options)
      const step = calls.length - 1
      const parts: LanguageModelV4StreamPart[] = step < 2
        ? [{ type: 'tool-call', toolCallId: `call_${step}`, toolName: 'noop', input: '{}' }, finish('tool-calls')]
        : [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, finish('stop')]
      return { stream: convertArrayToReadableStream(parts) }
    },
  })
}

/** One tool, typed as the generic tool set (like the pipeline's). */
function noopTools(): ToolSet {
  return { noop: tool({ inputSchema: z.object({}), execute: async () => 'ok' }) }
}

function userTexts(prompt: LanguageModelV4Prompt): string[] {
  return prompt.flatMap(message => (message.role === 'user' ? message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])) : []))
}

describe('createPrepareStep with streamText', () => {
  it('sends the messages a piece returned at step N, and carries them into step N + 1', async () => {
    const calls: LanguageModelV4CallOptions[] = []
    const inputs: { stepNumber: number, steps: number, instructions: string | undefined }[] = []
    const steer: StepPiece = (step) => {
      inputs.push({ stepNumber: step.stepNumber, steps: step.steps.length, instructions: step.instructions })
      return step.stepNumber === 1 ? { messages: [...step.messages, user('STEERED')] } : undefined
    }
    const result = streamText({
      model: recordingModel(calls),
      instructions: 'Be brief.',
      messages: [user('start')],
      tools: noopTools(),
      stopWhen: isStepCount(5),
      prepareStep: createPrepareStep({ contextGuard: noopStepPiece, steer, logger: createSilentLogger() }),
    })
    await result.consumeStream()
    expect(calls).toHaveLength(3)
    expect(inputs).toEqual([
      { stepNumber: 0, steps: 0, instructions: 'Be brief.' },
      { stepNumber: 1, steps: 1, instructions: 'Be brief.' },
      { stepNumber: 2, steps: 2, instructions: 'Be brief.' },
    ])
    expect(userTexts(calls[0]!.prompt)).toEqual(['start'])
    expect(userTexts(calls[1]!.prompt)).toEqual(['start', 'STEERED'])
    expect(userTexts(calls[2]!.prompt)).toEqual(['start', 'STEERED'])
    // The steer sits after the first tool result at step 1, and stays there at step 2 (then the second tool result).
    expect(calls[1]!.prompt.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(calls[2]!.prompt.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool'])
  })

  it('changes nothing with no-op pieces', async () => {
    const calls: LanguageModelV4CallOptions[] = []
    const result = streamText({
      model: recordingModel(calls),
      messages: [user('start')],
      tools: noopTools(),
      stopWhen: isStepCount(5),
      prepareStep: createPrepareStep({ contextGuard: noopStepPiece, steer: noopStepPiece, logger: createSilentLogger() }),
    })
    await result.consumeStream()
    expect(calls.map(call => call.prompt.map(message => message.role))).toEqual([
      ['user'],
      ['user', 'assistant', 'tool'],
      ['user', 'assistant', 'tool', 'assistant', 'tool'],
    ])
  })
})

describe('the hooks piece (Phase 11, C37-T4)', () => {
  it('runs between the guard and the steer step: guard → hooks → steer → finalize', async () => {
    const order: string[] = []
    const piece = (name: string, add?: string): StepPiece => (step) => {
      order.push(name)
      return add === undefined ? undefined : { messages: [...step.messages, user(add)] }
    }
    const compose = composeSteps({ contextGuard: piece('guard'), hooks: piece('hooks', 'HOOK'), steer: piece('steer', 'STEER'), finalize: piece('finalize'), logger: createSilentLogger() })
    expect(await compose(input([user('hi')]))).toEqual({ messages: [user('hi'), user('HOOK'), user('STEER')] })
    expect(order).toEqual(['guard', 'hooks', 'steer', 'finalize'])
  })

  it('a PostToolUse context of step N reaches the model at step N + 1, after the tool result and before the steers', async () => {
    const record = fakeHookRecord('PostToolUse', 'context', { toolCallId: 'call_0', toolName: 'noop', context: 'lint ok' })
    const snapshot = createFakeHookSnapshot({ targets: { [hookTargetKey('PostToolUse', 'noop')]: (hookInput) => {
      return hookInput.tool?.callId === 'call_0' ? fakeHookResult({ context: 'lint ok', record }) : fakeHookResult()
    } } })
    const injected: { step: number }[] = []
    const host = { stepNumber: -1, inject: (_chunk: unknown, step: number) => injected.push({ step }), writeTransient: () => {} }
    const hooks = createRunHooks({ snapshot, host, continued: null, messageId: 'msg_a000000000000001', logger: createSilentLogger() })
    const calls: LanguageModelV4CallOptions[] = []
    const tools: ToolSet = {
      noop: tool({
        inputSchema: z.object({}),
        execute: async (_input, options) => {
          await hooks.postToolUse({ toolName: 'noop', toolCallId: options.toolCallId, input: {}, output: 'ok' }, new AbortController().signal)
          return 'ok'
        },
      }),
    }
    const steer: StepPiece = step => (step.stepNumber === 1 ? { messages: [...step.messages, user('STEERED')] } : undefined)
    const result = streamText({
      model: recordingModel(calls),
      messages: [user('start')],
      tools,
      stopWhen: isStepCount(5),
      prepareStep: createPrepareStep({ contextGuard: noopStepPiece, hooks: hooks.stepPiece(), steer, logger: createSilentLogger() }),
    })
    await result.consumeStream()
    expect(calls).toHaveLength(3)
    const text = hookModelText(record, 'assistant')!
    expect(userTexts(calls[0]!.prompt)).toEqual(['start'])
    expect(userTexts(calls[1]!.prompt)).toEqual(['start', text, 'STEERED'])
    expect(calls[1]!.prompt.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'user'])
    expect(userTexts(calls[2]!.prompt)).toEqual(['start', text, 'STEERED'])
    // The record is placed for the step after the one that ran the tool (step 0 → right before step 1).
    expect(injected).toEqual([{ step: 1 }])
    expect(host.stepNumber).toBe(2)
  })
})
