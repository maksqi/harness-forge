// The OAuth token records (W14.1-T1): one record per origin under the plan's secret names, the mismatch rule, the
// serialized update and the redaction of every token value.
import type { TestApp } from '../../testing/create-test-app.ts'
import type { McpAuthStorage } from './types.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { OAUTH_RECORD_SECRET_NAME } from '../index.ts'
import { projectStorage, userStorage } from './servers.ts'
import { createTokenStore, parseRecord, recordMatches, sameTokens, tokensOf } from './store.ts'

const ACCESS = 'HF_CANARY-oauth-access-7f3a91c2'
const REFRESH = 'HF_CANARY-oauth-refresh-2b8e44d0'
const DYNAMIC_SECRET = 'HF_CANARY-oauth-dyn-secret-91aa'

let t: TestApp

beforeEach(async () => {
  t = await createTestApp({ start: false })
})

afterEach(async () => {
  await t.close()
})

function record(resource: string, clientId: string, dynamic: boolean) {
  return {
    v: 1 as const,
    resource,
    clientId,
    client: { info: { client_id: clientId, ...(dynamic ? { client_secret: DYNAMIC_SECRET } : {}) }, dynamic, redirectUris: ['http://127.0.0.1:8787/oauth/callback'] },
    as: { issuer: 'https://auth.example.com', authorizationServerUrl: 'https://auth.example.com/', tokenEndpoint: 'https://auth.example.com/token' },
    tokens: { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, refresh_token: REFRESH, scope: 'mcp:read', obtainedAt: 1000 },
  }
}

describe('the token store', () => {
  it('keeps one record per origin under the plan\'s secret names', async () => {
    const store = createTokenStore({ secrets: t.deps.secrets, redactor: t.deps.redactor })
    const storages: McpAuthStorage[] = [
      userStorage('docs'),
      { kind: 'plugin', scope: 'plugin:acme', name: 'mcp-oauth.acme-docs' },
      projectStorage('prj_ABCdef0123456789', 'memory'),
    ]
    expect(storages.map(storage => [storage.scope, storage.name])).toEqual([
      ['mcp:docs', OAUTH_RECORD_SECRET_NAME],
      ['plugin:acme', 'mcp-oauth.acme-docs'],
      ['project:prj_ABCdef0123456789', 'mcp-oauth.memory'],
    ])
    for (const [index, storage] of storages.entries())
      await store.write(storage, record(`https://mcp${index}.example.com/mcp`, `client-${index}`, false))
    for (const [index, storage] of storages.entries())
      expect((await store.read(storage))?.resource).toBe(`https://mcp${index}.example.com/mcp`)
    expect(await t.deps.secrets.list('mcp:docs')).toEqual([expect.objectContaining({ name: 'oauth.record' })])
    expect(await store.remove(storages[0]!)).toBe(true)
    expect(await store.read(storages[0]!)).toBeNull()
    expect(await store.read(storages[1]!)).not.toBeNull()
  })

  it('ignores what is not a v1 record', async () => {
    expect(parseRecord('not json')).toBeNull()
    expect(parseRecord(JSON.stringify({ v: 2, resource: 'x', clientId: 'y' }))).toBeNull()
    expect(parseRecord(JSON.stringify({ v: 1, resource: 'https://mcp.example.com/mcp', clientId: 'leak-client', tokens: { access_token: ACCESS, token_type: 'Bearer', obtainedAt: 1 } }))?.clientId).toBe('leak-client')
    const store = createTokenStore({ secrets: t.deps.secrets, redactor: t.deps.redactor })
    await t.deps.secrets.set('mcp:docs', 'oauth.record', '{"v":1}')
    expect(await store.read(userStorage('docs'))).toBeNull()
  })

  it('uses a record only while its resource and client still match the server', () => {
    const configured = record('https://mcp.example.com/mcp', 'client-1', false)
    expect(recordMatches(configured, { url: 'https://mcp.example.com/mcp', clientId: 'client-1' })).toBe(true)
    expect(recordMatches(configured, { url: 'https://MCP.example.com/mcp', clientId: 'client-1' })).toBe(true)
    expect(recordMatches(configured, { url: 'https://mcp.example.com/v2', clientId: 'client-1' })).toBe(false)
    expect(recordMatches(configured, { url: 'https://mcp.example.com/mcp', clientId: 'client-2' })).toBe(false)
    // A configured client's record is not a dynamic one and the reverse.
    expect(recordMatches(configured, { url: 'https://mcp.example.com/mcp', clientId: null })).toBe(false)
    const dynamic = record('https://mcp.example.com/mcp', 'dyn-1', true)
    expect(recordMatches(dynamic, { url: 'https://mcp.example.com/mcp', clientId: null })).toBe(true)
    expect(recordMatches(dynamic, { url: 'https://mcp.example.com/mcp', clientId: 'dyn-1' })).toBe(false)
  })

  it('a mismatched record is replaced by the next save; update can delete and compares token generations', async () => {
    const store = createTokenStore({ secrets: t.deps.secrets, redactor: t.deps.redactor })
    const storage = userStorage('docs')
    await store.write(storage, record('https://old.example.com/mcp', 'client-1', false))
    await store.write(storage, record('https://new.example.com/mcp', 'client-1', false))
    expect((await store.read(storage))?.resource).toBe('https://new.example.com/mcp')
    const current = await store.read(storage)
    expect(sameTokens(tokensOf(current!.tokens!), { access_token: 'other', token_type: 'Bearer', refresh_token: REFRESH })).toBe(true)
    expect(sameTokens(tokensOf(current!.tokens!), { access_token: 'other', token_type: 'Bearer' })).toBe(false)
    expect(tokensOf(current!.tokens!)).not.toHaveProperty('obtainedAt')
    // Concurrent updates are serialized: both see each other's result.
    await Promise.all([
      store.update(storage, value => value === null ? undefined : { ...value, clientId: 'client-1' }),
      store.update(storage, () => null),
    ])
    expect(await store.read(storage)).toBeNull()
    expect(await store.update(storage, value => value === null ? undefined : value)).toBeNull()
  })

  it('registers every token and client secret with the redactor (a logged token is masked)', async () => {
    const store = createTokenStore({ secrets: t.deps.secrets, redactor: t.deps.redactor })
    await store.write(userStorage('docs'), record('https://mcp.example.com/mcp', 'dyn-1', true))
    t.deps.logger.info(`leak attempt ${ACCESS} / ${REFRESH} / ${DYNAMIC_SECRET}`, { note: `copy ${ACCESS}` })
    const logged = JSON.stringify(t.logs.records)
    for (const canary of [ACCESS, REFRESH, DYNAMIC_SECRET])
      expect(logged).not.toContain(canary)
    expect(t.deps.redactor.redactText(`a ${REFRESH} b`)).not.toContain(REFRESH)
  })
})
