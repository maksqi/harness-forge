// `todo_write` (W9.4, ADR-041, ARCHITECTURE.md 6.19): the execute (validation with the shared schema, unique ids, the
// output `{ todos, counts }`, the one-line model text) and `mock:todo` in-process over `POST /api/chat` in Ask (no
// approval anywhere, three states, an invalid list ends as the tool's error result while the run goes on), plus the
// branch-aware todo state (`latestTodos` of the stored path; nothing is stored elsewhere).
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ChatDetail, HarnessUIMessage, TodoItem, TodoWriteOutput } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { TestApp } from '../../testing/create-test-app.ts'
import { chatDetailSchema, HarnessError, latestTodos, LIMITS, todoWriteOutputSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from '../../chat/testing.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { MOCK_TODO_DONE, mockTodoList } from '../mock/todo.ts'
import { createTodoWriteTool, invalidTodoListError, TODO_WRITE_TOOL_NAME, todoWriteModelText, todoWriteOutput } from './todo-write.ts'

const CONTEXT = { chatId: testChatId(9400), modelRef: 'mock:todo', toolCallId: 'call_1', messages: [], signal: new AbortController().signal }

function item(id: string, status: TodoItem['status'], content = `Item ${id}`): TodoItem {
  return { id, content, status, activeForm: `Doing ${id}` }
}

/** `execute` as a promise (the widened plugin type also allows an async iterable). */
async function run(tool: ToolDefinition, input: unknown): Promise<unknown> {
  return await (tool.execute(input as never, CONTEXT) as Promise<unknown>)
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

describe('todo_write execute', () => {
  const tool = createTodoWriteTool() as unknown as ToolDefinition

  it('returns the validated list and its counts (todoWriteOutputSchema)', async () => {
    const todos = [item('1', 'completed'), item('2', 'in_progress'), item('3', 'pending'), item('4', 'pending')]
    const output = await run(tool, { todos })
    expect(output).toEqual({ todos, counts: { pending: 2, inProgress: 1, completed: 1, total: 4 } })
    expect(todoWriteOutputSchema.parse(output)).toEqual(output)
    expect(todoWriteModelText(output as TodoWriteOutput)).toBe('Todo list updated: 1 in progress, 2 pending, 1 completed.')
  })

  it('an empty list clears the todo list: zero counts, "Todo list cleared."', async () => {
    const output = await run(tool, { todos: [] })
    expect(output).toEqual({ todos: [], counts: { pending: 0, inProgress: 0, completed: 0, total: 0 } })
    const text = await tool.toModelOutput!(output, { toolCallId: 'call_1', input: { todos: [] } })
    expect(text).toEqual({ type: 'text', value: 'Todo list cleared.' })
  })

  it('keeps activeForm optional and drops unknown keys (the stored output is exactly the schema)', async () => {
    const output = await run(tool, { todos: [{ id: 'a', content: 'Write it', status: 'pending', extra: 'x' }], other: true })
    expect(output).toEqual({ todos: [{ id: 'a', content: 'Write it', status: 'pending' }], counts: { pending: 1, inProgress: 0, completed: 0, total: 1 } })
  })

  it('the full list of 50 items is accepted', async () => {
    const todos = Array.from({ length: LIMITS.todoItemsMax }, (_, index) => item(`t${index}`, 'pending'))
    expect(((await run(tool, { todos })) as TodoWriteOutput).counts.total).toBe(LIMITS.todoItemsMax)
  })

  it('refuses duplicate ids with a validation_error that names no todo text', async () => {
    const error = await rejection(run(tool, { todos: [item('1', 'pending', 'SECRET-ONE'), item('1', 'completed', 'SECRET-TWO')] }))
    expect(error.code).toBe('validation_error')
    expect(error.message).toBe('Invalid todo list: todos: Todo ids must be unique.')
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain('SECRET')
  })

  it.each([
    ['more than 50 items', { todos: Array.from({ length: LIMITS.todoItemsMax + 1 }, (_, index) => item(`t${index}`, 'pending')) }, ['todos']],
    ['a bad status', { todos: [{ id: '1', content: 'x', status: 'done' }] }, ['todos', 0, 'status']],
    ['an empty content', { todos: [{ id: '1', content: '', status: 'pending' }] }, ['todos', 0, 'content']],
    ['an id over 64 characters', { todos: [{ id: 'x'.repeat(65), content: 'x', status: 'pending' }] }, ['todos', 0, 'id']],
    ['an activeForm over 200 characters', { todos: [{ id: '1', content: 'x', status: 'pending', activeForm: 'y'.repeat(201) }] }, ['todos', 0, 'activeForm']],
    ['no list', {}, ['todos']],
    ['not an object', 'todos', []],
  ])('refuses %s', async (_name, input, path) => {
    const error = await rejection(run(tool, input))
    expect(error.code).toBe('validation_error')
    expect(error.message.startsWith('Invalid todo list: ')).toBe(true)
    expect((error.details as { issues: { path: unknown[] }[] }).issues[0]?.path).toEqual(path)
  })

  it('invalidTodoListError keeps the issues of the zod error', () => {
    const parsed = todoWriteOutputSchema.safeParse({ todos: 1, counts: {} })
    expect(parsed.success).toBe(false)
    const error = invalidTodoListError(parsed.error!)
    expect(error.message).toMatch(/^Invalid todo list: todos: /)
    expect((error.details as { issues: unknown[] }).issues.length).toBeGreaterThan(1)
  })

  it('todoWriteOutput is the same function the tool runs', async () => {
    const input = mockTodoList(1)
    expect(await run(tool, input)).toEqual(todoWriteOutput(input))
    expect(TODO_WRITE_TOOL_NAME).toBe('todo_write')
  })
})

/** The `tool-todo_write` parts of a message, as records. */
function todoParts(message: HarnessUIMessage | undefined): Record<string, unknown>[] {
  return (message?.parts ?? []).filter(part => part.type === 'tool-todo_write') as unknown as Record<string, unknown>[]
}

function approvalChunks(chunks: readonly UIMessageChunk[]): UIMessageChunk[] {
  return chunks.filter(chunk => chunk.type === 'tool-approval-request')
}

/** The expected output of call `index` (0-2) of the `mock:todo` script. */
function scriptOutput(index: number): TodoWriteOutput {
  return todoWriteOutput(mockTodoList(index))
}

describe('mock:todo in-process (Ask)', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
  })

  afterAll(async () => {
    await t.close()
  })

  async function detailOf(chatId: string): Promise<ChatDetail> {
    const response = await t.request(`/api/chats/${chatId}`)
    expect(response.status).toBe(200)
    return chatDetailSchema.parse(await response.json())
  }

  async function switchBranch(chatId: string, messageId: string): Promise<ChatDetail> {
    const response = await t.request(`/api/chats/${chatId}/branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId }) })
    expect(response.status).toBe(200)
    return chatDetailSchema.parse(await response.json())
  }

  it('runs three todo_write calls without an approval: pending, then 1/3 with item 2 in progress, then all completed', async () => {
    const chatId = testChatId(9401)
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'Do the three tasks', { modelRef: 'mock:todo', toolMode: 'ask' })))
    await runnerOf(t).idle()
    expect(approvalChunks(chunks)).toEqual([])
    const outputs = chunks.flatMap(chunk => (chunk.type === 'tool-output-available' ? [chunk.output] : []))
    expect(outputs).toEqual([scriptOutput(0), scriptOutput(1), scriptOutput(2)])
    expect(outputs.map(output => (output as TodoWriteOutput).counts)).toEqual([
      { pending: 3, inProgress: 0, completed: 0, total: 3 },
      { pending: 1, inProgress: 1, completed: 1, total: 3 },
      { pending: 0, inProgress: 0, completed: 3, total: 3 },
    ])
    expect(streamedText(chunks)).toBe(MOCK_TODO_DONE)

    const detail = await detailOf(chatId)
    expect(detail.pendingApproval).toBe(false)
    const reply = detail.messages.at(-1)!
    const parts = todoParts(reply)
    expect(parts.map(part => part.state)).toEqual(['output-available', 'output-available', 'output-available'])
    expect(parts.map(part => part.output)).toEqual([scriptOutput(0), scriptOutput(1), scriptOutput(2)])

    // The todo state is the last call on the path; a path that ends before a call shows the earlier state.
    const state = latestTodos(detail.messages)
    expect(state).toMatchObject({ todos: scriptOutput(2).todos, counts: { completed: 3, total: 3 }, messageIndex: detail.messages.length - 1, toolCallId: parts[2]!.toolCallId })
    const cutAfter = (count: number): HarnessUIMessage[] => {
      const index = reply.parts.indexOf(reply.parts.filter(part => part.type === 'tool-todo_write')[count - 1]!)
      return [...detail.messages.slice(0, -1), { ...reply, parts: reply.parts.slice(0, index + 1) }]
    }
    expect(latestTodos(cutAfter(1))?.todos).toEqual(scriptOutput(0).todos)
    expect(latestTodos(cutAfter(2))).toMatchObject({ todos: scriptOutput(1).todos, counts: { pending: 1, inProgress: 1, completed: 1 } })
    expect(latestTodos(cutAfter(2))?.todos.find(todo => todo.status === 'in_progress')?.activeForm).toBe('Changing the code')
    expect(latestTodos(detail.messages.slice(0, -1))).toBeNull()
  }, 20_000)

  it('an invalid list (duplicate ids) ends as the tool error result and the run goes on to "All 3 tasks done."', async () => {
    const chatId = testChatId(9402)
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'Do the tasks, invalid list first', { modelRef: 'mock:todo', toolMode: 'ask' })))
    await runnerOf(t).idle()
    expect(approvalChunks(chunks)).toEqual([])
    expect(chunks.some(chunk => chunk.type === 'tool-input-error' || chunk.type === 'tool-output-error')).toBe(true)
    expect(streamedText(chunks)).toBe(MOCK_TODO_DONE)

    const detail = await detailOf(chatId)
    const parts = todoParts(detail.messages.at(-1))
    expect(parts.map(part => part.state)).toEqual(['output-error', 'output-available', 'output-available', 'output-available'])
    expect(String(parts[0]!.errorText)).toMatch(/unique/i)
    expect(parts.slice(1).map(part => part.output)).toEqual([scriptOutput(0), scriptOutput(1), scriptOutput(2)])
    // The errored call never counts: the state is the last valid list.
    expect(latestTodos(detail.messages)?.todos).toEqual(scriptOutput(2).todos)
  }, 20_000)

  it('the todo state follows the active version (branch-aware; no separate storage)', async () => {
    const chatId = testChatId(9403)
    const reply = (id: string, outputs: TodoWriteOutput[]): HarnessUIMessage => ({
      id,
      role: 'assistant',
      metadata: { modelRef: 'mock:todo', startedAt: 2 },
      parts: [
        { type: 'step-start' },
        ...outputs.map((output, index) => ({ type: 'tool-todo_write', toolCallId: `${id}_call_${index}`, state: 'output-available', input: { todos: output.todos }, output })),
        { type: 'text', text: 'Done.', state: 'done' },
      ],
    }) as unknown as HarnessUIMessage
    const user = (id: string, text: string): HarnessUIMessage => ({ id, role: 'user', metadata: { modelRef: 'mock:todo', startedAt: 1 }, parts: [{ type: 'text', text }] })
    // A (1) -> RA (2): two calls (stopped before the third); A2 (3, an edit of A) -> RA2 (4): all three calls.
    const ids = ['msg_todo000000000001', 'msg_todo000000000002', 'msg_todo000000000003', 'msg_todo000000000004']
    await t.deps.chats.create({
      id: chatId,
      title: 'Todos',
      messages: [user(ids[0]!, 'first'), reply(ids[1]!, [scriptOutput(0), scriptOutput(1)]), user(ids[2]!, 'second'), reply(ids[3]!, [scriptOutput(0), scriptOutput(1), scriptOutput(2)])],
      parentIds: [null, ids[0]!, null, ids[2]!],
      activeLeafId: ids[3]!,
    })
    expect(latestTodos((await detailOf(chatId)).messages)?.counts).toEqual({ pending: 0, inProgress: 0, completed: 3, total: 3 })
    const first = await switchBranch(chatId, ids[0]!)
    expect(first.messages.map(message => message.id)).toEqual([ids[0], ids[1]])
    expect(latestTodos(first.messages)).toMatchObject({ todos: scriptOutput(1).todos, counts: { pending: 1, inProgress: 1, completed: 1, total: 3 }, toolCallId: `${ids[1]}_call_1` })
    expect(latestTodos((await switchBranch(chatId, ids[2]!)).messages)?.counts.completed).toBe(3)
  })

  it('logs no todo text at info or above', () => {
    const texts = ['Read the code', 'Change the code', 'Run the tests', 'Changing the code']
    const loud = t.logs.records.filter(record => record.level !== 'debug').map(record => JSON.stringify(record))
    for (const text of texts)
      expect(loud.filter(line => line.includes(text))).toEqual([])
  })
})
