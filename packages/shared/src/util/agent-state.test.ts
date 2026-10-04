import type { CompactionData, HarnessUIMessage, HarnessUIMessagePart, SteerData } from '../chat.ts'
import type { TodoItem } from '../schemas/agent.ts'
import type { AgentStateMessage, AgentStatePart } from './agent-state.ts'
import { describe, expect, it } from 'vitest'
import { steerDataSchema } from '../chat.ts'
import {
  compactionCutoff,
  compactionMarkers,
  countTodos,
  findCompaction,
  isContentPart,
  latestTodos,
  NON_CONTENT_PART_TYPES,
  splitSteers,
  splitTaskResults,
  TASK_RESULT_PART_TYPE,
  taskResultText,
} from './agent-state.ts'

// ---------------------------------------------------------------------------------------------------------------------
// Builders

const AT = 1_790_000_000_000

function msgId(n: number): string {
  return `msg_${String(n).padStart(16, '0')}`
}

function compaction(overrides: Partial<CompactionData> = {}): CompactionData {
  return {
    trigger: 'manual',
    keep: 'none',
    summary: 'The user is fixing the parser.',
    modelRef: 'mock:compact',
    messagesCompacted: 4,
    tokensBefore: 1800,
    tokensAfter: 120,
    createdAt: AT,
    ...overrides,
  }
}

function marker(data: unknown = compaction(), id?: string): HarnessUIMessagePart {
  return (id === undefined ? { type: 'data-compaction', data } : { type: 'data-compaction', id, data }) as HarnessUIMessagePart
}

function steerData(id: string, text: string): SteerData {
  return { id, parts: [{ type: 'text', text }], queuedAt: AT, deliveredAt: AT + 1 }
}

function steer(data: unknown): HarnessUIMessagePart {
  return { type: 'data-steer', data } as HarnessUIMessagePart
}

const STEP: HarnessUIMessagePart = { type: 'step-start' }

function text(value: string): HarnessUIMessagePart {
  return { type: 'text', text: value }
}

function notice(): HarnessUIMessagePart {
  return { type: 'data-notice', data: { level: 'warning', code: 'context-trimmed', message: 'Trimmed.' } }
}

function toolPart(name: string, callId: string, extra: Record<string, unknown> = {}): HarnessUIMessagePart {
  return { type: `tool-${name}`, toolCallId: callId, state: 'output-available', input: {}, output: { ok: true }, ...extra } as HarnessUIMessagePart
}

function user(id: string, ...parts: HarnessUIMessagePart[]): HarnessUIMessage {
  return { id, role: 'user', parts: parts.length > 0 ? parts : [text(`question ${id}`)], metadata: { modelRef: 'mock:echo', startedAt: AT } }
}

function assistant(id: string, ...parts: HarnessUIMessagePart[]): HarnessUIMessage {
  return { id, role: 'assistant', parts, metadata: { modelRef: 'mock:echo', startedAt: AT, finishReason: 'stop' } }
}

function todo(id: string, status: TodoItem['status'], content = `Task ${id}`): TodoItem {
  return { id, content, status }
}

function todoPart(callId: string, todos: TodoItem[], extra: Record<string, unknown> = {}): HarnessUIMessagePart {
  return toolPart('todo_write', callId, { input: { todos }, output: { todos, counts: countTodos(todos) }, ...extra })
}

// ---------------------------------------------------------------------------------------------------------------------
// Types

