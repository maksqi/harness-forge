import type { ProvidersTestApp } from '../../providers/testing.ts'
import { catalogModelSchema, harnessErrorEnvelopeSchema, listResponseSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProvidersTestApp } from '../../providers/testing.ts'

const ORIGIN = 'http://127.0.0.1:8787'
const listSchema = listResponseSchema(catalogModelSchema)

let t: ProvidersTestApp

beforeEach(async () => {
  t = await createProvidersTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
})

afterEach(async () => {
  await t.close()
})

function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { origin: ORIGIN } }
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return t.request(path, init)
}

async function errorCode(response: Response): Promise<string> {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error.code
}

describe('gET /api/models', () => {
  it('lists the visible models of enabled providers, mock included', async () => {
    const response = await send('GET', '/api/models')
    expect(response.status).toBe(200)
    const { items } = listSchema.parse(await response.json())
    expect(items.map(item => item.ref)).toEqual(expect.arrayContaining(['mock:echo', 'mock:reasoning', 'mock:tool-approval', 'mock:error', 'anthropic:claude-haiku-4-5']))
    expect(items.every(item => !item.hidden)).toBe(true)
    expect(items.find(item => item.ref === 'mock:reasoning')?.reasoningEfforts).toEqual(['auto', 'off', 'low', 'medium', 'high', 'max'])
  })

  it('filters by provider, shows hidden models on request and rejects unknown providers', async () => {
    await t.deps.catalog.updatePrefs({ providerId: 'mock', modelId: 'error', hidden: true })
    const visible = listSchema.parse(await (await send('GET', '/api/models?providerId=mock')).json())
    // Phase 6: the media models of the mock provider are hidden by default (non-chat kinds); image-chat and image-tool
    // (and workspace, Phase 7; checkpoint and shell, Phase 8; the five agent mocks, Phase 9; agents and background,
    // Phase 10; hooks, Phase 11) are chat models.
    expect(visible.items.map(item => item.id)).toEqual(['agents', 'background', 'checkpoint', 'compact', 'echo', 'hooks', 'image', 'image-chat', 'image-tool', 'plan', 'reasoning', 'shell', 'steer', 'subagent', 'todo', 'tool-approval', 'workspace'])
    const all = listSchema.parse(await (await send('GET', '/api/models?providerId=mock&includeHidden=true')).json())
    expect(all.items.map(item => item.id).sort()).toEqual(['agents', 'background', 'checkpoint', 'compact', 'echo', 'error', 'hooks', 'image', 'image-chat', 'image-tool', 'plan', 'reasoning', 'shell', 'speech', 'steer', 'subagent', 'todo', 'tool-approval', 'transcribe', 'workspace'])
    const unknown = await send('GET', '/api/models?providerId=nope')
    expect(unknown.status).toBe(404)
    expect(await errorCode(unknown)).toBe('not_found')
    expect((await send('GET', '/api/models?providerId=Bad_Id')).status).toBe(400)
  })
})

describe('pOST /api/providers/:id/models/refresh', () => {
  it('refreshes the mock listing', async () => {
    t.events.clear()
    const response = await send('POST', '/api/providers/mock/models/refresh')
    expect(response.status).toBe(200)
    const { items } = listSchema.parse(await response.json())
    // Sorted by name: Mock Agents, Mock Background, Mock Checkpoint, Mock Compact, Mock Echo, Mock Error, Mock Hooks, Mock Image,
    // Mock Image Chat, Mock Image Tool, Mock Plan, Mock Reasoning, Mock Shell, Mock Speech, Mock Steer, Mock Sub-agent,
    // Mock Todo, Mock Tool Approval, Mock Transcribe, Mock Workspace (hidden models included).
    const names = ['agents', 'background', 'checkpoint', 'compact', 'echo', 'error', 'hooks', 'image', 'image-chat', 'image-tool', 'plan', 'reasoning', 'shell', 'speech', 'steer', 'subagent', 'todo', 'tool-approval', 'transcribe', 'workspace']
    expect(items.map(item => [item.id, item.source])).toEqual(names.map(id => [id, 'live']))
    expect(t.events.ofType('catalog.changed').map(event => event.data)).toContainEqual({ providerId: 'mock' })
    expect(t.events.ofType('provider.changed').map(event => event.data.id)).toContain('mock')
  })

  it('answers provider_not_configured without credentials and not_found for unknown providers', async () => {
    const missing = await send('POST', '/api/providers/anthropic/models/refresh')
    expect(missing.status).toBe(400)
    expect(await errorCode(missing)).toBe('provider_not_configured')
    expect((await send('POST', '/api/providers/nope/models/refresh')).status).toBe(404)
  })
})

describe('pUT /api/model-prefs', () => {
  it('updates favorite, alias and hidden', async () => {
    const response = await send('PUT', '/api/model-prefs', { providerId: 'mock', modelId: 'echo', favorite: true, alias: 'Parrot' })
    expect(response.status).toBe(200)
    expect(catalogModelSchema.parse(await response.json())).toMatchObject({ ref: 'mock:echo', favorite: true, alias: 'Parrot', name: 'Parrot' })
    const first = listSchema.parse(await (await send('GET', '/api/models')).json()).items[0]
    expect(first?.ref).toBe('mock:echo')
  })

  it('rejects empty updates, unknown models and model refs in the wrong place', async () => {
    expect((await send('PUT', '/api/model-prefs', { providerId: 'mock', modelId: 'echo' })).status).toBe(400)
    const unknown = await send('PUT', '/api/model-prefs', { providerId: 'mock', modelId: 'nope', favorite: true })
    expect(unknown.status).toBe(404)
    expect((await send('PUT', '/api/model-prefs', { ref: 'mock:echo', favorite: true })).status).toBe(400)
  })
})

describe('custom models', () => {
  it('creates, lists and removes a custom model', async () => {
    const created = await send('POST', '/api/custom-models', { providerId: 'ollama', modelId: 'llama3:8b', name: 'Llama 3 8B', contextWindow: 8192 })
    expect(created.status).toBe(201)
    expect(catalogModelSchema.parse(await created.json())).toMatchObject({ ref: 'ollama:llama3:8b', custom: true, source: 'custom', name: 'Llama 3 8B' })
    const listed = listSchema.parse(await (await send('GET', '/api/models?providerId=ollama')).json())
    expect(listed.items.map(item => item.ref)).toEqual(['ollama:llama3:8b'])
    const removed = await send('DELETE', '/api/custom-models?providerId=ollama&modelId=llama3%3A8b')
    expect(removed.status).toBe(204)
    expect(await removed.text()).toBe('')
    const again = await send('DELETE', '/api/custom-models?providerId=ollama&modelId=llama3%3A8b')
    expect(again.status).toBe(404)
    expect((await send('POST', '/api/custom-models', { providerId: 'nope', modelId: 'x' })).status).toBe(404)
    expect((await send('POST', '/api/custom-models', { providerId: 'ollama', modelId: '' })).status).toBe(400)
  })
})
