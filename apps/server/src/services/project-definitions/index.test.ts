// The C43 stub of the project definition editor (P12-0b): the final signature, every member answers `not_implemented`.
// W12.4 replaces these smoke tests with the real behavior.
import type { TestApp } from '../../testing/create-test-app.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createProjectDefinitionsService } from './index.ts'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

const PROJECT = 'prj_AAAAAAAAAAAAAAAA'

describe('createProjectDefinitionsService (C43 stub)', () => {
  it('read, write and remove answer not_implemented', async () => {
    const t = await createTestApp({ start: false })
    apps.push(t)
    const definitions = createProjectDefinitionsService(t.deps)
    await expect(definitions.read(PROJECT, '.claude/agents/reviewer.md', new AbortController().signal)).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(definitions.write(PROJECT, { path: '.claude/agents/reviewer.md', expectedSha256: null, content: '---\nname: reviewer\n---\nReview.' })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(definitions.write(PROJECT, { path: '.mcp.json', expectedSha256: null, mcpServers: {} })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(definitions.remove(PROJECT, '.claude/agents/reviewer.md', 'a'.repeat(64))).rejects.toMatchObject({ code: 'not_implemented' })
    // The deps member is the same stub (no state, no lifecycle).
    await expect(t.deps.projectDefinitions.read(PROJECT, '.harness/settings.json')).rejects.toMatchObject({ code: 'not_implemented' })
  })
})
