// The project MCP manager in a chat run (Phase 11, ADR-050; W11.4-T4): the real manager behind the pipeline seam
// (`toolsFor` → `assembleTools({ extraTools, shadowedMcpServers })`) with `mock:hooks` (`mcp?`, `call <tool> <json>`):
// the tools are offered only in the project's chats and run on the stdio fixture. Project config and trust are the C36
// fakes; hooks are the fake service.
import type { ChatRequestBody } from '@harness-forge/shared'
import type { ProjectMcpTestApp } from './project-testing.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { getBuiltinPlugins } from '../builtin-plugins/index.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from '../chat/testing.ts'
import { processAlive, readMcpPids, waitFor } from './__fixtures__/harness.ts'
import { createProjectMcpTestApp, killAll, minServerItem } from './project-testing.ts'

let h: ProjectMcpTestApp | null = null
const strays: Array<number | null> = []

afterEach(async () => {
  await h?.close()
  h = null
  killAll(strays.splice(0))
})

async function reply(app: ProjectMcpTestApp, body: ChatRequestBody): Promise<string> {
  const response = await postChat(app.t, body)
  expect(response.status).toBe(200)
  const text = streamedText((await readSse(response)).chunks)
  await runnerOf(app.t).idle()
  return text
}

describe('project MCP tools in chat runs', () => {
  it('offers the tools only in the project\'s chats and runs them on the project server', async () => {
    const app = await createProjectMcpTestApp({ env: { HF_MOCK_PROVIDER: '1' }, builtins: getBuiltinPlugins({ mockProvider: true }) })
    h = app
    const pidFile = `${app.scratch}/pids`
    const item = minServerItem('My_Server.v2', ['--name', 'proj', '--pid-file', pidFile])
    app.setServers([item])
    await app.approve(item)

    const outside = await reply(app, chatBody(testChatId(1), 'mcp?', { modelRef: 'mock:hooks' }))
    expect(outside).toBe('MCP tools: none')

    const inside = await reply(app, chatBody(testChatId(2), 'mcp?', { modelRef: 'mock:hooks', projectId: app.project.id }))
    expect(inside).toBe('MCP tools: mcp__my-server-v2__echo, mcp__my-server-v2__env, mcp__my-server-v2__pid')
    const { pid } = await readMcpPids(pidFile)
    strays.push(pid)

    const called = await reply(app, chatBody(testChatId(3), 'call mcp__my-server-v2__echo {"text":"hi"}', { modelRef: 'mock:hooks', projectId: app.project.id }))
    expect(called).toContain('Called mcp__my-server-v2__echo: ok | proj echo: hi')

    // Another project's chat gets none of them.
    const other = await reply(app, chatBody(testChatId(4), 'mcp?', { modelRef: 'mock:hooks', projectId: app.other.id }))
    expect(other).toBe('MCP tools: none')

    await app.close()
    await waitFor(() => !processAlive(pid), 8000)
  })
})
