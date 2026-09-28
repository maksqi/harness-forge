// Access log (ARCHITECTURE.md 12): share tokens never reach a log record (W5.7-T6, ADR-025: the access log and the
// error handler mask the path segment, the redactor masks `/share/<token>` in messages), and the hint for forwarded
// headers from untrusted peers (W5.7-T4, ADR-026).
import type { LogRecord } from '../../logger.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppEnv } from '../types.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHARE_TOKEN_PATTERN } from '@harness-forge/shared'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../../logger.ts'
import { REDACTED } from '../../security/redact.ts'
import { createTestApp, testBindings } from '../../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../../testing/fakes.ts'
import {
  createUntrustedProxyWarner,
  UNTRUSTED_FORWARDING_MESSAGE,
  UNTRUSTED_FORWARDING_SUPPRESSED_MESSAGE,
  UNTRUSTED_FORWARDING_UNSET_MESSAGE,
} from './proxy-warning.ts'

/** A well-formed share token (16-character share id suffix + 22 base64url characters). */
const TOKEN = 'AbCdEfGh12345678Zz09_-aBcDeFgHiJkLmNoP'
/** The first 14 MAC characters: present in every variant below, so no record may contain them. */
const MAC_PART = TOKEN.slice(16, 30)
const SPA_HTML = '<!DOCTYPE html><html><head><title>spa</title></head><body><div id="__nuxt"></div></body></html>'

function testApp(env: Record<string, string>): Promise<TestApp> {
  return createTestApp({ env, start: false, overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() } })
}

function requestPaths(records: readonly LogRecord[]): unknown[] {
  return records.filter(record => record.msg === 'request').map(record => record.path)
}

describe('share tokens are masked in the access log', () => {
  let webDir: string
  let t: TestApp

  beforeAll(async () => {
    webDir = mkdtempSync(join(tmpdir(), 'harness-forge-access-log-'))
    writeFileSync(join(webDir, '200.html'), SPA_HTML)
    t = await testApp({ HF_WEB_DIR: webDir })
  })

  afterAll(async () => {
    await t.close()
    rmSync(webDir, { recursive: true, force: true })
  })

  it('the sample is a token', () => {
    expect(TOKEN).toMatch(SHARE_TOKEN_PATTERN)
  })

  it.each([
    [`/api/share/${TOKEN}`, `/api/share/${REDACTED}`],
    [`/api/share/${TOKEN}/files/file_0000000000000001`, `/api/share/${REDACTED}/files/file_0000000000000001`],
    [`/api/share/${TOKEN}/nope/more`, `/api/share/${REDACTED}/nope/more`],
    [`/api/share/${TOKEN}x`, `/api/share/${REDACTED}`],
    [`/api/share%2F${TOKEN}`, `/api/share%2F${REDACTED}`],
    [`/share/${TOKEN}`, `/share/${REDACTED}`],
    [`/Share/${TOKEN}`, `/Share/${REDACTED}`],
    [`/share/${TOKEN.slice(0, 30)}`, `/share/${REDACTED}`],
  ])('%s is logged as %s, and no record carries the token', async (path, logged) => {
    const before = t.logs.records.length
    for (const method of ['GET', 'HEAD']) {
      const response = await t.request(path, { method, headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } })
      await response.arrayBuffer()
    }
    const records = t.logs.records.slice(before)
    expect(requestPaths(records)).toEqual([logged, logged])
    expect(JSON.stringify(records)).not.toContain(MAC_PART)
  })

  it('other paths are logged as they are (never the query string)', async () => {
    const before = t.logs.records.length
    await t.request('/api/shares?chatId=0199a8f0-0000-7000-8000-000000000001')
    await t.request('/api/health?token=abc')
    expect(requestPaths(t.logs.records.slice(before))).toEqual(['/api/shares', '/api/health'])
  })
})

