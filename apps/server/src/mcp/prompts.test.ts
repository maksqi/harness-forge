// The MCP prompt cache (W14.2-T1, ADR-061): listing (paging, caps, names, arguments), change detection, the 60 s
// re-listing, failures, the bounded wait, single flight, discards after `drop`, and `prompts/get` (not listed, timeout,
// abort). The client is a scripted double of `@ai-sdk/mcp`'s `MCPClient` (only the prompt members).
import type { MCPClient } from '@ai-sdk/mcp'
import type { McpCacheServer } from './prompts.ts'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '../logger.ts'
import {
  createPromptCache,
  GET_TIMEOUT_MS,
  LIST_RETRY_MS,
  LIST_WAIT_MS,
  MCP_LIST_MAX_AGE_MS,
  nameHash,
  plainText,
} from './prompts.ts'

const SERVER: McpCacheServer = { key: 'docs', serverId: 'docs', serverName: 'Docs', projectId: null }

interface ListedPrompt {
  name: unknown
  title?: unknown
  description?: unknown
  arguments?: unknown
}

interface PromptClientScript {
  /** Pages by cursor ('' = the first page). */
  pages?: Record<string, { prompts: ListedPrompt[], nextCursor?: string }>
  /** Answers every first page (when `pages` is not given). */
  prompts?: ListedPrompt[]
  /** Makes `experimental_listPrompts` reject or hang. */
  listMode?: 'ok' | 'fail' | 'hang'
}

/** A scripted client: records list and get calls; `getPrompt` answers `result` (or `getImpl`). */
function promptClient(script: PromptClientScript = {}) {
  const listCalls: Array<{ cursor: string | undefined, signal: AbortSignal | undefined, timeout: number | undefined }> = []
  const getCalls: Array<{ name: string, arguments: unknown, signal: AbortSignal | undefined }> = []
  let getImpl: (signal: AbortSignal | undefined) => Promise<unknown> = async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'ok' } }] })
  const client = {
    experimental_listPrompts: async (options: { params?: { cursor?: string }, options?: { signal?: AbortSignal, timeout?: number } } = {}) => {
      const cursor = options.params?.cursor
      listCalls.push({ cursor, signal: options.options?.signal, timeout: options.options?.timeout })
      if (script.listMode === 'fail')
        throw new Error('listing failed')
      if (script.listMode === 'hang')
        return new Promise(() => {})
      if (script.pages !== undefined)
        return script.pages[cursor ?? ''] ?? { prompts: [] }
      return { prompts: script.prompts ?? [] }
    },
    experimental_getPrompt: async (args: { name: string, arguments?: unknown, options?: { signal?: AbortSignal } }) => {
      getCalls.push({ name: args.name, arguments: args.arguments, signal: args.options?.signal })
      return getImpl(args.options?.signal)
    },
  }
  return {
    client: client as unknown as MCPClient,
    listCalls,
    getCalls,
    script,
    setGet: (impl: typeof getImpl) => {
      getImpl = impl
    },
  }
}

