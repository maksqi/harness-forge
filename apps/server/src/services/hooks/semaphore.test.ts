import { describe, expect, it } from 'vitest'
import { createSemaphore } from './semaphore.ts'

describe('createSemaphore', () => {
  it('admits at most `max` holders and serves the waiters in arrival order', async () => {
    const semaphore = createSemaphore(2)
    const first = await semaphore.acquire()
    const second = await semaphore.acquire()
    expect(semaphore.active()).toBe(2)
    const order: string[] = []
    const third = semaphore.acquire().then((release) => {
      order.push('third')
      return release
    })
    const fourth = semaphore.acquire().then((release) => {
      order.push('fourth')
      return release
    })
    await Promise.resolve()
    expect(semaphore.waiting()).toBe(2)
    expect(order).toEqual([])
    first()
    // Releasing twice frees one slot only.
    first()
    const releaseThird = await third
    expect(order).toEqual(['third'])
    expect(semaphore.active()).toBe(2)
    second()
    const releaseFourth = await fourth
    expect(order).toEqual(['third', 'fourth'])
    releaseThird()
    releaseFourth()
    expect(semaphore.active()).toBe(0)
    expect(semaphore.waiting()).toBe(0)
  })

  it('an abort leaves the queue with the signal reason; an aborted signal never acquires', async () => {
    const semaphore = createSemaphore(1)
    const held = await semaphore.acquire()
    const controller = new AbortController()
    const waiting = semaphore.acquire(controller.signal)
    const next = semaphore.acquire()
    expect(semaphore.waiting()).toBe(2)
    controller.abort(new Error('stopped'))
    await expect(waiting).rejects.toThrow('stopped')
    expect(semaphore.waiting()).toBe(1)
    held()
    const release = await next
    expect(semaphore.active()).toBe(1)
    release()
    await expect(semaphore.acquire(controller.signal)).rejects.toThrow('stopped')
    expect(semaphore.active()).toBe(0)
  })

  it('a non-positive or invalid size admits one holder', async () => {
    for (const size of [0, -3, Number.NaN]) {
      const semaphore = createSemaphore(size)
      const release = await semaphore.acquire()
      let admitted = false
      const second = semaphore.acquire().then((r) => {
        admitted = true
        return r
      })
      await Promise.resolve()
      expect(admitted).toBe(false)
      release();
      (await second)()
    }
  })
})