describe('forwarded headers from untrusted peers (the HF_TRUST_PROXY hint)', () => {
  const apps: TestApp[] = []

  afterEach(async () => {
    for (const app of apps.splice(0))
      await app.close()
  })

  async function app(env: Record<string, string>): Promise<TestApp> {
    const t = await testApp(env)
    apps.push(t)
    return t
  }

  function warnings(t: TestApp, message: string): LogRecord[] {
    return t.logs.records.filter(record => record.msg === message)
  }

  it('unset: one warning per peer that sends X-Forwarded-For; values are never logged', async () => {
    const t = await app({})
    await t.request('/api/health', { headers: { 'x-forwarded-for': '198.51.100.1' } })
    await t.request('/api/settings', { headers: { 'x-forwarded-for': '198.51.100.2' } })
    // `X-Forwarded-Proto` is still honored from anyone without HF_TRUST_PROXY (v1): nothing to hint at.
    await t.request('/api/health', { headers: { 'x-forwarded-proto': 'https' } }, { remoteAddress: '203.0.113.5' })
    const found = warnings(t, UNTRUSTED_FORWARDING_UNSET_MESSAGE)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ level: 'warn', peer: '127.0.0.1', headers: ['x-forwarded-for'] })
    expect(t.logs.text()).not.toContain('198.51.100.')
  })

  it('set: trusted proxies are quiet, each untrusted peer is reported once', async () => {
    const t = await app({ HF_TRUST_PROXY: 'loopback' })
    await t.request('/api/health', { headers: { 'x-forwarded-for': '198.51.100.1', 'x-forwarded-proto': 'https' } })
    await t.request('/api/health', { headers: { 'x-forwarded-for': '198.51.100.1' } }, { remoteAddress: '::1' })
    await t.request('/api/health', { headers: { 'x-forwarded-proto': 'https' } }, { remoteAddress: '203.0.113.5' })
    await t.request('/api/health', { headers: { 'x-forwarded-for': '198.51.100.1' } }, { remoteAddress: '203.0.113.5' })
    await t.request('/api/health', { headers: { 'x-forwarded-for': '198.51.100.1', 'x-forwarded-proto': 'https' } }, { remoteAddress: '::ffff:203.0.113.6' })
    // Headers that are never honored, from anyone, need no hint.
    await t.request('/api/health', { headers: { 'forwarded': 'for=198.51.100.1', 'x-forwarded-host': 'localhost' } }, { remoteAddress: '203.0.113.7' })
    expect(warnings(t, UNTRUSTED_FORWARDING_UNSET_MESSAGE)).toEqual([])
    expect(warnings(t, UNTRUSTED_FORWARDING_MESSAGE).map(record => [record.level, record.peer, record.headers])).toEqual([
      ['warn', '203.0.113.5', ['x-forwarded-proto']],
      ['warn', '203.0.113.6', ['x-forwarded-for', 'x-forwarded-proto']],
    ])
  })

  it('remembers a bounded number of peers, then says once that it stops', async () => {
    const logs = createMemoryLogger()
    const warn = createUntrustedProxyWarner({ trustProxy: null }, { maxPeers: 2 })
    const probe = new Hono<AppEnv>()
    probe.all('*', (c) => {
      warn(c, logs.logger)
      return c.body(null, 204)
    })
    for (const peer of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4', '198.51.100.1'])
      await probe.request('/x', { headers: { 'x-forwarded-for': '203.0.113.1' } }, testBindings(peer))
    // Without socket bindings there is no peer to report.
    await probe.request('/x', { headers: { 'x-forwarded-for': '203.0.113.1' } })
    expect(logs.records.map(record => record.msg)).toEqual([
      UNTRUSTED_FORWARDING_UNSET_MESSAGE,
      UNTRUSTED_FORWARDING_UNSET_MESSAGE,
      UNTRUSTED_FORWARDING_SUPPRESSED_MESSAGE,
    ])
  })
})
