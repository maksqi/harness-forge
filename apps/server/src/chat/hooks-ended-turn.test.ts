// W12.20 (ADR-057; the `test.fixme` of `e2e/specs/core/prompt-hooks.spec.ts`): the history of a turn that ended on a
// tool result, end to end over `POST /api/chat` with the real hook service, a personal hook and `mock:hooks` in a project
// chat (Auto). A PreToolUse prompt hook that answers `ok: false` without `continueOnBlock` denies the call and stops
// the run (`continue: false`), so the reply ends with the denied tool part and its `data-hook` record and holds no
// text. The next turn's model messages are well formed: user / assistant (the tool call) / tool (the denial as the AI
// SDK converts a stored `output-denied` part: an `error-text` result) / user (the new message, last). An approval
// superseded by a new message (Phase 7) gives the same shape; a command PreToolUse block (exit 2) does not end the
// turn, so the model's closing text lies between the result and the next user message.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { ChatDetail, HarnessUIMessage, HookData, ToolMode } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { ResolvedModel } from '../providers/types.ts'
import type { HookHarness } from '../services/hooks/testing.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { chatDetailSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHookTestKit } from '../services/hooks/testing.ts'
import { writeHookScript } from '../testing/hook-scripts.ts'
import { SUPERSEDED_REASON } from './history.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText } from './testing.ts'

const posix = process.platform !== 'win32'
const kit = createHookTestKit()
afterEach(kit.cleanup)

const HOOKS_MODEL = 'mock:hooks'
const INPUT = { path: 'blocked.txt', content: '[[ph:deny no writes]]' }
const CALL = `call write_file ${JSON.stringify(INPUT)}`

interface Chat {
  readonly id: string
  /** The prompt of every `mock:hooks` stream call, in order. */
  readonly prompts: LanguageModelV4Prompt[]
  readonly send: (text: string, toolMode?: ToolMode) => Promise<{ chunks: UIMessageChunk[], text: string }>
  readonly messages: () => Promise<HarnessUIMessage[]>
}

/** A project chat on `mock:hooks` whose stream calls are recorded. */
async function openChat(h: HookHarness): Promise<Chat> {
  const prompts: LanguageModelV4Prompt[] = []
  const real = h.t.deps.providers.resolveModel.bind(h.t.deps.providers)
  vi.spyOn(h.t.deps.providers, 'resolveModel').mockImplementation(async (ref, options) => {
    const resolved = await real(ref, options)
    if (ref !== HOOKS_MODEL)
      return resolved
    const inner = resolved.model as LanguageModelV4
    const model = Object.create(inner) as LanguageModelV4
    Object.defineProperty(model, 'doStream', {
      value: (call: LanguageModelV4CallOptions) => {
        prompts.push(call.prompt)
        return inner.doStream(call)
      },
    })
    return { ...resolved, model } as ResolvedModel
  })
  const chat = await h.t.deps.chats.create({ projectId: h.project.id, modelRef: HOOKS_MODEL })
  return {
    id: chat.id,
    prompts,
    send: async (text, toolMode = 'auto') => {
      const { chunks } = await readSse(await postChat(h.t, chatBody(chat.id, text, { modelRef: HOOKS_MODEL, toolMode })))
      await runnerOf(h.t).idle()
      return { chunks, text: streamedText(chunks) }
    },
    messages: async () => (chatDetailSchema.parse(await (await h.t.request(`/api/chats/${chat.id}`)).json()) as ChatDetail).messages,
  }
}

function chunkTypes(chunks: readonly UIMessageChunk[]): string[] {
  return chunks.map(chunk => chunk.type)
}

/** The prompt without its system messages. */
function conversation(prompt: LanguageModelV4Prompt | undefined): LanguageModelV4Prompt {
  return (prompt ?? []).filter(message => message.role !== 'system')
}

function userText(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function toolCall(toolCallId: string) {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'write_file', input: INPUT }] }
}

function errorResult(toolCallId: string, value: string) {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'write_file', output: { type: 'error-text', value } }] }
}

describe.skipIf(!posix)('the turn after a turn that ended on a tool result (W12.20)', () => {
  it('a PreToolUse prompt hook ends the turn on the denial; the next turn reads it before the new user message', async () => {
    const h = await kit.open()
    await h.t.deps.settings.update({ hookModelRef: 'mock:prompt-hook' })
    await h.hooks.create({ type: 'prompt', event: 'PreToolUse', matcher: 'Write', prompt: 'Judge the call: $ARGUMENTS' })
    const chat = await openChat(h)

    const first = await chat.send(CALL)
    expect(chunkTypes(first.chunks)).toContain('tool-output-denied')
    expect(first.text).toBe('')
    const [, reply] = await chat.messages()
    expect(reply!.parts.map(part => part.type)).toEqual(['step-start', 'tool-write_file', 'data-hook'])
    expect(reply!.parts[1]).toMatchObject({ toolCallId: 'mock_call_1', state: 'output-denied', approval: { approved: false, reason: 'Blocked by hook: no writes' } })
    expect((reply!.parts[2] as { data: HookData }).data).toMatchObject({ event: 'PreToolUse', outcome: 'denied', reason: 'no writes', hooks: [{ kind: 'prompt', model: 'mock:prompt-hook' }] })
    expect(existsSync(join(h.root, INPUT.path))).toBe(false)

    chat.prompts.length = 0
    await chat.send(CALL)
    // The stored path and the model messages of the next turn are well formed: every call has its result, the denial
    // comes before the new user message, which is the last message; the PreToolUse record is display-only. Nothing
    // marks the end of the earlier turn (no assistant text), so a reader that takes a user message right after a tool
    // message for a steer (the shared rule of the agent mocks, `mock/turn.ts`) opens the turn at the earlier message.
    expect(conversation(chat.prompts[0])).toEqual([
      userText(CALL),
      toolCall('mock_call_1'),
      errorResult('mock_call_1', 'Blocked by hook: no writes'),
      userText(CALL),
    ])
    expect((await chat.messages()).map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('an approval superseded by a new message (Phase 7) leaves the same shape', async () => {
    const h = await kit.open()
    const chat = await openChat(h)
    const first = await chat.send(CALL, 'ask')
    expect(chunkTypes(first.chunks)).toContain('tool-approval-request')
    chat.prompts.length = 0
    await chat.send(CALL, 'ask')
    expect(conversation(chat.prompts[0])).toEqual([
      userText(CALL),
      toolCall('mock_call_1'),
      errorResult('mock_call_1', SUPERSEDED_REASON),
      userText(CALL),
    ])
  })

  it('a command PreToolUse block (exit 2) does not end the turn: the closing text comes before the next user message', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'PreToolUse', matcher: 'Write', command: await writeHookScript(h.root, 'exit2', { text: 'no writes' }) })
    const chat = await openChat(h)
    const first = await chat.send(CALL)
    expect(first.text).toBe('Called write_file: denied | Blocked by hook: no writes | hooks: none')

    chat.prompts.length = 0
    const second = await chat.send(CALL)
    expect(conversation(chat.prompts[0])).toEqual([
      userText(CALL),
      toolCall('mock_call_1'),
      errorResult('mock_call_1', 'Blocked by hook: no writes'),
      { role: 'assistant', content: [{ type: 'text', text: first.text }] },
      userText(CALL),
    ])
    expect(chunkTypes(second.chunks)).toEqual(expect.arrayContaining(['tool-input-available', 'tool-output-denied']))
    expect(second.text).toBe(first.text)
    expect(existsSync(join(h.root, INPUT.path))).toBe(false)
  })
})
