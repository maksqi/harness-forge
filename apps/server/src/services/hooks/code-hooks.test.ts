// The `Notification` → `notification` code hook mapping (Phase 14, ADR-060, W14.3): plugin code hooks receive the
// approval prompt (`permission_prompt`) and the MCP elicitation (`elicitation_dialog`) notification types; any other
// type runs no code hook. A recording registry stands in for `registry.hooks`.
import type { Registry } from '../../registry/types.ts'
import type { HookScope } from './types.ts'
import { describe, expect, it, vi } from 'vitest'
import { codeHookOf, codeNotificationType, runCodeHooks } from './code-hooks.ts'

const SCOPE: HookScope = {
  chatId: '0199a8f0-0000-7000-8000-0000000000c3',
  projectId: null,
  workspace: null,
  toolMode: 'ask',
  origin: 'request',
  modelRef: 'mock:hooks',
}

function recordingRegistry() {
  const run = vi.fn(async (_name: string, _input: unknown, _output: unknown) => {})
  return { registry: { hooks: { run } } as unknown as Pick<Registry, 'hooks'>, run }
}

describe('notification code hooks', () => {
  it('forwards permission_prompt and elicitation_dialog with the message', async () => {
    expect(codeHookOf('Notification')).toBe('notification')
    for (const type of ['permission_prompt', 'elicitation_dialog'] as const) {
      const { registry, run } = recordingRegistry()
      const outcome = await runCodeHooks(registry, 'Notification', SCOPE, { message: 'The fixture needs a few details.', notificationType: type })
      expect(outcome).toMatchObject({ status: 'ok', reason: null, context: null })
      expect(run).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledWith('notification', { chatId: SCOPE.chatId, modelRef: 'mock:hooks', type, message: 'The fixture needs a few details.' }, undefined)
    }
  })

  it('runs no code hook for other or missing notification types', async () => {
    for (const notificationType of ['idle_prompt', 'auth_success', '', undefined]) {
      const { registry, run } = recordingRegistry()
      expect(await runCodeHooks(registry, 'Notification', SCOPE, { message: 'm', ...(notificationType === undefined ? {} : { notificationType }) })).toBeNull()
      expect(run).not.toHaveBeenCalled()
    }
    expect(codeNotificationType('elicitation_dialog')).toBe('elicitation_dialog')
    expect(codeNotificationType('permission_prompt')).toBe('permission_prompt')
    expect(codeNotificationType('__proto__')).toBeNull()
    expect(codeNotificationType(undefined)).toBeNull()
  })

  it('an absent message is an empty string', async () => {
    const { registry, run } = recordingRegistry()
    await runCodeHooks(registry, 'Notification', SCOPE, { notificationType: 'elicitation_dialog' })
    expect(run).toHaveBeenCalledWith('notification', expect.objectContaining({ type: 'elicitation_dialog', message: '' }), undefined)
  })
})
