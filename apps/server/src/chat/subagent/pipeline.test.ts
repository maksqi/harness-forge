// Sub-agents end to end in-process (W9.5, ADR-043) over `POST /api/chat` with `mock:subagent` as the chat model and
// `subagentModelRef` (PROVIDERS.md 8), the real `core-agent` and `core-workspace` tools, the real checkpoint journal and
// a fake project service with real temp folders:
// - two parallel `task` calls in Ask: preliminary outputs before the final ones, no approval request anywhere, the
//   parent quotes both reports, a child is never offered `task`, `write_file` (in Ask) or `shell`, one usage row per
//   child;
// - Accept edits with `write`: the `general` child writes, journaled under the reply with `<parent>/<child>` call ids;
// - `parallel 5`: never more than three children at once;
// - `subagentMaxSteps: 2` with `loop`: the children end as `limit`;
// - Stop mid-children: the stored task parts are errors (no preliminary output survives).
import type { ChatDetail, HarnessUIMessage, TaskOutput } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeProjectService } from '../../testing/fake-projects.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chatDetailSchema, LIMITS } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MOCK_SUBAGENT_CONTENT, MOCK_SUBAGENT_FILE } from '../../builtin-plugins/mock/subagent.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeProjectService } from '../../testing/fake-projects.ts'
import { STOPPED_TOOL_TEXT } from '../history.ts'
import { chatBody, postChat, readSse, readUntil, runnerOf, streamedText, testChatId } from '../testing.ts'

let nextChat = 9500

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

