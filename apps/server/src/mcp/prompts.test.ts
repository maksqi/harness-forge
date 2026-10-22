// Smoke tests of the C51 stubs of the prompt and resource caches (P14-0b): the final signatures, nothing listed,
// `get` / `read` answer `not_implemented`. W14.2 replaces them with the real caches and their tests.
import type { MCPClient } from '@ai-sdk/mcp'
import type { McpCacheServer } from './prompts.ts'
import { describe, expect, it, vi } from 'vitest'
import { createPromptCache, MCP_LIST_MAX_AGE_MS } from './prompts.ts'
import { createResourceCache } from './resources.ts'

const SERVER: McpCacheServer = { key: 'docs', serverId: 'docs', serverName: 'Docs', projectId: null }
/** A client the stubs never touch. */
const CLIENT = new Proxy({}, { get: () => {
  throw new Error('The stub used the client.')
} }) as MCPClient

describe('createPromptCache (C51 stub)', () => {
  it('lists nothing, refreshes nothing and answers not_implemented for a prompt', async () => {
    const onChange = vi.fn()
    const cache = createPromptCache({ onChange, maxAgeMs: MCP_LIST_MAX_AGE_MS })
    await expect(cache.refresh(SERVER, CLIENT)).resolves.toBeUndefined()
    expect(await cache.list(SERVER, CLIENT)).toEqual({ items: [], truncated: false })
    await expect(cache.get(SERVER, CLIENT, 'greet', { name: 'Ada' }, new AbortController().signal)).rejects.toMatchObject({ code: 'not_implemented' })
    cache.drop('docs')
    cache.clear()
    expect(onChange).not.toHaveBeenCalled()
    expect(MCP_LIST_MAX_AGE_MS).toBe(60_000)
  })
})

describe('createResourceCache (C51 stub)', () => {
  it('lists nothing, refreshes nothing and answers not_implemented for a read', async () => {
    const cache = createResourceCache()
    await expect(cache.refresh({ ...SERVER, key: 'prj_0000000000000000/docs', projectId: 'prj_0000000000000000' }, CLIENT)).resolves.toBeUndefined()
    expect(await cache.list(SERVER, CLIENT)).toEqual({ items: [], truncated: false })
    await expect(cache.read(SERVER, CLIENT, 'file:///readme.md', new AbortController().signal)).rejects.toMatchObject({ code: 'not_implemented' })
    cache.drop('docs')
    cache.clear()
  })
})
