// Coalesced background refetches: server events arrive in bursts (provider.changed + catalog.changed + ...), and
// each burst should cause one request. Auto-imported (utils/).

export interface CoalescedTask {
  /** Runs the task after `delayMs`; calls in the meantime are merged. A call during a run schedules one more run. */
  schedule: () => void
  /** Drops a scheduled run (a run in progress finishes). */
  cancel: () => void
}

/**
 * Wraps a background task (a refetch) so bursts of triggers run it once. Failures are ignored: background refetches
 * are best effort, and the next trigger or a user action retries.
 */
export function createCoalescedTask(task: () => Promise<unknown>, delayMs = 150): CoalescedTask {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let again = false

  function schedule() {
    if (running) {
      again = true
      return
    }
    if (timer === undefined)
      timer = setTimeout(run, delayMs)
  }

  async function run() {
    timer = undefined
    running = true
    try {
      await task()
    }
    catch {
      // Best effort (see above).
    }
    finally {
      running = false
      if (again) {
        again = false
        schedule()
      }
    }
  }

  function cancel() {
    if (timer !== undefined)
      clearTimeout(timer)
    timer = undefined
    again = false
  }

  return { schedule, cancel }
}
