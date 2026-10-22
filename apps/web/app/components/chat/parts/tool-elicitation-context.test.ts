// TOOL_ELICITATIONS (Phase 14, ADR-060; docs/UI.md 11.10, C54): the pending requests of a reply's MCP tool parts and the
// context ChatView provides from its session (forCall, busy, issues, gone, respond).
import type { HarnessUIMessage, McpElicitation, McpElicitationAnswerBody } from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { ref, shallowRef } from 'vue'
import { elicitationId, mcpElicitation, mcpToolProgress } from '~/utils/testing/fixtures'
import { createToolElicitationContext, pendingElicitationsOf } from './tool-elicitation-context'

type Part = HarnessUIMessage['parts'][number]

function toolPart(toolCallId: string, toolName: string, output: unknown, preliminary = true): Part {
  return { type: `tool-${toolName}`, toolCallId, state: 'output-available', input: {}, output, preliminary } as Part
}

function reply(...parts: Part[]): HarnessUIMessage {
  return { id: 'msg_assistant0000001', role: 'assistant', parts }
}

const later = mcpElicitation({ id: elicitationId(2), expiresAt: 1_759_000_900_000 })
const sooner = mcpElicitation({ id: elicitationId(3), expiresAt: 1_759_000_100_000 })

describe('pendingElicitationsOf', () => {
  it('lists the input-required preliminary outputs of MCP tool parts, the oldest request first', () => {
    const message = reply(
      toolPart('call_a', 'mcp__fixture__ask', mcpToolProgress(later)),
      toolPart('call_b', 'mcp__docs__ask', mcpToolProgress(sooner)),
      // Not MCP, no longer waiting, a final output, an output that does not parse.
      toolPart('call_c', 'read_file', mcpToolProgress(mcpElicitation({ id: elicitationId(4) }))),
      toolPart('call_d', 'mcp__fixture__ask', mcpToolProgress(null)),
      toolPart('call_e', 'mcp__fixture__ask', mcpToolProgress(mcpElicitation({ id: elicitationId(5) })), false),
      toolPart('call_f', 'mcp__fixture__ask', { status: 'input-required', elicitation: { id: 'nope' } }),
    )
    expect(pendingElicitationsOf(message)).toEqual([
      { toolCallId: 'call_b', elicitation: sooner },
      { toolCallId: 'call_a', elicitation: later },
    ])
  })

  it('a user message or no message has none', () => {
    expect(pendingElicitationsOf(undefined)).toEqual([])
    expect(pendingElicitationsOf({ role: 'user', parts: [toolPart('call_a', 'mcp__fixture__ask', mcpToolProgress())] })).toEqual([])
  })
})

function source(open: McpElicitation[], respond: (id: string, answer: McpElicitationAnswerBody) => Promise<'answered' | 'gone'>) {
  return {
    chat: { messages: ref<HarnessUIMessage[]>([reply(toolPart('call_a', 'mcp__fixture__ask', mcpToolProgress(later)), toolPart('call_b', 'mcp__docs__ask', mcpToolProgress(sooner)))]) },
    elicitations: shallowRef<readonly McpElicitation[]>(open),
    respondElicitation: vi.fn(respond),
  }
}

describe('createToolElicitationContext', () => {
  it('forCall: the request a call waits on while the session lists it as open', () => {
    const session = source([later], async () => 'answered')
    const context = createToolElicitationContext(session)
    expect(context.forCall('call_a')).toEqual(later)
    // Answered in this session (no longer listed) or not a pending call.
    expect(context.forCall('call_b')).toBeNull()
    expect(context.forCall('call_x')).toBeNull()
    session.elicitations.value = []
    expect(context.forCall('call_a')).toBeNull()
  })

  it('respond: busy while posting; a gone answer is remembered', async () => {
    let finish: (value: 'answered' | 'gone') => void = () => {}
    const session = source([later], () => new Promise((resolve) => {
      finish = resolve
    }))
    const context = createToolElicitationContext(session)
    const answer: McpElicitationAnswerBody = { action: 'decline' }
    const pending = context.respond(later.id, answer)
    expect(context.busy(later.id)).toBe(true)
    expect(session.respondElicitation).toHaveBeenCalledWith(later.id, answer)
    finish('gone')
    await expect(pending).resolves.toBe('gone')
    expect(context.busy(later.id)).toBe(false)
    expect(context.gone(later.id)).toBe(true)
    expect(context.gone(sooner.id)).toBe(false)
  })

  it('respond: a 400 keeps its field issues and throws; the next answer clears them', async () => {
    const issues = [{ field: 'email', code: 'format', message: 'Enter an email address.' }]
    const session = source([later], async () => {
      throw new HarnessError({ code: 'validation_error', message: 'Invalid answer.', details: { issues } })
    })
    const context = createToolElicitationContext(session)
    await expect(context.respond(later.id, { action: 'accept', content: { email: 'x' } })).rejects.toMatchObject({ code: 'validation_error' })
    expect(context.issues(later.id)).toEqual(issues)
    expect(context.busy(later.id)).toBe(false)
    session.respondElicitation.mockImplementation(async () => 'answered')
    await expect(context.respond(later.id, { action: 'accept', content: { email: 'a@b.example' } })).resolves.toBe('answered')
    expect(context.issues(later.id)).toEqual([])
    expect(context.gone(later.id)).toBe(false)
  })
})