const GREET: ListedPrompt = {
  name: 'greet',
  title: 'Greet',
  description: 'Greets someone by name.',
  arguments: [{ name: 'name', description: 'Who to greet', required: true }, { name: 'greeting', description: 'The word', required: false }],
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createPromptCache: listing', () => {
  it('lists, names and normalizes the prompts of a server', async () => {
    const cache = createPromptCache()
    const fake = promptClient({ prompts: [GREET, { name: 'review', description: '  An assistant\nmessage,\tthen a\u2028request.  ' }] })
    const list = await cache.list(SERVER, fake.client)
    expect(list.truncated).toBe(false)
    expect(list.items).toEqual([
      {
        serverId: 'docs',
        serverName: 'Docs',
        name: 'greet',
        commandName: 'mcp__docs__greet',
        title: 'Greet',
        description: 'Greets someone by name.',
        arguments: [{ name: 'name', description: 'Who to greet', required: true }, { name: 'greeting', description: 'The word', required: false }],
      },
      { serverId: 'docs', serverName: 'Docs', name: 'review', commandName: 'mcp__docs__review', title: null, description: 'An assistant message, then a request.', arguments: [] },
    ])
    // Requests are never cancelled inside the client: no signal, no timeout option.
    expect(fake.listCalls).toEqual([{ cursor: undefined, signal: undefined, timeout: undefined }])
  })

  it('skips unusable names, keeps the first of colliding command names and caps texts and arguments', async () => {
    const memory = createMemoryLogger({ level: 'debug' })
    const cache = createPromptCache({ logger: memory.logger })
    const args = Array.from({ length: 23 }, (_, index) => ({ name: `a${index}`, required: index === 0 }))
    const fake = promptClient({ prompts: [
      { name: '' },
      { name: 42 },
      { name: 'x'.repeat(1025) },
      { name: 'do.it', title: 'First' },
      { name: 'do_it', title: 'Second' },
      { name: 'many', arguments: [...args, { name: 'a1' }, { name: '' }, null, 'x'] },
      { name: 'long', description: 'd'.repeat(2000), title: 't'.repeat(300) },
      null as unknown as ListedPrompt,
    ] })
    const list = await cache.list(SERVER, fake.client)
    expect(list.items.map(prompt => prompt.name)).toEqual(['do.it', 'many', 'long'])
    expect(list.items[0]?.commandName).toBe('mcp__docs__do_it')
    expect(list.items[1]?.arguments).toHaveLength(LIMITS.mcpPromptArgumentsMax)
    expect(list.items[1]?.arguments.map(arg => arg.name)).toEqual(args.slice(0, 20).map(arg => arg.name))
    expect(list.items[2]?.description).toHaveLength(1024)
    expect(list.items[2]?.description?.endsWith('…')).toBe(true)
    expect(list.items[2]?.title).toHaveLength(256)
    const lines = memory.records.filter(record => record.level === 'debug').map(record => JSON.stringify(record))
    expect(lines.some(line => line.includes(nameHash('do_it')))).toBe(true)
    expect(lines.some(line => line.includes('"dropped":3'))).toBe(true)
    // Names never appear in the log, only their hash prefix.
    expect(lines.join('\n')).not.toContain('do_it')
  })

  it('reads every page, stops at a repeated cursor and caps the list (truncated only when more were listed)', async () => {
    const prompt = (index: number): ListedPrompt => ({ name: `p${index}` })
    const paged = promptClient({ pages: {
      '': { prompts: [prompt(1), prompt(2)], nextCursor: 'c1' },
      'c1': { prompts: [prompt(3)], nextCursor: 'c2' },
      'c2': { prompts: [prompt(4)], nextCursor: 'c1' },
    } })
    const list = await createPromptCache().list(SERVER, paged.client)
    expect(list).toMatchObject({ truncated: false })
    expect(list.items.map(item => item.name)).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(paged.listCalls.map(call => call.cursor)).toEqual([undefined, 'c1', 'c2'])

    const exact = promptClient({ prompts: Array.from({ length: LIMITS.mcpPromptsMax }, (_, index) => prompt(index)) })
    expect(await createPromptCache().list(SERVER, exact.client)).toMatchObject({ truncated: false })
    const over = promptClient({ pages: {
      '': { prompts: Array.from({ length: LIMITS.mcpPromptsMax }, (_, index) => prompt(index)), nextCursor: 'more' },
      'more': { prompts: [prompt(999)] },
    } })
    const capped = await createPromptCache().list(SERVER, over.client)
    expect(capped.items).toHaveLength(LIMITS.mcpPromptsMax)
    expect(capped.truncated).toBe(true)
  })
})

