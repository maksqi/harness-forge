// The C30 stub of the background manager (Phase 10, C30-T3): the final factory signature, every launch a `failed`
// output, the reads empty, the stops null / 0, the lifecycle hooks no-ops. W10.4 replaces the behavior.
import type { TaskInput } from '@harness-forge/shared'
import type { ResolvedModel } from '../../providers/types.ts'
import type { AppDeps } from '../../types.ts'
import type { BackgroundLaunchInput, BackgroundTasksHost } from './types.ts'
import { DEFAULT_SETTINGS, taskOutputSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../../logger.ts'
import { createBackgroundTasks, failedLaunchOutput } from './index.ts'
import { BACKGROUND_RESTARTED_TEXT, BACKGROUND_STOPPED_TEXT, BACKGROUND_UNAVAILABLE_TEXT } from './types.ts'

const CHAT = '0199a8f0-0000-7000-8000-00000000b001'
const TASK: TaskInput = { description: 'Look around', prompt: 'List the files.', type: 'explore', background: true }

function launchInput(): BackgroundLaunchInput {
  return {
    chatId: CHAT,
    messageId: 'msg_aaaaaaaaaaaaaaaa',
    toolCallId: 'call_1',
    task: TASK,
    origin: 'request',
    model: { modelRef: 'mock:background' } as ResolvedModel,
    toolMode: 'ask',
    workspace: null,
    scope: null,
    settings: DEFAULT_SETTINGS,
    reasoningEffort: 'auto',
    chatInstructions: undefined,
    catalog: {} as BackgroundLaunchInput['catalog'],
    logger: createMemoryLogger().logger,
  }
}

function manager(calls: string[] = []): ReturnType<typeof createBackgroundTasks> {
  const host: BackgroundTasksHost = {
    hasRun: (chatId) => {
      calls.push(`hasRun:${chatId}`)
      return false
    },
    startTaskTurn: async () => {
      calls.push('startTaskTurn')
      return new Response(null)
    },
  }
  // The stub never reads its deps or host.
  return createBackgroundTasks(new Proxy({} as AppDeps, { get: (_target, key) => calls.push(`deps.${String(key)}`) }), host, { now: () => 42 })
}

describe('createBackgroundTasks (C30 stub)', () => {
  it('launch answers one failed output naming the agent, the description and the launching model', async () => {
    const calls: string[] = []
    const output = await manager(calls).launch(launchInput())
    expect(output).toEqual({
      status: 'failed',
      type: 'explore',
      description: 'Look around',
      modelRef: 'mock:background',
      steps: [],
      stepsOmitted: 0,
      report: '',
      startedAt: 42,
      finishedAt: 42,
      error: BACKGROUND_UNAVAILABLE_TEXT,
    })
    expect(taskOutputSchema.safeParse(output).success).toBe(true)
    expect(output.taskId).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('every read answers empty, every stop null / 0, the lifecycle hooks resolve', async () => {
    const calls: string[] = []
    const tasks = manager(calls)
    expect(tasks.takeResults(CHAT, 'msg_bbbbbbbbbbbbbbbb')).toEqual([])
    expect(tasks.onChatIdle(CHAT)).toBeUndefined()
    expect(await tasks.list(CHAT)).toEqual([])
    expect(await tasks.stop(CHAT, 'bgt_AAAAAAAAAAAAAAAA')).toBeNull()
    expect(await tasks.stopChat(CHAT)).toBe(0)
    expect(tasks.hasRunning(CHAT)).toBe(false)
    await expect(tasks.start()).resolves.toBeUndefined()
    await expect(tasks.stopAll()).resolves.toBeUndefined()
    await expect(tasks.stopAll()).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('failedLaunchOutput and the contract texts', () => {
    expect(failedLaunchOutput(launchInput(), 'At most 3 background tasks per chat.', 7)).toMatchObject({ status: 'failed', error: 'At most 3 background tasks per chat.', startedAt: 7, finishedAt: 7 })
    expect(BACKGROUND_UNAVAILABLE_TEXT).toBe('Background agents are not available yet.')
    expect(BACKGROUND_STOPPED_TEXT).toBe('The background task was stopped.')
    expect(BACKGROUND_RESTARTED_TEXT).toBe('The server restarted before the task finished.')
  })
})
