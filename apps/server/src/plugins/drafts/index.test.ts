import type { PluginManifest } from '@harness-forge/plugin-sdk'
import type { Mock } from 'vitest'
import type { SensitiveOperationOptions } from '../../types.ts'
import type { PluginDraftsService } from './index.ts'
import { Buffer } from 'node:buffer'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HarnessError } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { fixturePath } from '../__fixtures__/harness.ts'
import { createPluginDraftsWith, serializeManifest } from './index.ts'
import { pingMaxOutputTokens } from './test-provider.ts'
import { createInertMcpManager } from './testing.ts'

type TestApp = Awaited<ReturnType<typeof createTestApp>>

let t: TestApp
let drafts: PluginDraftsService

beforeEach(async () => {
  t = await createTestApp({ builtins: [], overrides: { mcp: createInertMcpManager() } })
  drafts = createPluginDraftsWith(t.deps, {})
})

afterEach(async () => {
  await t.close()
})

function fresh(): { requireFreshAuth: Mock<() => void> } {
  return { requireFreshAuth: vi.fn<() => void>() }
}

function refusing(): SensitiveOperationOptions {
  return {
    requireFreshAuth: () => {
      throw new HarnessError({ code: 'forbidden', message: 'Confirm your password.', action: 'login' })
    },
  }
}

const STDIO_SERVER = { id: 'tools', name: 'Local tools', transport: { type: 'stdio' as const, command: 'node', args: ['server.mjs'] } }

function manifest(id: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 1,
    id,
    name: 'Tools',
    version: '1.0.0',
    engines: { harness: '^1.0.0' },
    contributes: { providers: [{ id, name: 'Tools', baseURL: 'http://127.0.0.1:9/v1', apiFormat: 'openai-chat', auth: { type: 'none' }, listModels: false }] },
    ...extra,
  }
}

function withStdio(id: string): PluginManifest {
  const base = manifest(id)
  return { ...base, contributes: { ...base.contributes, mcpServers: [{ ...STDIO_SERVER, id }] } }
}

describe('updateManifest and trust', () => {
  it('removing a stdio server needs no fresh auth and clears the pin', async () => {
    const created = await drafts.create({ manifest: withStdio('tools') }, fresh())
    expect(created.trust).toMatchObject({ required: true, trusted: true })
    const options = fresh()
    const saved = await drafts.updateManifest('tools', { manifest: manifest('tools') }, options)
    expect(options.requireFreshAuth).not.toHaveBeenCalled()
    expect(saved).toMatchObject({ state: 'active', runsCode: false, trust: { required: false, trusted: true, trustedHash: null } })
  })

  it('a stdio plugin whose files changed on disk needs fresh auth for any save', async () => {
    await drafts.create({ manifest: withStdio('tools') }, fresh())
    // Edited outside the wizard: the pin no longer matches.
    const dir = join(t.env.paths.plugins, 'tools')
    writeFileSync(join(dir, 'plugin.json'), serializeManifest({ ...withStdio('tools'), description: 'edited by hand' }))
    const reloaded = await t.deps.plugins.reload('tools')
    expect(reloaded.state).toBe('untrusted')
    await expect(drafts.updateManifest('tools', { manifest: withStdio('tools') }, refusing())).rejects.toMatchObject({ code: 'forbidden' })
    const saved = await drafts.updateManifest('tools', { manifest: withStdio('tools') }, fresh())
    expect(saved).toMatchObject({ state: 'active', trust: { trusted: true } })
  })

  it('changing the command of a stdio server needs fresh auth', async () => {
    await drafts.create({ manifest: withStdio('tools') }, fresh())
    const changed = withStdio('tools')
    changed.contributes!.mcpServers![0]!.transport = { type: 'stdio', command: 'python3', args: ['evil.py'] }
    await expect(drafts.updateManifest('tools', { manifest: changed }, refusing())).rejects.toMatchObject({ code: 'forbidden' })
    expect(readFileSync(join(t.env.paths.plugins, 'tools', 'plugin.json'), 'utf8')).not.toContain('evil.py')
  })

  it('refuses to edit a code plugin', async () => {
    cpSync(fixturePath('dice-roller'), join(t.env.paths.plugins, 'dice-roller'), { recursive: true })
    const inspection = await t.deps.plugins.inspectDirectory(join(t.env.paths.plugins, 'dice-roller'))
    await t.deps.plugins.saveRecord({ id: 'dice-roller', source: 'created', version: '1.0.0', trustedHash: inspection.sha256 })
    await t.deps.plugins.load('dice-roller')
    await expect(drafts.updateManifest('dice-roller', { manifest: manifest('dice-roller') }, fresh())).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('writes an uploaded icon when editing', async () => {
    await drafts.create({ manifest: manifest('tools') }, fresh())
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="2" height="2"/></a></svg>'
    const saved = await drafts.updateManifest('tools', {
      manifest: manifest('tools', { icon: 'icon.svg' }),
      iconFile: { name: 'icon.svg', base64: Buffer.from(svg).toString('base64') },
    }, fresh())
    expect(saved.icon?.color).toMatch(/^\/api\/plugins\/tools\/icon\?v=/)
    expect(readFileSync(join(t.env.paths.plugins, 'tools', 'icon.svg'), 'utf8')).toBe('<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>\n')
  })
})

describe('draft test', () => {
  it('pings with one token, 16 for the Responses API', () => {
    expect(pingMaxOutputTokens({ apiFormat: 'openai-chat' })).toBe(1)
    expect(pingMaxOutputTokens({ apiFormat: 'anthropic' })).toBe(1)
    expect(pingMaxOutputTokens({ apiFormat: 'google' })).toBe(1)
    expect(pingMaxOutputTokens({ apiFormat: 'openai-responses' })).toBe(16)
  })

  it('does not follow a redirect to another origin', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/v1/models' } }))
    const service = createPluginDraftsWith(t.deps, { fetch })
    const result = await service.test({
      provider: { id: 'draft', name: 'Draft', baseURL: 'https://api.example.com/v1', apiFormat: 'openai-chat' },
      credentials: { apiKey: 'sk-secret-value-000000000000' },
      action: 'list-models',
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'provider_error' } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('times out', async () => {
    const fetch = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    }))
    const service = createPluginDraftsWith(t.deps, { fetch: fetch as unknown as typeof globalThis.fetch, timeoutMs: 50 })
    const result = await service.test({
      provider: { id: 'draft', name: 'Draft', baseURL: 'https://api.example.com/v1', apiFormat: 'openai-chat', auth: { type: 'none' } },
      action: 'list-models',
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'provider_unreachable' } })
    expect(result.error?.message).toContain('did not respond in time')
  })
})
