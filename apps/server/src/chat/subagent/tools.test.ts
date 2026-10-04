// The tool set of a sub-agent (W9.5-T4, ADR-043): the tools per parent mode and task type, `task` never offered, every
// request for approval denied, the child's run scope (prefixed call ids, its own shell folder) and no agent scope.
import type { ToolCallContext, ToolDefinition, ToolPolicy, ToolWorkspaceAccess } from '@harness-forge/plugin-sdk'
import type { McpServer, TaskType, ToolMode, ToolOverride } from '@harness-forge/shared'
import type { ToolExecutionOptions } from 'ai'
import type { ToolPref } from '../../mcp/types.ts'
import type { ResolvedModel } from '../../providers/types.ts'
import type { RegisteredTool } from '../../registry/types.ts'
import type { WorkspaceRunScope, WorkspaceRunScopeInit } from '../../workspace/run-scope.ts'
import type { AgentRunScope } from '../agent-scope.ts'
import type { RunSession } from '../pipeline.ts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../../logger.ts'
import { createFakeCheckpointService } from '../../testing/fake-checkpoints.ts'
import { runScopeOf } from '../../workspace/run-scope.ts'
import { agentScopeOf } from '../agent-scope.ts'
import { DENIED_UNAVAILABLE } from '../approval.ts'
import { childCallIdPrefix, childRunScope, childToolMode, childTools, denyUserApproval, SUBAGENT_APPROVAL_DENIED_TEXT } from './tools.ts'

const MESSAGE_ID = 'msg_a000000000000001'
const PROJECT_ID = 'prj_0123456789abcdef'
const WORKSPACE = { projectId: PROJECT_ID, name: 'Demo', root: '/srv/projects/demo', instructions: '', projectFile: null }

type Seen = Array<{ name: string, c: ToolCallContext }>

function tool(pluginId: string, name: string, policy: ToolDefinition['policy'], workspace: ToolWorkspaceAccess | undefined, seen: Seen, mcpServerId: string | null = null): RegisteredTool {
  return {
    pluginId,
    mcpServerId,
    title: null,
    definition: {
      name,
      description: name,
      inputSchema: z.object({ command: z.string().optional(), path: z.string().optional() }),
      ...(policy === undefined ? {} : { policy }),
      ...(workspace === undefined ? {} : { workspace }),
      execute: async (_input: unknown, c: ToolCallContext) => {
        seen.push({ name, c })
        return 'ok'
      },
    },
  }
}

/** The shell policy of the tests: `safe` for `ls …` (a rule), else `ask` (like `shellPolicy`). */
const shellPolicy = (input: unknown): ToolPolicy => ((input as { command?: string }).command?.startsWith('ls') === true ? 'safe' : 'ask')

/** Every kind of tool the filters tell apart. */
function registry(seen: Seen): RegisteredTool[] {
  return [
    tool('core-tools', 'current_time', 'safe', undefined, seen),
    tool('core-tools', 'web_fetch', 'ask', undefined, seen),
    tool('core-tools', 'generate_image', 'ask', undefined, seen),
    tool('core-workspace', 'read_file', () => 'safe', 'read', seen),
    tool('core-workspace', 'list_directory', 'safe', 'read', seen),
    tool('core-workspace', 'write_file', () => 'ask', 'write', seen),
    tool('core-workspace', 'edit_file', 'ask', 'write', seen),
    tool('core-workspace', 'shell', shellPolicy, 'execute', seen),
    tool('acme', 'acme_safe', 'safe', undefined, seen),
    tool('acme', 'acme_always', 'always', undefined, seen),
    tool('acme', 'acme_default', undefined, undefined, seen),
    tool('core-mcp', 'mcp__srv__lookup', 'ask', undefined, seen, 'srv'),
    tool('core-agent', 'todo_write', 'safe', undefined, seen),
    tool('core-agent', 'exit_plan_mode', 'always', undefined, seen),
    tool('core-agent', 'task', 'safe', undefined, seen),
  ]
}

interface FakeSessionOptions {
  prefs?: Map<string, ToolPref>
  approveHook?: (input: { tool: string, toolCallId: string }) => void
}

