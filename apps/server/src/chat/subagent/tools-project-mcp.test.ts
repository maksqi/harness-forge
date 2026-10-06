// Sub-agents of a project chat get the parent run's project MCP result (W11.17, ADR-050), end to end over
// `POST /api/chat` with the C36 fake project MCP manager (`createTestApp({ projectMcp: 'fake' })`) and a scripted
// test-kit model: a global MCP server the project shadows is never offered to a foreground or a background child, the
// project server tools join the child's set under the child ceiling (in Ask only those that run without approval), and
// `toolsFor` is asked once per parent run (the children reuse its answer).
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ChatRequestBody, McpServer } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeProjectMcpManager } from '../../testing/fake-project-mcp.ts'
import type { FakeProjectService } from '../../testing/fake-projects.ts'
import { LIMITS } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createInertMcpManager } from '../../plugins/drafts/testing.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { fakeProjectMcpTool, fakeProjectMcpTools } from '../../testing/fake-project-mcp.ts'
import { createFakeProjectService } from '../../testing/fake-projects.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../markers.ts'
import { chatBody, postChat, readSse, runnerOf, testChatId } from '../testing.ts'

let nextChat = 11_700

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

function finishPart(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]
}

function toolNames(call: LanguageModelV4CallOptions | undefined): string[] {
  return (call?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.name] : [])).sort()
}

function isChild(options: LanguageModelV4CallOptions): boolean {
  return options.prompt.some(message => message.role === 'system' && message.content.includes(SUBAGENT_INSTRUCTIONS_MARKER))
}

function mcpNames(call: LanguageModelV4CallOptions | undefined): string[] {
  return toolNames(call).filter(name => name.startsWith('mcp__'))
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs)
      throw new Error('Timed out waiting for the condition.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('sub-agents and project MCP servers (W11.17)', () => {
  let t: TestApp
  let projectMcp: FakeProjectMcpManager
  let projects: FakeProjectService
  const disposables: Disposable[] = []
  /** Every model call of the parent runs and of the children, in order. */
  const parentCalls: LanguageModelV4CallOptions[] = []
  const childCalls: LanguageModelV4CallOptions[] = []
  let background = false

  beforeAll(async () => {
    // The global MCP server `srv` is connected (the registry offers its tool) unless a project shadows it.
    const servers = [{ id: 'srv', status: 'connected' }] as McpServer[]
    t = await createTestApp({
      env: { HF_MOCK_PROVIDER: '1' },
      hooks: 'fake',
      projectTrust: 'fake',
      projectMcp: 'fake',
      overrides: { mcp: { ...createInertMcpManager(), list: async () => servers } },
      factories: { projects: createFakeProjectService },
    })
    projectMcp = t.deps.projectMcp as FakeProjectMcpManager
    projects = t.deps.projects as FakeProjectService
    const model: LanguageModelV4 = new MockLanguageModelV4({
      doStream: async (options) => {
        if (isChild(options)) {
          childCalls.push(options)
          return { stream: convertArrayToReadableStream(textParts('child report')) }
        }
        parentCalls.push(options)
        const answered = options.prompt.some(message => message.role === 'tool')
        const parts: LanguageModelV4StreamPart[] = answered
          ? textParts('done')
          : [{ type: 'tool-call', toolCallId: 'call_task', toolName: 'task', input: JSON.stringify({ description: 'Look around', prompt: 'Look around.', type: 'general', ...(background ? { background: true } : {}) }) }, finishPart('tool-calls')]
        return { stream: convertArrayToReadableStream(parts) }
      },
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Title' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    })
    disposables.push(t.deps.registry.providers.register('mock', {
      id: 'subkit',
      name: 'Sub kit',
      credentials: [],
      seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 64_000, capabilities: { tools: true } }],
      createLanguageModel: () => model,
    }))
    disposables.push(t.deps.registry.tools.register('mock', {
      name: 'mcp__srv__lookup',
      description: 'The lookup tool of the global server srv.',
      inputSchema: z.object({}),
      policy: 'safe',
      execute: async () => 'global lookup',
    }, { mcpServerId: 'srv' }))
  })

  beforeEach(() => {
    parentCalls.length = 0
    childCalls.length = 0
    background = false
    projectMcp.tools.clear()
    projectMcp.toolsCalls.length = 0
  })

  afterAll(async () => {
    for (const disposable of disposables)
      disposable.dispose()
    await t.close()
  })

  function body(chatId: string, overrides: Partial<ChatRequestBody> = {}): ChatRequestBody {
    return chatBody(chatId, 'delegate', { modelRef: 'subkit:agent', toolMode: 'ask', ...overrides })
  }

  async function post(request: ChatRequestBody): Promise<void> {
    await readSse(await postChat(t, request))
    await runnerOf(t).idle()
  }

  async function projectWithShadowingServer(): Promise<string> {
    const project = await projects.add({ name: 'Mcp' })
    projectMcp.tools.set(project.id, fakeProjectMcpTools(
      [fakeProjectMcpTool('docs', 'search', { policy: 'safe' }), fakeProjectMcpTool('docs', 'write')],
      { shadowed: ['srv'], names: { docs: 'Docs' } },
    ))
    return project.id
  }

  it('a chat without a project: the child sees the global server (control)', async () => {
    await post(body(newChatId()))
    expect(mcpNames(parentCalls[0])).toEqual(['mcp__srv__lookup'])
    expect(childCalls).toHaveLength(1)
    expect(mcpNames(childCalls[0])).toEqual(['mcp__srv__lookup'])
    expect(projectMcp.toolsCalls).toEqual([])
  })

  it('a foreground child never sees a shadowed global server; project tools follow the child ceiling', async () => {
    const projectId = await projectWithShadowingServer()
    await post(body(newChatId(), { projectId }))
    // The parent (Ask) offers both project tools (an `ask` tool asks there); the child only the one that runs as is.
    expect(mcpNames(parentCalls[0])).toEqual(['mcp__docs__search', 'mcp__docs__write'])
    expect(childCalls).toHaveLength(1)
    expect(mcpNames(childCalls[0])).toEqual(['mcp__docs__search'])
    // One `toolsFor` per parent run: the child reuses its answer.
    expect(projectMcp.toolsCalls).toEqual([{ projectId, waitMs: LIMITS.projectMcpConnectWaitMs }])

    // Auto: the child also gets the project tool that would ask; the shadowed server stays hidden.
    childCalls.length = 0
    await post(body(newChatId(), { projectId, toolMode: 'auto' }))
    expect(mcpNames(childCalls[0])).toEqual(['mcp__docs__search', 'mcp__docs__write'])
  })

  it('a background child gets the launching run\'s project MCP result too', async () => {
    const projectId = await projectWithShadowingServer()
    background = true
    await post(body(newChatId(), { projectId }))
    await waitFor(() => childCalls.length > 0)
    expect(mcpNames(childCalls[0])).toEqual(['mcp__docs__search'])
    expect(toolNames(childCalls[0])).not.toContain('task')
    expect(projectMcp.toolsCalls.every(call => call.projectId === projectId)).toBe(true)
  })
})
