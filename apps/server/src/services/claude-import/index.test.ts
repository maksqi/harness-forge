// The C43 stub of the home-folder import (P12-0b): `home()` is real (one `stat` of `HF_CLAUDE_HOME`, never a file
// read) and `GET /claude-import/home` answers through it; scan, upload and apply answer `not_implemented` (their routes
// stay 501 until W12.3). Temp folders only: the real `~/.claude` is never touched.
import type { TestApp } from '../../testing/create-test-app.ts'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { claudeImportHomeSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { claudeImportHome, createClaudeImportService } from './index.ts'

const apps: TestApp[] = []
const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup()
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hf-claude-home-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function app(claudeHome: string): Promise<TestApp> {
  const t = await createTestApp({ start: false, env: { HF_CLAUDE_HOME: claudeHome } })
  apps.push(t)
  return t
}

describe('claudeImportHome (GET /claude-import/home)', () => {
  it('hF_CLAUDE_HOME=0: disabled, no path', async () => {
    expect(await claudeImportHome({ claudeHome: null })).toEqual({ available: false, reason: 'disabled', path: null })
  })

  it('a folder is available; a missing folder, a file or a path through a file is missing', async () => {
    const root = tempDir()
    const home = join(root, '.claude')
    expect(await claudeImportHome({ claudeHome: home })).toEqual({ available: false, reason: 'missing', path: home })
    mkdirSync(home)
    expect(await claudeImportHome({ claudeHome: home })).toEqual({ available: true, path: home })
    writeFileSync(join(root, 'file'), 'x')
    expect(await claudeImportHome({ claudeHome: join(root, 'file') })).toEqual({ available: false, reason: 'missing', path: join(root, 'file') })
    expect(await claudeImportHome({ claudeHome: join(root, 'file', 'inside') })).toEqual({ available: false, reason: 'missing', path: join(root, 'file', 'inside') })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a folder whose parent cannot be searched is unreadable', async () => {
    const root = tempDir()
    const locked = join(root, 'locked')
    mkdirSync(join(locked, '.claude'), { recursive: true })
    chmodSync(locked, 0o000)
    cleanups.push(() => chmodSync(locked, 0o700))
    expect(await claudeImportHome({ claudeHome: join(locked, '.claude') })).toEqual({ available: false, reason: 'unreadable', path: join(locked, '.claude') })
  })

  it('never reads a file of the folder: an unreadable settings.json does not change the answer', async () => {
    const home = join(tempDir(), '.claude')
    mkdirSync(home)
    writeFileSync(join(home, 'settings.json'), '{}')
    chmodSync(join(home, 'settings.json'), 0o000)
    cleanups.push(() => chmodSync(join(home, 'settings.json'), 0o600))
    expect(await claudeImportHome({ claudeHome: home })).toEqual({ available: true, path: home })
  })
})

describe('createClaudeImportService (C43 stub) and the home route', () => {
  it('home answers through the route (HF_CLAUDE_HOME=0 → disabled; a missing folder → missing; a folder → available)', async () => {
    const disabled = await app('0')
    const response = await disabled.request('/api/claude-import/home')
    expect(response.status).toBe(200)
    expect(claudeImportHomeSchema.parse(await response.json())).toEqual({ available: false, reason: 'disabled', path: null })

    const root = tempDir()
    const home = join(root, '.claude')
    const missing = await app(home)
    expect(await (await missing.request('/api/claude-import/home')).json()).toEqual({ available: false, reason: 'missing', path: home })
    mkdirSync(home)
    expect(await (await missing.request('/api/claude-import/home')).json()).toEqual({ available: true, path: home })
  })

  it('scan, upload and apply answer not_implemented; stop resolves; the other routes still answer 501', async () => {
    const t = await app('0')
    const service = createClaudeImportService(t.deps)
    await expect(service.scan({ requireFreshAuth: () => {} })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(service.upload({ label: '.claude', files: [{ path: 'agents/a.md', file: new Blob(['x']) }] })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(service.apply({ planId: 'cip_AAAAAAAAAAAAAAAA', items: [{ key: 'agent:a', action: 'import' }] })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(service.stop()).resolves.toBeUndefined()
    const form = new FormData()
    form.append('files', new Blob(['---\nname: a\n---\nA.']), 'agents/a.md')
    expect((await t.request('/api/claude-import/upload', { method: 'POST', body: form })).status).toBe(501)
  })
})