function fakeSession(tools: RegisteredTool[], options: FakeSessionOptions = {}): RunSession {
  const servers = [{ id: 'srv', status: 'connected' }] as McpServer[]
  const deps = {
    registry: {
      tools: { list: () => tools, get: (name: string) => tools.find(entry => entry.definition.name === name), register: () => ({ dispose() {} }) },
      hooks: {
        run: async (name: string, input: { tool: string, toolCallId: string }) => {
          if (name === 'tool.approve')
            options.approveHook?.(input)
        },
        on: () => ({ dispose() {} }),
        list: () => [],
      },
    },
    plugins: {
      guard: async <T>(_pluginId: string, fn: (signal: AbortSignal) => T | Promise<T>) => fn(new AbortController().signal),
      isActive: () => true,
    },
    tools: { prefs: async () => options.prefs ?? new Map<string, ToolPref>() },
    mcp: { list: async () => servers },
    env: { workspaceShell: true },
  }
  return { chatId: 'chat', assistantId: MESSAGE_ID, ctx: { deps, logger: createSilentLogger() } } as unknown as RunSession
}

const MODEL = { modelRef: 'mock:subagent', providerId: 'mock', modelId: 'subagent', entry: { capabilities: { tools: true } } } as unknown as ResolvedModel

function parentScope(): WorkspaceRunScopeInit {
  const fake = createFakeCheckpointService()
  return {
    chatId: 'chat',
    messageId: MESSAGE_ID,
    projectId: PROJECT_ID,
    journal: fake.journal({ chatId: 'chat', messageId: MESSAGE_ID, projectId: PROJECT_ID }),
    shellRules: Object.freeze({ projectId: PROJECT_ID, prefixes: Object.freeze(['ls']) }),
    shellCwd: { current: 'src' },
  }
}

async function namesFor(toolMode: ToolMode, type: TaskType, options: FakeSessionOptions & { workspace?: boolean } = {}): Promise<string[]> {
  const seen: Seen = []
  const workspace = options.workspace ?? true
  const child = await childTools({
    session: fakeSession(registry(seen), options),
    type,
    toolMode,
    model: MODEL,
    workspace: workspace ? WORKSPACE : null,
    scope: workspace ? parentScope() : null,
    parentCallId: 'call_parent',
    signal: new AbortController().signal,
  })
  expect(Object.keys(child.tools).sort()).toEqual([...child.byName.keys()].sort())
  return Object.keys(child.tools).sort()
}

const READ_ONLY = ['acme_safe', 'current_time', 'list_directory', 'read_file']

