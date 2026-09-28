// `GET /health` (W1.1-T10, API.md 5.1).
import type { TestApp } from '../../testing/create-test-app.ts'
import process from 'node:process'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { healthSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { packageVersion } from '../../paths.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../../testing/fakes.ts'
import { readHealthVersions } from './health.ts'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function testApp(env: Record<string, string>): Promise<TestApp> {
  const t = await createTestApp({ env, start: false, overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() } })
  apps.push(t)
  return t
}

describe('gET /api/health', () => {
  it('answers the Health DTO, public even with a password, never cached', async () => {
    const t = await testApp({ HF_PASSWORD: 'a password 123', HF_SAFE_MODE: '1', HF_WEB_DIR: '/nonexistent/harness-forge/web' })
    const response = await t.request('/api/health')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const health = healthSchema.parse(await response.json())
    expect(health).toMatchObject({
      ok: true,
      node: process.version,
      safeMode: true,
      pluginApiVersion: PLUGIN_API_VERSION,
      versions: { ai: packageVersion('ai'), hono: packageVersion('hono') },
    })
    expect(health.versions.nuxt).toBeUndefined()
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(health.uptimeSec).toBeGreaterThanOrEqual(0)
  })

  it('reads the library versions from the installed packages', () => {
    const versions = readHealthVersions('/nonexistent/harness-forge/web')
    expect(versions.ai).toMatch(/^7\./)
    expect(versions.hono).toMatch(/^4\./)
    expect(versions).not.toHaveProperty('nuxt')
  })
})