describe('createPromptCache: refresh, changes and age', () => {
  it('calls onChange for a new or changed listing and a drop with prompts, never for the same answer or clear', async () => {
    const onChange = vi.fn()
    const cache = createPromptCache({ onChange })
    const fake = promptClient({ prompts: [] })
    await cache.refresh(SERVER, fake.client)
    expect(onChange).not.toHaveBeenCalled()
    fake.script.prompts = [GREET]
    await cache.refresh(SERVER, fake.client)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(SERVER)
    await cache.refresh(SERVER, fake.client)
    expect(onChange).toHaveBeenCalledTimes(1)
    fake.script.prompts = [{ ...GREET, description: 'Changed.' }]
    await cache.refresh(SERVER, fake.client)
    expect(onChange).toHaveBeenCalledTimes(2)
    cache.drop('docs')
    expect(onChange).toHaveBeenCalledTimes(3)
    cache.drop('docs')
    cache.drop('unknown')
    expect(onChange).toHaveBeenCalledTimes(3)
    await cache.refresh(SERVER, fake.client)
    expect(onChange).toHaveBeenCalledTimes(4)
    cache.clear()
    expect(onChange).toHaveBeenCalledTimes(4)
    // A throwing listener changes nothing.
    const throwing = createPromptCache({ onChange: () => {
      throw new Error('listener')
    } })
    await expect(throwing.refresh(SERVER, fake.client)).resolves.toBeUndefined()
  })

  it('answers a fresh entry from the cache and lists again once it is older than maxAgeMs', async () => {
    let now = 1_000_000
    const cache = createPromptCache({ now: () => now })
    const fake = promptClient({ prompts: [GREET] })
    await cache.refresh(SERVER, fake.client)
    expect(fake.listCalls).toHaveLength(1)
    now += MCP_LIST_MAX_AGE_MS - 1
    expect((await cache.list(SERVER, fake.client)).items).toHaveLength(1)
    expect(fake.listCalls).toHaveLength(1)
    now += 1
    fake.script.prompts = []
    expect((await cache.list(SERVER, fake.client)).items).toHaveLength(0)
    expect(fake.listCalls).toHaveLength(2)
  })

  it('keeps the previous entry when a listing fails and tries again only after LIST_RETRY_MS', async () => {
    let now = 5_000_000
    const memory = createMemoryLogger({ level: 'debug' })
    const cache = createPromptCache({ now: () => now, logger: memory.logger })
    const fake = promptClient({ prompts: [GREET] })
    await cache.refresh(SERVER, fake.client)
    fake.script.listMode = 'fail'
    now += MCP_LIST_MAX_AGE_MS
    expect((await cache.list(SERVER, fake.client)).items.map(item => item.name)).toEqual(['greet'])
    expect(fake.listCalls).toHaveLength(2)
    now += LIST_RETRY_MS - 1
    expect((await cache.list(SERVER, fake.client)).items).toHaveLength(1)
    expect(fake.listCalls).toHaveLength(2)
    now += 1
    await cache.list(SERVER, fake.client)
    expect(fake.listCalls).toHaveLength(3)
    // A refresh always lists; a failure never rejects.
    await expect(cache.refresh(SERVER, fake.client)).resolves.toBeUndefined()
    expect(memory.records.some(record => record.msg === 'MCP prompts listing failed')).toBe(true)
    // Without a previous entry a failure lists nothing.
    expect(await createPromptCache().list(SERVER, fake.client)).toEqual({ items: [], truncated: false })
  })

  it('shares one listing between concurrent list calls', async () => {
    const cache = createPromptCache()
    const fake = promptClient({ prompts: [GREET] })
    const [a, b] = await Promise.all([cache.list(SERVER, fake.client), cache.list(SERVER, fake.client)])
    expect(a).toEqual(b)
    expect(fake.listCalls).toHaveLength(1)
  })

  it('waits at most LIST_WAIT_MS for a listing; the late answer fills the cache', async () => {
    vi.useFakeTimers()
    const cache = createPromptCache()
    let release: ((value: unknown) => void) | undefined
    const client = {
      experimental_listPrompts: () => new Promise((resolve) => {
        release = resolve
      }),
    } as unknown as MCPClient
    const pending = cache.list(SERVER, client)
    await vi.advanceTimersByTimeAsync(LIST_WAIT_MS)
    expect(await pending).toEqual({ items: [], truncated: false })
    release?.({ prompts: [GREET] })
    await vi.advanceTimersByTimeAsync(0)
    expect((await cache.list(SERVER, client)).items.map(item => item.name)).toEqual(['greet'])
    // An aborted caller gets the previous entry at once.
    const aborted = new AbortController()
    aborted.abort()
    expect((await createPromptCache().list(SERVER, client, aborted.signal)).items).toEqual([])
  })

  it('keeps the newest listing when an older one finishes later, and discards a listing that finishes after drop', async () => {
    const cache = createPromptCache()
    const releases: Array<(value: unknown) => void> = []
    const client = {
      experimental_listPrompts: () => new Promise((resolve) => {
        releases.push(resolve)
      }),
    } as unknown as MCPClient
    const first = cache.refresh(SERVER, client)
    const second = cache.refresh(SERVER, client)
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]?.({ prompts: [{ name: 'newer' }] })
    await second
    releases[0]?.({ prompts: [{ name: 'older' }] })
    await first
    expect((await cache.list(SERVER, client)).items.map(item => item.name)).toEqual(['newer'])

    const third = cache.refresh(SERVER, client)
    await vi.waitFor(() => expect(releases).toHaveLength(3))
    cache.drop('docs')
    // The refresh ends with the drop; the late answer is discarded.
    await third
    releases[2]?.({ prompts: [{ name: 'stale' }] })
    await vi.waitFor(() => Promise.resolve())
    // Nothing was stored after the drop: the next list lists again.
    const listing = cache.list(SERVER, client)
    await vi.waitFor(() => expect(releases).toHaveLength(4))
    releases[3]?.({ prompts: [] })
    expect((await listing).items).toEqual([])
  })

  it('a refresh with an aborted signal stores nothing', async () => {
    const cache = createPromptCache()
    const fake = promptClient({ listMode: 'hang' })
    const controller = new AbortController()
    const refresh = cache.refresh(SERVER, fake.client, controller.signal)
    controller.abort()
    await expect(refresh).resolves.toBeUndefined()
  })
})