describe('childTools: the tool set per parent mode and type', () => {
  it('ask: the safe tools and the read tools (explore and general alike)', async () => {
    expect(await namesFor('ask', 'general')).toEqual(READ_ONLY)
    expect(await namesFor('ask', 'explore')).toEqual(READ_ONLY)
  })

  it('edits: also the workspace writes and the shell (rule-matched commands run, the approval decides)', async () => {
    expect(await namesFor('edits', 'general')).toEqual(['acme_safe', 'current_time', 'edit_file', 'list_directory', 'read_file', 'shell', 'write_file'])
    expect(await namesFor('edits', 'explore')).toEqual(READ_ONLY)
  })

  it('auto: everything except the always tools, the agent tools and generate_image', async () => {
    expect(await namesFor('auto', 'general')).toEqual([
      'acme_default',
      'acme_safe',
      'current_time',
      'edit_file',
      'list_directory',
      'mcp__srv__lookup',
      'read_file',
      'shell',
      'web_fetch',
      'write_file',
    ])
    expect(await namesFor('auto', 'explore')).toEqual(READ_ONLY)
  })

  it('a parent in plan: read-only like ask, for both types', async () => {
    expect(await namesFor('plan', 'general')).toEqual(READ_ONLY)
    expect(await namesFor('plan', 'explore')).toEqual(READ_ONLY)
  })

  it('mode off and a chat without a workspace', async () => {
    expect(await namesFor('off', 'general')).toEqual([])
    expect(await namesFor('auto', 'general', { workspace: false })).toEqual(['acme_default', 'acme_safe', 'current_time', 'mcp__srv__lookup', 'web_fetch'])
  })

  it('task (and every core-agent tool) is never in a child set, in any mode', async () => {
    for (const mode of ['ask', 'edits', 'plan', 'auto'] as const) {
      for (const type of ['explore', 'general'] as const) {
        const names = await namesFor(mode, type)
        expect(names).not.toContain('task')
        expect(names).not.toContain('todo_write')
        expect(names).not.toContain('exit_plan_mode')
        expect(names).not.toContain('generate_image')
      }
    }
  })

  it('leaves out tools with a user override ask or deny; an allow override counts as approved', async () => {
    const prefs = new Map<string, ToolPref>([
      ['current_time', { enabled: true, override: 'ask' }],
      ['list_directory', { enabled: true, override: 'deny' }],
      ['web_fetch', { enabled: true, override: 'allow' }],
      ['acme_safe', { enabled: false, override: null }],
    ])
    expect(await namesFor('ask', 'general', { prefs })).toEqual(['read_file', 'web_fetch'])
  })

  it('the mode helpers', () => {
    expect(childToolMode('explore', 'auto')).toBe('ask')
    expect(childToolMode('general', 'plan')).toBe('ask')
    expect(childToolMode('general', 'edits')).toBe('edits')
    expect(childCallIdPrefix('call_1')).toBe('call_1/')
    expect(childRunScope(null)).toBeNull()
    expect(denyUserApproval('user-approval')).toEqual({ type: 'denied', reason: SUBAGENT_APPROVAL_DENIED_TEXT })
    expect(denyUserApproval({ type: 'user-approval', reason: 'why' })).toEqual({ type: 'denied', reason: SUBAGENT_APPROVAL_DENIED_TEXT })
    expect(denyUserApproval('not-applicable')).toBe('not-applicable')
    expect(denyUserApproval({ type: 'denied', reason: 'x' })).toEqual({ type: 'denied', reason: 'x' })
  })
})

describe('childTools: the approval function never asks', () => {
  async function child(toolMode: ToolMode, options: FakeSessionOptions = {}) {
    return childTools({
      session: fakeSession(registry([]), options),
      type: 'general',
      toolMode,
      model: MODEL,
      workspace: WORKSPACE,
      scope: parentScope(),
      parentCallId: 'call_parent',
      signal: new AbortController().signal,
    })
  }
  const call = (toolName: string, input: unknown = {}) => ({ toolCall: { toolName, toolCallId: 'c1', input }, messages: [] })

  it('runs what the parent would run without asking, denies the rest with the sub-agent reason', async () => {
    const edits = await child('edits')
    expect(await edits.toolApproval(call('shell', { command: 'ls -la' }))).toBe('not-applicable')
    expect(await edits.toolApproval(call('shell', { command: 'rm -rf build' }))).toEqual({ type: 'denied', reason: SUBAGENT_APPROVAL_DENIED_TEXT })
    expect(await edits.toolApproval(call('write_file', { path: 'a.txt' }))).toBe('not-applicable')
    expect(await edits.toolApproval(call('current_time'))).toBe('not-applicable')

    const auto = await child('auto')
    expect(await auto.toolApproval(call('shell', { command: 'rm -rf build' }))).toBe('not-applicable')
  })

  it('denies tools the child was not given (task included) instead of asking', async () => {
    const ask = await child('ask')
    expect(await ask.toolApproval(call('task'))).toEqual({ type: 'denied', reason: DENIED_UNAVAILABLE })
    expect(await ask.toolApproval(call('write_file'))).toEqual({ type: 'denied', reason: DENIED_UNAVAILABLE })
  })

  it('maps a hook ask to a denial; the hooks see the prefixed call id; a denied tool is not offered', async () => {
    const seen: string[] = []
    const prefs = new Map<string, ToolPref>([['web_fetch', { enabled: true, override: 'deny' as ToolOverride }]])
    const auto = await child('auto', { prefs, approveHook: input => seen.push(input.toolCallId) })
    expect(await auto.toolApproval(call('current_time'))).toBe('not-applicable')
    expect(seen).toEqual(['call_parent/c1'])
    expect(await auto.toolApproval(call('web_fetch'))).toEqual({ type: 'denied', reason: DENIED_UNAVAILABLE })

    // Without the override the same tool is offered in auto.
    const asking = await childTools({
      session: fakeSession(registry([])),
      type: 'general',
      toolMode: 'auto',
      model: MODEL,
      workspace: WORKSPACE,
      scope: parentScope(),
      parentCallId: 'call_parent',
      signal: new AbortController().signal,
    })
    expect(asking.byName.has('web_fetch')).toBe(true)
  })

  it('turns a hook decision ask into the sub-agent denial', async () => {
    const tools = registry([])
    const session = fakeSession(tools)
    const hooks = session.ctx.deps.registry.hooks as unknown as { run: (name: string, input: unknown, output: { decision?: string }) => Promise<void> }
    hooks.run = async (name, _input, output) => {
      if (name === 'tool.approve')
        output.decision = 'ask'
    }
    const auto = await childTools({ session, type: 'general', toolMode: 'auto', model: MODEL, workspace: WORKSPACE, scope: parentScope(), parentCallId: 'p', signal: new AbortController().signal })
    expect(await auto.toolApproval(call('current_time'))).toEqual({ type: 'denied', reason: SUBAGENT_APPROVAL_DENIED_TEXT })
  })
})