async function detailOf(t: TestApp, chatId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

type ToolPartValue = Record<string, unknown> & { type: string, state: string, toolCallId: string, output?: unknown, preliminary?: boolean }

function taskParts(message: HarnessUIMessage | undefined): ToolPartValue[] {
  return (message?.parts ?? []).filter(part => part.type === 'tool-task') as unknown as ToolPartValue[]
}

function taskOutputs(chunks: readonly UIMessageChunk[], taskIds: ReadonlySet<string>): Array<{ preliminary: boolean, output: TaskOutput }> {
  return chunks.flatMap(chunk => (chunk.type === 'tool-output-available' && taskIds.has(chunk.toolCallId)
    ? [{ preliminary: chunk.preliminary === true, output: chunk.output as TaskOutput }]
    : []))
}

function taskCallIds(chunks: readonly UIMessageChunk[]): Set<string> {
  return new Set(chunks.flatMap(chunk => (chunk.type === 'tool-input-available' && chunk.toolName === 'task' ? [chunk.toolCallId] : [])))
}

async function usagePurposes(t: TestApp, chatId: string): Promise<string[]> {
  const result = await t.database.client.execute({ sql: 'SELECT purpose, model_id FROM usage WHERE chat_id = ? ORDER BY id', args: [chatId] })
  return result.rows.map(row => `${String(row.purpose)}:${String(row.model_id)}`)
}

describe('sub-agents through POST /api/chat (mock:subagent)', () => {
  let t: TestApp
  let projects: FakeProjectService
  let projectId: string
  let projectPath: string

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, factories: { projects: createFakeProjectService } })
    projects = t.deps.projects as FakeProjectService
    const project = await projects.add({ name: 'Demo', files: { 'README.md': 'Demo project.\n' } })
    projectId = project.id
    projectPath = project.path
  })

  beforeEach(async () => {
    await t.deps.settings.update({ subagentModelRef: 'mock:subagent', subagentMaxSteps: 30 })
  })

  afterAll(async () => {
    await t.close()
  })

  it('ask: two parallel children stream progress, never ask, and the parent quotes both reports', async () => {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'Look around.', { modelRef: 'mock:subagent', toolMode: 'ask', projectId })))
    await runnerOf(t).idle()

    const ids = taskCallIds(chunks)
    expect(ids.size).toBe(2)
    expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    const outputs = taskOutputs(chunks, ids)
    for (const id of ids) {
      const own = chunks.filter(chunk => chunk.type === 'tool-output-available' && chunk.toolCallId === id) as Array<Extract<UIMessageChunk, { type: 'tool-output-available' }>>
      expect(own.at(0)?.preliminary).toBe(true)
      expect(own.at(-1)?.preliminary).not.toBe(true)
    }
    const finals = outputs.filter(entry => !entry.preliminary).map(entry => entry.output)
    expect(finals.map(output => output.status)).toEqual(['completed', 'completed'])
    for (const output of finals) {
      expect(output.modelRef).toBe('mock:subagent')
      expect(output.report).toMatch(/^Report: /)
      const offered = output.report.split('| tools: ')[1] ?? ''
      expect(offered).toContain('list_directory')
      for (const name of ['task', 'write_file', 'edit_file', 'shell', 'todo_write', 'exit_plan_mode'])
        expect(offered.split(', ')).not.toContain(name)
      expect(output.steps).toEqual([expect.objectContaining({ toolName: 'list_directory', state: 'done', summary: '.' })])
    }

    const text = streamedText(chunks)
    expect(text).toMatch(/^Reports: Report: List the project files\. \| tools: .+ \|\| Report: Check the time\. \| tools: .+$/)

    const detail = await detailOf(t, chatId)
    expect(detail.pendingApproval).toBe(false)
    const reply = detail.messages.at(-1)
    const parts = taskParts(reply)
    expect(parts.map(part => part.state)).toEqual(['output-available', 'output-available'])
    expect(parts.every(part => part.preliminary !== true)).toBe(true)
    expect(JSON.stringify(reply?.parts)).not.toContain('approval-requested')
    expect(await usagePurposes(t, chatId)).toEqual(expect.arrayContaining(['subagent:subagent', 'subagent:subagent', 'chat:subagent']))
    expect((await usagePurposes(t, chatId)).filter(row => row.startsWith('subagent:'))).toHaveLength(2)
  })

  it('accept edits: a general child writes; the change is journaled under the reply with a <parent>/<child> call id', async () => {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'Please write the notes.', { modelRef: 'mock:subagent', toolMode: 'edits', projectId })))
    await runnerOf(t).idle()
    expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    expect(await readFile(join(projectPath, MOCK_SUBAGENT_FILE), 'utf8')).toBe(MOCK_SUBAGENT_CONTENT)

    const reply = (await detailOf(t, chatId)).messages.at(-1)!
    const [explore, general] = taskParts(reply).map(part => part.output as TaskOutput)
    expect(explore?.steps.map(step => step.toolName)).toEqual(['list_directory'])
    expect(general?.steps.map(step => `${step.toolName}:${step.state}`)).toEqual(['list_directory:done', 'write_file:done'])

    const rows = await t.database.client.execute({ sql: 'SELECT message_id, tool_call_id, kind, path FROM workspace_changes WHERE chat_id = ?', args: [chatId] })
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]!
    expect(row.message_id).toBe(reply.id)
    expect(String(row.tool_call_id)).toMatch(/^mock_call_1_2\/mock_call_2$/)
    expect(row.path).toBe(MOCK_SUBAGENT_FILE)
  })

  it(`parallel 5: never more than ${LIMITS.subagentParallelMax} children at once, the others wait as queued`, async () => {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'parallel 5', { modelRef: 'mock:subagent', toolMode: 'ask', projectId })))
    await runnerOf(t).idle()
    const ids = taskCallIds(chunks)
    expect(ids.size).toBe(5)
    const outputs = taskOutputs(chunks, ids)
    expect(outputs.some(entry => entry.output.status === 'queued')).toBe(true)
    const finals = taskParts((await detailOf(t, chatId)).messages.at(-1)).map(part => part.output as TaskOutput)
    expect(finals.map(output => output.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed'])
    const events = finals.flatMap(output => [{ at: output.startedAt, delta: 1 }, { at: output.finishedAt!, delta: -1 }])
    events.sort((a, b) => a.at - b.at || a.delta - b.delta)
    let running = 0
    let peak = 0
    for (const event of events) {
      running += event.delta
      peak = Math.max(peak, running)
    }
    expect(peak).toBeLessThanOrEqual(LIMITS.subagentParallelMax)
    expect((await usagePurposes(t, chatId)).filter(row => row.startsWith('subagent:'))).toHaveLength(5)
  })

  it('subagentMaxSteps 2 stops a loop child at the finalize step with status limit', async () => {
    await t.deps.settings.update({ subagentMaxSteps: 2 })
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'loop please', { modelRef: 'mock:subagent', toolMode: 'ask', projectId })))
    await runnerOf(t).idle()
    const finals = taskParts((await detailOf(t, chatId)).messages.at(-1)).map(part => part.output as TaskOutput)
    expect(finals.map(output => output.status)).toEqual(['limit', 'limit'])
    for (const output of finals) {
      expect(output.report).toMatch(/\| tools: none$/)
      expect(output.steps).toHaveLength(1)
    }
    expect(streamedText(chunks)).toMatch(/^Reports: Report: List the project files\. loop please \| tools: none \|\| /)
  })

  it('stop mid-children: the stored task parts are errors and no preliminary output survives', async () => {
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'loop forever', { modelRef: 'mock:subagent', toolMode: 'ask', projectId }))
    const partial = await readUntil(response, chunks => chunks.some(chunk => chunk.type === 'tool-output-available' && chunk.preliminary === true))
    expect(partial.chunks.some(chunk => chunk.type === 'tool-output-available' && chunk.preliminary === true)).toBe(true)
    expect(await runnerOf(t).stop(chatId)).toBe(true)
    await runnerOf(t).idle()
    const reply = (await detailOf(t, chatId)).messages.at(-1)!
    expect(reply.metadata?.aborted).toBe(true)
    const parts = taskParts(reply)
    expect(parts).toHaveLength(2)
    for (const part of parts) {
      expect(part.state).toBe('output-error')
      expect(part.preliminary).toBeUndefined()
      expect(part.output).toBeUndefined()
    }
    expect(parts.some(part => part.errorText === STOPPED_TOOL_TEXT || part.errorText === 'The run was stopped.')).toBe(true)
  })
})
