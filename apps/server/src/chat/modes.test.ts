// Permission modes (P9-0b, C26-T5 / T7): `applyToolMode` returns the tools unchanged and `checkPlanApprovalMode` accepts
// everything until W9.3; `plan` is accepted by `POST /api/chat` and asks like `ask` (the seam no-op probe).
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import { chatDetailSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../testing/create-test-app.ts'
import { applyToolMode, checkPlanApprovalMode } from './modes.ts'
import { chatBody, postChat, readSse, runnerOf, testChatId } from './testing.ts'

const TOOLS = [
  { pluginId: 'core-workspace', definition: { name: 'write_file', workspace: 'write' as const } },
  { pluginId: 'core-agent', definition: { name: 'exit_plan_mode' } },
]

describe('applyToolMode (stub until W9.3)', () => {
  it('returns every tool and no activeTools in every mode', () => {
    for (const toolMode of ['off', 'ask', 'edits', 'plan', 'auto'] as const) {
      const result = applyToolMode(TOOLS, { toolMode, continuation: null })
      expect(result.tools).toEqual(TOOLS)
      expect(result.tools).not.toBe(TOOLS)
      expect(result.activeTools).toBeUndefined()
    }
  })
})

describe('checkPlanApprovalMode (stub until W9.3)', () => {
  it('accepts every continuation', () => {
    const message: HarnessUIMessage = { id: 'msg_a000000000000001', role: 'assistant', parts: [] }
    expect(() => checkPlanApprovalMode(message, message, 'plan')).not.toThrow()
  })
})

describe('plan mode through POST /api/chat', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
  })

  afterAll(async () => {
    await t.close()
  })

  it('is accepted and asks before a tool call like ask', async () => {
    const chatId = testChatId(9201)
    const response = await postChat(t, chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval', toolMode: 'plan' }))
    expect(response.status).toBe(200)
    const { chunks } = await readSse(response)
    expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(true)
    await runnerOf(t).idle()
    const detail = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
    expect(detail.pendingApproval).toBe(true)
    expect(detail.settings.toolMode).toBe('plan')
  })
})