describe('childTools: the child run scope (journal ids, shell folder, depth)', () => {
  it('binds the parent scope with <parent>/<child> call ids and a copy of the shell folder, and no agent scope', async () => {
    const seen: Seen = []
    const scope = parentScope()
    const child = await childTools({
      session: fakeSession(registry(seen)),
      type: 'general',
      toolMode: 'edits',
      model: MODEL,
      workspace: WORKSPACE,
      scope,
      parentCallId: 'call_parent',
      signal: new AbortController().signal,
    })
    const options: ToolExecutionOptions<unknown> = { toolCallId: 'c1', messages: [], context: undefined }
    await child.tools.shell!.execute!({ command: 'cd lib' }, options)
    await child.tools.write_file!.execute!({ path: 'a.txt' }, { ...options, toolCallId: 'c2' })
    const [shell, write] = seen
    const shellScope = runScopeOf(shell!.c) as WorkspaceRunScope
    expect(shell!.c.toolCallId).toBe('call_parent/c1')
    expect(shellScope.toolCallId).toBe('call_parent/c1')
    expect(runScopeOf(write!.c)?.toolCallId).toBe('call_parent/c2')
    expect(shellScope.messageId).toBe(MESSAGE_ID)
    expect(shellScope.journal).toBe(scope.journal)
    // The child's folder is its own object: a cd inside the child never moves the parent's.
    expect(shellScope.shellCwd).not.toBe(scope.shellCwd)
    expect(shellScope.shellCwd.current).toBe('src')
    shellScope.shellCwd.current = 'src/lib'
    expect(scope.shellCwd.current).toBe('src')
    expect(runScopeOf(write!.c)?.shellCwd).toBe(shellScope.shellCwd)
    // Depth 1: no agent scope in a child's call.
    const agent: AgentRunScope | null = agentScopeOf(shell!.c)
    expect(agent).toBeNull()
  })
})

describe('childTools: skill (Phase 10)', () => {
  it('task and skill are never in a child\'s set, in any mode', async () => {
    for (const toolMode of ['ask', 'edits', 'auto', 'plan'] as const) {
      for (const type of ['explore', 'general'] as const) {
        const seen: Seen = []
        const child = await childTools({
          session: fakeSession([...registry(seen), tool('core-agent', 'skill', 'safe', undefined, seen)]),
          type,
          toolMode,
          model: MODEL,
          workspace: WORKSPACE,
          scope: parentScope(),
          parentCallId: 'call_parent',
          signal: new AbortController().signal,
        })
        const names = Object.keys(child.tools)
        expect(names).not.toContain('task')
        expect(names).not.toContain('skill')
      }
    }
  })
})