describe('types', () => {
  it('accepts harness UI messages and returns them typed', () => {
    const path: HarnessUIMessage[] = [user('u1'), assistant('a1', STEP, text('hi'))]
    const split: HarnessUIMessage[] = splitSteers(path)
    const structural: AgentStateMessage[] = path
    expect(split).toEqual(path)
    expect(findCompaction(structural)).toBeNull()
  })

  it('classifies content parts', () => {
    expect([...NON_CONTENT_PART_TYPES].sort()).toEqual(['data-activity', 'data-notice', 'step-start'])
    expect(isContentPart({ type: 'step-start' })).toBe(false)
    expect(isContentPart({ type: 'data-notice' })).toBe(false)
    expect(isContentPart({ type: 'data-activity' })).toBe(false)
    for (const type of ['text', 'reasoning', 'file', 'tool-shell', 'dynamic-tool', 'data-steer', 'data-compaction', 'source-url'])
      expect(isContentPart({ type })).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Compaction

describe('findCompaction', () => {
  it('returns null without markers', () => {
    expect(findCompaction([])).toBeNull()
    expect(findCompaction([user('u1'), assistant('a1', STEP, text('hello'))])).toBeNull()
    expect(compactionMarkers([user('u1'), assistant('a1', text('x'))])).toEqual([])
    expect(compactionCutoff([user('u1')])).toBeNull()
  })

  it('finds a manual /compact reply (keep: none)', () => {
    const data = compaction({ focus: 'tests' })
    const path = [user('u1'), assistant('a1', text('one')), user('u2', text('/compact tests')), assistant('a2', marker(data, 'cmp1')), user('u3'), assistant('a3', STEP, text('two'))]
    expect(findCompaction(path)).toEqual({ messageIndex: 3, partIndex: 0, data, keptUserIndex: null })
    expect(compactionMarkers(path)).toEqual([{ messageIndex: 3, partIndex: 0, data, partId: 'cmp1', inline: false }])
    // The model sees the summary, then u3 and a3: the cutoff is the part after the marker (the end of a2).
    expect(compactionCutoff(path)).toEqual({ messageIndex: 3, partIndex: 1 })
  })

  it('keeps the last user message before the marker (keep: last-user, before the first step)', () => {
    const data = compaction({ trigger: 'auto', keep: 'last-user' })
    const path = [user('u1'), assistant('a1', text('one')), user('u2'), assistant('a2', marker(data), STEP, text('answer'))]
    expect(findCompaction(path)).toEqual({ messageIndex: 3, partIndex: 0, data, keptUserIndex: 2 })
    expect(compactionMarkers(path)[0]).toMatchObject({ messageIndex: 3, partIndex: 0, partId: null, inline: false })
    expect(compactionCutoff(path)).toEqual({ messageIndex: 2, partIndex: 0 })
  })

  it('finds an in-run marker at part p (inline)', () => {
    const data = compaction({ trigger: 'auto', keep: 'last-user' })
    const parts = [STEP, text('step 1'), toolPart('read_file', 'c1'), STEP, marker(data, 'auto1'), text('step 2')]
    const path = [user('u1'), assistant('a1', ...parts)]
    expect(findCompaction(path)).toEqual({ messageIndex: 1, partIndex: 4, data, keptUserIndex: 0 })
    expect(compactionMarkers(path)).toEqual([{ messageIndex: 1, partIndex: 4, data, partId: 'auto1', inline: true }])
    expect(compactionCutoff(path)).toEqual({ messageIndex: 0, partIndex: 0 })
  })

  it('treats a marker after only step boundaries, notices and activity as not inline', () => {
    const path = [user('u1'), assistant('a1', STEP, notice(), { type: 'data-activity', data: { kind: 'idle' } } as HarnessUIMessagePart, marker(), text('x'))]
    expect(compactionMarkers(path)[0]!.inline).toBe(false)
  })

  it('returns the latest of several markers and lists all of them in path order', () => {
    const first = compaction({ summary: 'first' })
    const second = compaction({ summary: 'second', trigger: 'auto', keep: 'last-user' })
    const third = compaction({ summary: 'third', trigger: 'auto', keep: 'none' })
    const path = [
      user('u1'),
      assistant('a1', marker(first)),
      user('u2'),
      assistant('a2', STEP, text('a'), marker(second), STEP, text('b'), marker(third), text('c')),
    ]
    expect(findCompaction(path)).toMatchObject({ messageIndex: 3, partIndex: 5, keptUserIndex: null, data: { summary: 'third' } })
    expect(compactionMarkers(path).map(item => [item.messageIndex, item.partIndex, item.data.summary, item.inline])).toEqual([
      [1, 0, 'first', false],
      [3, 2, 'second', true],
      [3, 5, 'third', true],
    ])
    expect(compactionCutoff(path)).toEqual({ messageIndex: 3, partIndex: 6 })
  })

  it('is branch-aware: only the given path counts', () => {
    const u1 = user('u1')
    const compacted = assistant('a1', marker())
    const regenerated = assistant('a1b', STEP, text('no marker'))
    // The branch through the regenerated reply does not see the old reply's marker.
    expect(findCompaction([u1, compacted, user('u2')])).not.toBeNull()
    expect(findCompaction([u1, regenerated, user('u2')])).toBeNull()
    // An edit above the marker (a sibling of u2) gets the full history back.
    expect(findCompaction([u1])).toBeNull()
  })

  it('skips invalid marker data and falls back to the previous marker', () => {
    const valid = compaction({ summary: 'valid' })
    const invalid = [
      null,
      'summary',
      { ...valid, summary: 'x'.repeat(60_001) },
      { ...valid, trigger: 'later' },
      { ...valid, keep: 'all' },
      { ...valid, modelRef: 'no-colon' },
      { ...valid, tokensBefore: -1 },
      { ...valid, createdAt: 1.5 },
      { ...valid, todos: [{ id: '', content: 'x', status: 'pending' }] },
    ]
    const parts = [...invalid.map(data => marker(data)), { type: 'data-compaction' } as HarnessUIMessagePart]
    for (const part of parts) {
      const path = [user('u1'), assistant('a1', marker(valid)), user('u2'), assistant('a2', STEP, part, text('x'))]
      expect(findCompaction(path), JSON.stringify(part)).toMatchObject({ messageIndex: 1, partIndex: 0, data: { summary: 'valid' } })
      expect(compactionMarkers(path)).toHaveLength(1)
    }
  })

  it('ignores markers outside assistant messages and malformed messages', () => {
    const path = [
      { id: 'u1', role: 'user', parts: [marker()] },
      { id: 's1', role: 'system', parts: [marker()] },
      { id: 'a1', role: 'assistant', parts: 'not-an-array' },
      { id: 'a2', role: 'assistant', parts: [null, 7, 'text', { type: 5 }, { kind: 'data-compaction' }] },
      null,
    ] as unknown as AgentStateMessage[]
    expect(findCompaction(path)).toBeNull()
    expect(compactionMarkers(path)).toEqual([])
    expect(compactionCutoff(path)).toBeNull()
    expect(findCompaction('nope' as unknown as AgentStateMessage[])).toBeNull()
    expect(compactionMarkers(undefined as unknown as AgentStateMessage[])).toEqual([])
  })

  it('keptUserIndex is null for last-user without a user message before the marker', () => {
    const data = compaction({ keep: 'last-user' })
    const path = [assistant('a0', text('greeting')), assistant('a1', STEP, text('x'), marker(data), text('y'))]
    expect(findCompaction(path)).toMatchObject({ messageIndex: 1, partIndex: 2, keptUserIndex: null })
    expect(compactionCutoff(path)).toEqual({ messageIndex: 1, partIndex: 3 })
  })

  it('keeps the last user message even when assistant messages sit between it and the marker', () => {
    const data = compaction({ keep: 'last-user' })
    const path = [user('u1'), user('u2'), assistant('a1', text('x')), assistant('a2', marker(data))]
    expect(findCompaction(path)?.keptUserIndex).toBe(1)
  })

  it('returns the parsed data with optional fields', () => {
    const data = compaction({ focus: 'keep numbers', todos: [todo('t1', 'in_progress')] })
    expect(findCompaction([user('u1'), assistant('a1', marker(data))])?.data).toEqual(data)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Steers

describe('splitSteers', () => {
  it('returns a new array with the same objects when nothing is steered', () => {
    const path = [user('u1'), assistant('a1', STEP, text('x')), user('u2'), assistant('a2', STEP)]
    const result = splitSteers(path)
    expect(result).not.toBe(path)
    expect(result).toHaveLength(4)
    result.forEach((message, index) => expect(message).toBe(path[index]))
    expect(splitSteers([])).toEqual([])
  })

  it('splits a reply at one steer on a step boundary', () => {
    const s = steerData(msgId(1), 'Use the vitest filter')
    const call = toolPart('shell', 'c1')
    const reply = assistant('a1', STEP, text('Running tests'), call, steer(s), STEP, text('Switching'))
    const result = splitSteers([user('u1'), reply])
    expect(result).toEqual([
      user('u1'),
      { ...reply, id: 'a1', parts: [STEP, text('Running tests'), call] },
      { id: msgId(1), role: 'user', parts: [{ type: 'text', text: 'Use the vitest filter' }] },
      { ...reply, id: 'a1~1', parts: [STEP, text('Switching')] },
    ])
    // The user half has no metadata; assistant halves keep the original metadata object.
    expect('metadata' in result[2]!).toBe(false)
    expect(result[1]!.metadata).toBe(reply.metadata)
    expect(result[3]!.metadata).toBe(reply.metadata)
    // Part objects are kept by reference.
    expect(result[1]!.parts[2]).toBe(call)
  })

  it('splits several steers in one message, in order', () => {
    const s1 = steerData(msgId(1), 'first')
    const s2 = steerData(msgId(2), 'second')
    const s3 = steerData(msgId(3), 'third')
    const reply = assistant('a1', STEP, text('one'), steer(s1), steer(s2), STEP, text('two'), steer(s3), STEP, text('three'))
    const result = splitSteers([reply])
    expect(result.map(message => [message.id, message.role])).toEqual([
      ['a1', 'assistant'],
      [msgId(1), 'user'],
      [msgId(2), 'user'],
      ['a1~1', 'assistant'],
      [msgId(3), 'user'],
      ['a1~2', 'assistant'],
    ])
    expect(result[3]!.parts).toEqual([STEP, text('two')])
  })

  it('drops empty assistant halves and names kept halves in order', () => {
    // Delivered at step 0 of a turn (before the first step boundary) and again before a step that only had a notice.
    const s1 = steerData(msgId(1), 'early')
    const s2 = steerData(msgId(2), 'late')
    const reply = assistant('a1', steer(s1), STEP, notice(), steer(s2), STEP, text('answer'))
    const result = splitSteers([user('u1'), reply])
    expect(result.map(message => message.id)).toEqual(['u1', msgId(1), msgId(2), 'a1'])
    expect(result[3]!.parts).toEqual([STEP, text('answer')])
    // A reply whose only content is a steer leaves just the user message.
    expect(splitSteers([assistant('a2', STEP, steer(s1), STEP)]).map(message => message.id)).toEqual([msgId(1)])
  })

  it('keeps tool results before the steer (continuation: approved tools run before the next step)', () => {
    const approved = toolPart('write_file', 'c1')
    const s = steerData(msgId(4), 'also update the README')
    const reply = assistant('a1', STEP, text('Writing'), approved, steer(s), STEP, text('Done'))
    const [first, steerMsg, second] = splitSteers([reply])
    expect(first!.parts.at(-1)).toBe(approved)
    expect(steerMsg!.role).toBe('user')
    expect(second!.parts[0]).toEqual(STEP)
  })

  it('removes invalid steers without splitting', () => {
    const invalid = [
      null,
      { id: 'not-a-message-id', parts: [{ type: 'text', text: 'x' }], queuedAt: AT, deliveredAt: AT },
      { id: msgId(1), parts: [], queuedAt: AT, deliveredAt: AT },
      { id: msgId(1), parts: [{ type: 'reasoning', text: 'x' }], queuedAt: AT, deliveredAt: AT },
      { id: msgId(1), parts: [{ type: 'text', text: 'x' }], queuedAt: -1, deliveredAt: AT },
    ]
    for (const data of invalid) {
      const reply = assistant('a1', STEP, text('one'), steer(data), STEP, text('two'))
      const result = splitSteers([reply])
      expect(result, JSON.stringify(data)).toEqual([{ ...reply, parts: [STEP, text('one'), STEP, text('two')] }])
      expect(result[0]).not.toBe(reply)
    }
  })

  it('keeps file parts of a steer and the order of mixed parts', () => {
    const s: SteerData = {
      id: msgId(9),
      parts: [{ type: 'text', text: 'Look at this' }, { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: '/api/files/file_0000000000000001' }],
      queuedAt: AT,
      deliveredAt: AT,
    }
    const result = splitSteers([assistant('a1', STEP, text('x'), steer(s), STEP, text('y'))])
    expect(result[1]).toEqual({ id: msgId(9), role: 'user', parts: s.parts })
  })

  it('leaves steers outside assistant messages alone', () => {
    const odd = user('u1', text('x'), steer(steerData(msgId(1), 'y')))
    expect(splitSteers([odd])[0]).toBe(odd)
  })

  it('never throws on malformed input', () => {
    const malformed = [null, 7, { id: 'a', role: 'assistant', parts: null }, { id: 'b', role: 'assistant', parts: [null, steer(steerData(msgId(1), 'x')), 3, text('after')] }] as unknown as AgentStateMessage[]
    const result = splitSteers(malformed)
    expect(result.slice(0, 3)).toEqual([null, 7, { id: 'a', role: 'assistant', parts: null }])
    // Non-object parts of a split message are dropped.
    expect(result.slice(3).map(message => [message.id, message.parts])).toEqual([
      [msgId(1), [{ type: 'text', text: 'x' }]],
      ['b', [text('after')]],
    ])
    expect(splitSteers('x' as unknown as AgentStateMessage[])).toEqual([])
  })

  it('composes with findCompaction: steers before an in-run marker are compacted, later ones are kept', () => {
    const data = compaction({ trigger: 'auto', keep: 'last-user' })
    const path = [
      user('u1'),
      assistant('a1', STEP, text('one'), steer(steerData(msgId(1), 'early')), STEP, marker(data), text('two'), steer(steerData(msgId(2), 'late')), STEP, text('three')),
    ]
    const latest = findCompaction(path)!
    expect(latest).toMatchObject({ messageIndex: 1, partIndex: 4, keptUserIndex: 0 })
    // What the server sends after the summary: the kept user message, then the rest of a1 split at its steers.
    const rest = { ...path[1]!, parts: path[1]!.parts.slice(latest.partIndex + 1) }
    expect(splitSteers([path[0]!, rest]).map(message => [message.id, message.parts.map(part => part.type)])).toEqual([
      ['u1', ['text']],
      ['a1', ['text']],
      [msgId(2), ['text']],
      ['a1~1', ['step-start', 'text']],
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Todos

describe('latestTodos', () => {
  const first = [todo('a', 'in_progress'), todo('b', 'pending'), todo('c', 'pending')]
  const second = [todo('a', 'completed'), todo('b', 'in_progress'), todo('c', 'pending')]
  const done = [todo('a', 'completed'), todo('b', 'completed'), todo('c', 'completed')]

  it('returns null without a list', () => {
    expect(latestTodos([])).toBeNull()
    expect(latestTodos([user('u1'), assistant('a1', STEP, text('x'), toolPart('shell', 'c1'))])).toBeNull()
  })

  it('returns the last finished todo_write call on the path', () => {
    const path = [user('u1'), assistant('a1', STEP, todoPart('t1', first), STEP, todoPart('t2', second), STEP, text('working'))]
    expect(latestTodos(path)).toEqual({ todos: second, counts: { pending: 1, inProgress: 1, completed: 1, total: 3 }, messageIndex: 1, partIndex: 3, toolCallId: 't2' })
  })

  it('is branch-aware: a branch before the last call shows the earlier state', () => {
    const u1 = user('u1')
    const a1 = assistant('a1', STEP, todoPart('t1', first))
    const u2 = user('u2')
    const a2 = assistant('a2', STEP, todoPart('t2', done))
    expect(latestTodos([u1, a1, u2, a2])?.toolCallId).toBe('t2')
    expect(latestTodos([u1, a1, user('u2b')])?.toolCallId).toBe('t1')
    expect(latestTodos([u1, assistant('a1b', STEP, text('regenerated'))])).toBeNull()
  })

  it('skips errored, denied, input-only, streaming, approval, preliminary and invalid calls', () => {
    const skipped: HarnessUIMessagePart[] = [
      toolPart('todo_write', 'e1', { state: 'output-error', errorText: 'Todo ids must be unique.', output: undefined }),
      toolPart('todo_write', 'e2', { state: 'output-denied', output: undefined, approval: { id: 'x', approved: false } }),
      toolPart('todo_write', 'e3', { state: 'input-available', output: undefined }),
      toolPart('todo_write', 'e4', { state: 'input-streaming', output: undefined }),
      toolPart('todo_write', 'e5', { state: 'approval-requested', output: undefined, approval: { id: 'y' } }),
      todoPart('e6', done, { preliminary: true }),
      todoPart('e7', done, { toolCallId: 42 }),
      toolPart('todo_write', 'e8', { output: { todos: [{ id: 'a', content: '', status: 'pending' }], counts: { pending: 1, inProgress: 0, completed: 0, total: 1 } } }),
      toolPart('todo_write', 'e9', { output: { todos: done } }),
      toolPart('todo_write', 'e10', { output: 'All 3 tasks done.' }),
      { ...todoPart('e11', done), type: 'dynamic-tool', toolName: 'todo_write' } as HarnessUIMessagePart,
      todoPart('e12', done, { type: 'tool-todo_write_v2' }),
    ]
    for (const part of skipped) {
      const path = [user('u1'), assistant('a1', STEP, todoPart('ok', first), STEP, part)]
      expect(latestTodos(path)?.toolCallId, JSON.stringify(part)).toBe('ok')
    }
  })

  it('recomputes counts from the todos', () => {
    const path = [assistant('a1', toolPart('todo_write', 'c1', { output: { todos: second, counts: { pending: 9, inProgress: 9, completed: 9, total: 27 } } }))]
    expect(latestTodos(path)?.counts).toEqual({ pending: 1, inProgress: 1, completed: 1, total: 3 })
  })

  it('accepts an empty list (the agent cleared it)', () => {
    const path = [assistant('a1', todoPart('t1', first), todoPart('t2', []))]
    expect(latestTodos(path)).toMatchObject({ todos: [], counts: { pending: 0, inProgress: 0, completed: 0, total: 0 }, toolCallId: 't2' })
  })

  it('ignores todo parts outside assistant messages', () => {
    const path = [assistant('a1', todoPart('t1', first)), { id: 'u1', role: 'user', parts: [todoPart('t2', done)] }] as AgentStateMessage[]
    expect(latestTodos(path)?.toolCallId).toBe('t1')
  })

  it('counts todos by status', () => {
    expect(countTodos([])).toEqual({ pending: 0, inProgress: 0, completed: 0, total: 0 })
    expect(countTodos(second)).toEqual({ pending: 1, inProgress: 1, completed: 1, total: 3 })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Seeded fuzzing

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('fuzzing', () => {
  const random = prng(0xA6E7)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  let steerCounter = 0

  function randomPart(): HarnessUIMessagePart {
    const roll = random()
    if (roll < 0.15)
      return STEP
    if (roll < 0.35)
      return text(pick(['a', 'b', 'c', '']))
    if (roll < 0.42)
      return notice()
    if (roll < 0.47)
      return { type: 'data-activity', data: { kind: 'compacting' } } as HarnessUIMessagePart
    if (roll < 0.57)
      return steer(random() < 0.8 ? steerData(msgId(++steerCounter), 'steer') : { id: 'bad' })
    if (roll < 0.67)
      return marker(random() < 0.8 ? compaction({ keep: pick(['none', 'last-user'] as const), summary: `s${Math.floor(random() * 100)}` }) : { summary: 1 }, random() < 0.5 ? `p${Math.floor(random() * 10)}` : undefined)
    if (roll < 0.8) {
      const state = pick(['output-available', 'output-available', 'output-error', 'input-available'])
      return todoPart(`t${Math.floor(random() * 1000)}`, [todo('x', pick(['pending', 'in_progress', 'completed'] as const))], { state, preliminary: random() < 0.2 })
    }
    if (roll < 0.9)
      return toolPart(pick(['read_file', 'shell', 'task']), `c${Math.floor(random() * 1000)}`)
    return pick([null, 3, 'x', { type: 7 }]) as unknown as HarnessUIMessagePart
  }

  function randomPath(): AgentStateMessage[] {
    const length = Math.floor(random() * 7)
    const path: AgentStateMessage[] = []
    for (let index = 0; index < length; index++) {
      const role = pick(['user', 'assistant', 'assistant', 'system'] as const)
      const parts: HarnessUIMessagePart[] = []
      const count = Math.floor(random() * 9)
      for (let part = 0; part < count; part++)
        parts.push(randomPart())
      path.push({ id: `m${index}`, role, parts } as AgentStateMessage)
    }
    return path
  }

  function isObjectPart(part: unknown): part is AgentStatePart {
    return typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string'
  }

  it('keeps every invariant on 2000 random paths', () => {
    const exercised = { markers: 0, inline: 0, keptUser: 0, steers: 0, todos: 0 }
    for (let iteration = 0; iteration < 2000; iteration++) {
      const path = randomPath()
      const context = `iteration ${iteration}`

      // Markers: the latest one is the last of the list; the cutoff follows it.
      const markers = compactionMarkers(path)
      const latest = findCompaction(path)
      if (markers.length === 0) {
        expect(latest, context).toBeNull()
        expect(compactionCutoff(path), context).toBeNull()
      }
      else {
        const last = markers.at(-1)!
        expect(latest, context).toMatchObject({ messageIndex: last.messageIndex, partIndex: last.partIndex, data: last.data })
        expect(path[last.messageIndex]!.role, context).toBe('assistant')
        expect(path[last.messageIndex]!.parts[last.partIndex]!.type, context).toBe('data-compaction')
        const cutoff = compactionCutoff(path)!
        if (latest!.keptUserIndex === null) {
          expect(cutoff, context).toEqual({ messageIndex: last.messageIndex, partIndex: last.partIndex + 1 })
        }
        else {
          expect(path[latest!.keptUserIndex]!.role, context).toBe('user')
          expect(path.slice(latest!.keptUserIndex + 1, last.messageIndex).some(message => message.role === 'user'), context).toBe(false)
          expect(cutoff, context).toEqual({ messageIndex: latest!.keptUserIndex, partIndex: 0 })
        }
        for (let index = 1; index < markers.length; index++) {
          const [previous, current] = [markers[index - 1]!, markers[index]!]
          expect(previous.messageIndex < current.messageIndex || (previous.messageIndex === current.messageIndex && previous.partIndex < current.partIndex), context).toBe(true)
        }
        for (const item of markers) {
          const before = path[item.messageIndex]!.parts.slice(0, item.partIndex)
          expect(item.inline, context).toBe(before.some(part => isObjectPart(part) && isContentPart(part)))
          exercised.markers++
          if (item.inline)
            exercised.inline++
        }
        if (latest!.keptUserIndex !== null)
          exercised.keptUser++
      }

      // Steers: content parts survive in order, each kept half has content, valid steers become user messages.
      const split = splitSteers(path)
      const contentIn: unknown[] = []
      const contentOut: unknown[] = []
      let nonSteerIn = 0
      let nonSteerOut = 0
      let validSteers = 0
      for (const message of path) {
        for (const part of message.parts) {
          if (!isObjectPart(part))
            continue
          if (message.role === 'assistant' && part.type === 'data-steer') {
            if (typeof part.data === 'object' && part.data !== null && (part.data as { id?: unknown }).id !== 'bad')
              validSteers++
            continue
          }
          nonSteerIn++
          if (isContentPart(part))
            contentIn.push(part)
        }
      }
      let steerMessages = 0
      for (const message of split) {
        const original = path.find(item => item.id === message.id)
        if (original === undefined && message.role === 'user' && message.id.startsWith('msg_')) {
          steerMessages++
          continue
        }
        for (const part of message.parts) {
          if (!isObjectPart(part))
            continue
          nonSteerOut++
          if (isContentPart(part))
            contentOut.push(part)
          if (message.role === 'assistant')
            expect(part.type, context).not.toBe('data-steer')
        }
        if (message.role === 'assistant' && message !== original)
          expect(message.parts.some(part => isObjectPart(part) && isContentPart(part)), context).toBe(true)
      }
      expect(steerMessages, context).toBe(validSteers)
      exercised.steers += steerMessages
      expect(contentOut, context).toEqual(contentIn)
      contentOut.forEach((part, index) => expect(part, context).toBe(contentIn[index]))
      // Only non-content parts of dropped (empty) halves and non-object parts may be lost: an independent segmentation at
      // the valid steers gives the exact number of surviving parts.
      expect(nonSteerOut, context).toBeLessThanOrEqual(nonSteerIn)
      let expectedOut = 0
      for (const message of path) {
        const objectParts = message.parts.filter(isObjectPart)
        if (message.role !== 'assistant' || !objectParts.some(part => part.type === 'data-steer')) {
          expectedOut += objectParts.length
          continue
        }
        let segment: AgentStatePart[] = []
        const close = (): void => {
          if (segment.some(isContentPart))
            expectedOut += segment.length
          segment = []
        }
        for (const part of objectParts) {
          if (part.type !== 'data-steer')
            segment.push(part)
          else if (steerDataSchema.safeParse(part.data).success)
            close()
        }
        close()
      }
      expect(nonSteerOut, context).toBe(expectedOut)
      for (const message of path) {
        const hasSteer = message.role === 'assistant' && message.parts.some(part => isObjectPart(part) && part.type === 'data-steer')
        if (!hasSteer)
          expect(split.includes(message), context).toBe(true)
      }
      expect(splitSteers(path), context).toEqual(split)

      // Todos: the result points at a finished, valid todo_write part and no later one qualifies.
      const todos = latestTodos(path)
      if (todos !== null) {
        const part = path[todos.messageIndex]!.parts[todos.partIndex]!
        expect(path[todos.messageIndex]!.role, context).toBe('assistant')
        expect(part, context).toMatchObject({ type: 'tool-todo_write', state: 'output-available', toolCallId: todos.toolCallId })
        expect(part.preliminary, context).not.toBe(true)
        expect(todos.counts, context).toEqual(countTodos(todos.todos))
        exercised.todos++
      }
      for (let messageIndex = 0; messageIndex < path.length; messageIndex++) {
        const message = path[messageIndex]!
        if (message.role !== 'assistant')
          continue
        message.parts.forEach((part, partIndex) => {
          const later = todos === null || messageIndex > todos.messageIndex || (messageIndex === todos.messageIndex && partIndex > todos.partIndex)
          if (later && isObjectPart(part) && part.type === 'tool-todo_write' && part.state === 'output-available')
            expect(part.preliminary, context).toBe(true)
        })
      }
    }
    // The generator reaches every branch.
    expect(exercised.markers).toBeGreaterThan(300)
    expect(exercised.inline).toBeGreaterThan(100)
    expect(exercised.keptUser).toBeGreaterThan(50)
    expect(exercised.steers).toBeGreaterThan(300)
    expect(exercised.todos).toBeGreaterThan(300)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Background task results (Phase 10)

interface TaskOutputFields {
  status: string
  type: string
  description: string
  report: string
  error?: string
}

function taskResultData(taskId: string, overrides: Partial<TaskOutputFields> = {}): Record<string, unknown> {
  return {
    taskId,
    toolCallId: `call_${taskId}`,
    messageId: msgId(50),
    output: {
      status: 'completed',
      type: 'explore',
      description: 'Find the parser',
      modelRef: 'mock:echo',
      steps: [],
      stepsOmitted: 0,
      report: 'Found it in src/a.ts.',
      startedAt: AT,
      finishedAt: AT + 5,
      ...overrides,
    },
    deliveredAt: AT + 6,
  }
}

function taskResult(data: unknown): HarnessUIMessagePart {
  return { type: 'data-task-result', data } as unknown as HarnessUIMessagePart
}

function resultText(taskId: string, overrides: Partial<TaskOutputFields> = {}): HarnessUIMessagePart {
  return text(taskResultText(taskResultData(taskId, overrides) as unknown as Parameters<typeof taskResultText>[0]))
}

describe('taskResultText', () => {
  it('wraps the report in a background-task element', () => {
    expect(TASK_RESULT_PART_TYPE).toBe('data-task-result')
    expect(taskResultText({ taskId: 'bgt_0000000000000001', output: { status: 'completed', type: 'explore', description: 'Find the parser', report: '\n  Found it.\n\n' } }))
      .toBe('<background-task id="bgt_0000000000000001" type="explore" status="completed" description="Find the parser">\nFound it.\n</background-task>')
  })

  it('uses the error when the report is empty, else a placeholder', () => {
    expect(taskResultText({ taskId: 't', output: { status: 'failed', type: 'reviewer', description: 'd', report: ' ', error: 'The model failed.' } }))
      .toBe('<background-task id="t" type="reviewer" status="failed" description="d">\nError: The model failed.\n</background-task>')
    expect(taskResultText({ taskId: 't', output: { status: 'limit', type: 'general', description: 'd', report: 'Partial.', error: 'Step limit.' } }))
      .toBe('<background-task id="t" type="general" status="limit" description="d">\nPartial.\n</background-task>')
    expect(taskResultText({ taskId: 't', output: { status: 'aborted', type: 'general', description: 'd', report: '' } }))
      .toBe('<background-task id="t" type="general" status="aborted" description="d">\n(no report)\n</background-task>')
  })

  it('escapes &, " and < in attributes', () => {
    expect(taskResultText({ taskId: 'a"b', output: { status: 'completed', type: '<x>', description: 'Tom & "Jerry" <b>', report: 'r' } }))
      .toBe('<background-task id="a&quot;b" type="&lt;x>" status="completed" description="Tom &amp; &quot;Jerry&quot; &lt;b>">\nr\n</background-task>')
  })
})

describe('splitTaskResults', () => {
  it('returns a new array with the same objects when there are no results', () => {
    const path = [user('u1'), assistant('a1', STEP, text('x')), user('u2', text('y'), taskResult(taskResultData('t1'))), assistant('a2')]
    const result = splitTaskResults(path)
    expect(result).not.toBe(path)
    result.forEach((message, index) => expect(message).toBe(path[index]))
    expect(splitTaskResults([])).toEqual([])
    expect(splitTaskResults(null as unknown as HarnessUIMessage[])).toEqual([])
  })

  it('splits a reply at a result delivered mid-reply', () => {
    const call = toolPart('task', 'c1', { output: { status: 'background', taskId: 'bgt_1' } })
    const reply = assistant('a1', STEP, text('Launching'), call, STEP, text('Meanwhile'), taskResult(taskResultData('bgt_1')), STEP, text('The explorer found it'))
    const result = splitTaskResults([user('u1'), reply])
    expect(result).toEqual([
      user('u1'),
      { ...reply, parts: [STEP, text('Launching'), call, STEP, text('Meanwhile')] },
      { id: 'bgt_1', role: 'user', parts: [resultText('bgt_1')] },
      { ...reply, id: 'a1~r1', parts: [STEP, text('The explorer found it')] },
    ])
    expect('metadata' in result[2]!).toBe(false)
    expect(result[1]!.metadata).toBe(reply.metadata)
    expect(result[3]!.metadata).toBe(reply.metadata)
    expect(result[1]!.parts[2]).toBe(call)
  })

  it('splits several results in order and drops empty halves', () => {
    const reply = assistant('a1', taskResult(taskResultData('t1')), STEP, notice(), taskResult(taskResultData('t2')), taskResult(taskResultData('t3', { status: 'failed', report: '', error: 'Boom.' })), STEP, text('answer'), taskResult(taskResultData('t4')), STEP)
    const result = splitTaskResults([reply])
    expect(result.map(message => [message.id, message.role])).toEqual([
      ['t1', 'user'],
      ['t2', 'user'],
      ['t3', 'user'],
      ['a1', 'assistant'],
      ['t4', 'user'],
    ])
    expect(result[2]!.parts).toEqual([resultText('t3', { status: 'failed', report: '', error: 'Boom.' })])
    expect(result[3]!.parts).toEqual([STEP, text('answer')])
  })

  it('removes results with invalid data without splitting', () => {
    const invalid = [
      null,
      'text',
      { output: taskResultData('x').output },
      { taskId: 7, output: taskResultData('x').output },
      { taskId: 'x', output: null },
      { taskId: 'x', output: { ...(taskResultData('x').output as object), report: 5 } },
      { taskId: 'x', output: { ...(taskResultData('x').output as object), status: undefined } },
      { taskId: 'x', output: { ...(taskResultData('x').output as object), error: 42 } },
    ]
    for (const data of invalid) {
      const reply = assistant('a1', STEP, text('one'), taskResult(data), STEP, text('two'))
      const result = splitTaskResults([reply])
      expect(result, JSON.stringify(data)).toEqual([{ ...reply, parts: [STEP, text('one'), STEP, text('two')] }])
    }
  })

  it('turns a carrier user message into one text part per result', () => {
    const carrier = user('u2', taskResult(taskResultData('t1')), taskResult(taskResultData('t2', { type: 'reviewer', report: 'LGTM' })))
    const result = splitTaskResults([user('u1'), assistant('a1', STEP, text('x')), carrier])
    expect(result[2]).toEqual({ ...carrier, parts: [resultText('t1'), resultText('t2', { type: 'reviewer', report: 'LGTM' })] })
    expect(result[2]!.metadata).toBe(carrier.metadata)
  })

  it('drops invalid results of a carrier and a carrier without a valid result', () => {
    const mixed = user('u2', taskResult(null), taskResult(taskResultData('t1')))
    expect(splitTaskResults([mixed])).toEqual([{ ...mixed, parts: [resultText('t1')] }])
    expect(splitTaskResults([user('u1'), user('u2', taskResult({ taskId: 1 }))])).toEqual([user('u1')])
  })

  it('runs after splitSteers on a reply that holds steers and results', () => {
    const s = steerData(msgId(1), 'also check the docs')
    const reply = assistant('a1', STEP, text('one'), taskResult(taskResultData('t1')), STEP, text('two'), steer(s), STEP, text('three'), taskResult(taskResultData('t2')), STEP, text('four'))
    const result = splitTaskResults(splitSteers([user('u1'), reply]))
    expect(result.map(message => [message.id, message.role])).toEqual([
      ['u1', 'user'],
      ['a1', 'assistant'],
      ['t1', 'user'],
      ['a1~r1', 'assistant'],
      [msgId(1), 'user'],
      ['a1~1', 'assistant'],
      ['t2', 'user'],
      ['a1~1~r1', 'assistant'],
    ])
    expect(new Set(result.map(message => message.id)).size).toBe(result.length)
    expect(result.map(message => message.parts.filter(part => part.type === 'text').map(part => (part as { text: string }).text).join('|'))).toEqual([
      'question u1',
      'one',
      taskResultText(taskResultData('t1') as unknown as Parameters<typeof taskResultText>[0]),
      'two',
      'also check the docs',
      'three',
      taskResultText(taskResultData('t2') as unknown as Parameters<typeof taskResultText>[0]),
      'four',
    ])
  })

  it('is idempotent', () => {
    const path = [
      user('u1'),
      assistant('a1', STEP, text('one'), taskResult(taskResultData('t1')), STEP, text('two')),
      user('u2', taskResult(taskResultData('t2'))),
      assistant('a2', STEP, text('three')),
    ]
    const once = splitTaskResults(path)
    const twice = splitTaskResults(once)
    expect(twice).toEqual(once)
    twice.forEach((message, index) => expect(message).toBe(once[index]))
  })

  it('accepts structural messages', () => {
    const path: AgentStateMessage[] = [{ id: 'a', role: 'assistant', parts: [{ type: TASK_RESULT_PART_TYPE, data: taskResultData('t') }] }]
    expect(splitTaskResults(path)).toEqual([{ id: 't', role: 'user', parts: [resultText('t')] }])
  })
})