describe('createPromptCache: get', () => {
  it('runs prompts/get of a listed prompt with the string arguments and the timeout signal', async () => {
    const cache = createPromptCache()
    const fake = promptClient({ prompts: [GREET] })
    const result = await cache.get(SERVER, fake.client, 'greet', { name: 'Ada', bad: 1 as unknown as string }, new AbortController().signal)
    expect(result).toEqual({ messages: [{ role: 'user', content: { type: 'text', text: 'ok' } }] })
    expect(fake.getCalls).toEqual([{ name: 'greet', arguments: { name: 'Ada' }, signal: undefined }])
  })

  it('refuses a prompt the server does not list (not_found) without calling it', async () => {
    const cache = createPromptCache()
    const fake = promptClient({ prompts: [GREET] })
    await expect(cache.get(SERVER, fake.client, 'nope', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'not_found' })
    expect(fake.getCalls).toHaveLength(0)
  })

  it('passes the server errors through, rejects with the abort reason and times out as provider_error', async () => {
    const cache = createPromptCache()
    const fake = promptClient({ prompts: [GREET] })
    await cache.refresh(SERVER, fake.client)
    fake.setGet(async () => {
      throw new Error('Missing required argument: name')
    })
    await expect(cache.get(SERVER, fake.client, 'greet', {}, new AbortController().signal)).rejects.toThrow('Missing required argument: name')

    // A request that never answers: only the wait ends (the request is never cancelled inside the client).
    fake.setGet(() => new Promise(() => {}))
    const controller = new AbortController()
    const aborted = cache.get(SERVER, fake.client, 'greet', {}, controller.signal)
    controller.abort(new Error('stopped by the user'))
    await expect(aborted).rejects.toThrow('stopped by the user')
    const already = new AbortController()
    already.abort(new Error('gone'))
    await expect(cache.get(SERVER, fake.client, 'greet', {}, already.signal)).rejects.toThrow('gone')

    vi.useFakeTimers()
    const slow = cache.get(SERVER, fake.client, 'greet', {}, new AbortController().signal)
    const outcome = expect(slow).rejects.toMatchObject({ code: 'provider_error', message: 'The MCP server "Docs" did not answer within 30 s.' })
    await vi.advanceTimersByTimeAsync(GET_TIMEOUT_MS)
    await outcome
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('plainText', () => {
  it('makes one line of plain text, caps it and answers null for nothing', () => {
    expect(plainText(' a\n\tb\u202Ec ', 10)).toBe('a b c')
    expect(plainText('abcdef', 4)).toBe('abc…')
    expect(plainText('   ', 4)).toBeNull()
    expect(plainText(7, 4)).toBeNull()
  })
})
