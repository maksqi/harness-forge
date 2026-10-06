// The C43 stub of the marketplace service (P12-0b): the final signature, an empty list with the suggestions, `get`
// answers `not_found`, the writes `not_implemented`, `stop` a no-op. W12.2 replaces these smoke tests with the real
// behavior.
import type { TestApp } from '../../testing/create-test-app.ts'
import { MARKETPLACE_SUGGESTIONS, marketplaceListSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createMarketplaceService } from './index.ts'
import { GITHUB_API_BASE, GITHUB_CODELOAD_BASE, GITHUB_RAW_BASE } from './types.ts'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function service(): Promise<ReturnType<typeof createMarketplaceService>> {
  const t = await createTestApp({ start: false })
  apps.push(t)
  // The options are accepted (W12.2 uses them); the stub never fetches anything.
  const safeFetch = async (): Promise<never> => {
    throw new Error('no network in the stub')
  }
  return createMarketplaceService(t.deps, { safeFetch, githubApi: 'https://api.test' })
}

describe('createMarketplaceService (C43 stub)', () => {
  it('list answers no marketplace, the official suggestion and no update (a valid MarketplaceList)', async () => {
    const marketplaces = await service()
    const list = await marketplaces.list()
    expect(marketplaceListSchema.parse(list)).toEqual({ items: [], suggestions: [...MARKETPLACE_SUGGESTIONS], updates: [] })
    expect(list.suggestions[0]?.source).toEqual({ type: 'github', repo: 'anthropics/claude-plugins-official' })
  })

  it('get answers not_found; add, refresh and remove answer not_implemented; stop resolves (twice)', async () => {
    const marketplaces = await service()
    await expect(marketplaces.get('mkt_AAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'not_found' })
    await expect(marketplaces.add({ source: { type: 'github', repo: 'acme/tools' } })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(marketplaces.refresh('mkt_AAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(marketplaces.remove('mkt_AAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(marketplaces.stop()).resolves.toBeUndefined()
    await expect(marketplaces.stop()).resolves.toBeUndefined()
  })

  it('the GitHub hosts are https constants', () => {
    expect([GITHUB_API_BASE, GITHUB_RAW_BASE, GITHUB_CODELOAD_BASE]).toEqual(['https://api.github.com', 'https://raw.githubusercontent.com', 'https://codeload.github.com'])
  })
})
