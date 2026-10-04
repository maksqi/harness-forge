// Test helpers of the background manager (Phase 10, W10.4): scripted detached children behind
// `BackgroundTasksOptions.runChild` (the tests drive each child: progress snapshots, the final output; a stop ends a
// child `aborted`, the deadline `limit`, like W10.3's `runDetachedChild`) and a recording `BackgroundTasksHost`.
import type { ChatRequestBody, TaskOutput, TaskStatus } from '@harness-forge/shared'
import type { DetachedChildInput } from '../subagent/index.ts'
import type { ChatRunOptions } from '../types.ts'
import type { DetachedChildRunner } from './index.ts'
import type { BackgroundTasksHost } from './types.ts'

/** A snapshot of a scripted child (`finishedAt` set for every status but `running`). */
export function childSnapshot(input: DetachedChildInput, status: TaskStatus, extra: Partial<TaskOutput> = {}): TaskOutput {
  return {
    status,
    type: input.task.type,
    description: input.task.description,
    modelRef: 'mock:background',
    steps: [],
    stepsOmitted: 0,
    report: '',
    startedAt: 1,
    ...(status === 'running' ? {} : { finishedAt: 2 }),
    ...extra,
  }
}

/** One scripted child: the test pushes snapshots (`emit`) or ends it (`end`); a stop or the deadline ends it at once. */
export interface ScriptedChild {
  readonly input: DetachedChildInput
  /** Yields a snapshot (default status `running`). */
  readonly emit: (output: Partial<TaskOutput> & { status?: TaskStatus }) => void
  /** Yields the final output (default `completed` with the report "Report: done") and returns. */
  readonly end: (output?: Partial<TaskOutput> & { status?: TaskStatus }) => void
  /** Resolves once the generator returned (its `finally` ran). */
  readonly closed: Promise<void>
}

export interface ScriptedChildren {
  readonly runChild: DetachedChildRunner
  /** Every started child, in order. */
  readonly list: ScriptedChild[]
  /** Resolves with child `n` (1-based) once it was started. */
  readonly started: (n: number) => Promise<ScriptedChild>
}

/**
 * Scripted children. `ignoreAbort` makes children that never react to their signal (stuck children). A stop ends a child
 * with `aborted` (report "partial"), the deadline with `limit`.
 */
export function scriptedChildren(options: { ignoreAbort?: boolean } = {}): ScriptedChildren {
  const list: ScriptedChild[] = []
  const waiters: Array<{ n: number, resolve: (child: ScriptedChild) => void }> = []
  const runChild: DetachedChildRunner = (input) => {
    const pending: TaskOutput[] = []
    let wake: (() => void) | null = null
    const push = (value: TaskOutput): void => {
      pending.push(value)
      wake?.()
    }
    let closedResolve!: () => void
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve
    })
    const child: ScriptedChild = {
      input,
      emit: output => push(childSnapshot(input, output.status ?? 'running', output)),
      end: output => push(childSnapshot(input, output?.status ?? 'completed', { report: 'Report: done', ...output })),
      closed,
    }
    list.push(child)
    for (const waiter of [...waiters]) {
      if (list.length >= waiter.n) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(list[waiter.n - 1]!)
      }
    }
    const signal = input.session.ctx.run.signal
    return (async function* () {
      try {
        yield childSnapshot(input, 'running')
        for (;;) {
          if (signal.aborted && options.ignoreAbort !== true) {
            const limit = input.deadline?.aborted === true
            yield childSnapshot(input, limit ? 'limit' : 'aborted', { report: 'partial', error: limit ? 'child deadline' : 'child stopped' })
            return
          }
          const next = pending.shift()
          if (next === undefined) {
            await new Promise<void>((resolve) => {
              wake = resolve
              if (options.ignoreAbort !== true)
                signal.addEventListener('abort', () => resolve(), { once: true })
            })
            wake = null
            continue
          }
          yield next
          if (next.status !== 'running' && next.status !== 'queued')
            return
        }
      }
      finally {
        closedResolve()
      }
    })()
  }
  return {
    runChild,
    list,
    started: n => (list.length >= n ? Promise.resolve(list[n - 1]!) : new Promise(resolve => waiters.push({ n, resolve }))),
  }
}

/** A host that records the task turns it is asked to start (nothing runs). */
export interface RecordingHost extends BackgroundTasksHost {
  readonly turns: Array<{ body: ChatRequestBody, options: ChatRunOptions }>
  /** Chats a run holds (`hasRun`). */
  readonly held: Set<string>
  /** The next starts fail with these errors, one each. */
  readonly failures: unknown[]
}

export function recordingHost(): RecordingHost {
  const turns: RecordingHost['turns'] = []
  const held = new Set<string>()
  const failures: unknown[] = []
  return {
    turns,
    held,
    failures,
    hasRun: chatId => held.has(chatId),
    startTaskTurn: async (body, options) => {
      const failure = failures.shift()
      if (failure !== undefined)
        throw failure
      turns.push({ body, options })
      return new Response('data: [DONE]\n\n')
    },
  }
}
