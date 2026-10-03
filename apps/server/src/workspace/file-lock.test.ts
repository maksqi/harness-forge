import { describe, expect, it } from 'vitest'
import { heldFileLocks, withFileLock } from './file-lock.ts'

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Lets every pending promise callback run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++)
    await Promise.resolve()
}

describe('withFileLock', () => {
  it('two locked sections on one path run one after the other, in call order', async () => {
    const order: string[] = []
    const gate = deferred()
    const first = withFileLock('/srv/demo/a.txt', async () => {
      order.push('first:start')
      await gate.promise
      order.push('first:end')
      return 1
    })
    const second = withFileLock('/srv/demo/a.txt', async () => {
      order.push('second:start')
      return 2
    })
    const third = withFileLock('/srv/demo/./a.txt', () => {
      order.push('third')
      return 3
    })
    await settle()
    expect(order).toEqual(['first:start'])
    expect(heldFileLocks()).toBe(1)
    gate.resolve()
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'third'])
  })

  it('sections on two paths run in parallel', async () => {
    const order: string[] = []
    const gate = deferred()
    const first = withFileLock('/srv/demo/a.txt', async () => {
      order.push('a:start')
      await gate.promise
      order.push('a:end')
    })
    const second = withFileLock('/srv/demo/b.txt', async () => {
      order.push('b')
    })
    await second
    expect(order).toEqual(['a:start', 'b'])
    expect(heldFileLocks()).toBe(1)
    gate.resolve()
    await first
    expect(order).toEqual(['a:start', 'b', 'a:end'])
  })

  it('a throw (sync or async) releases the lock and reaches the caller', async () => {
    await expect(withFileLock('/srv/demo/a.txt', () => {
      throw new Error('sync failure')
    })).rejects.toThrow('sync failure')
    await expect(withFileLock('/srv/demo/a.txt', async () => {
      throw new Error('async failure')
    })).rejects.toThrow('async failure')
    await expect(withFileLock('/srv/demo/a.txt', async () => 'after')).resolves.toBe('after')
  })

  it('a waiter behind a failing holder still runs', async () => {
    const gate = deferred()
    const failing = withFileLock('/srv/demo/a.txt', async () => {
      await gate.promise
      throw new Error('edit failed')
    })
    const waiter = withFileLock('/srv/demo/a.txt', async () => 'ran')
    gate.resolve()
    await expect(failing).rejects.toThrow('edit failed')
    await expect(waiter).resolves.toBe('ran')
  })

  it('leaves no entry behind once the chain is idle', async () => {
    const gate = deferred()
    const sections = Array.from({ length: 5 }, (_, index) => withFileLock(`/srv/demo/${index % 2}.txt`, async () => {
      await gate.promise
      return index
    }))
    await settle()
    expect(heldFileLocks()).toBe(2)
    gate.resolve()
    expect(await Promise.all(sections)).toEqual([0, 1, 2, 3, 4])
    expect(heldFileLocks()).toBe(0)
    const inside = await withFileLock('/srv/demo/x.txt', async () => heldFileLocks())
    expect(inside).toBe(1)
    expect(heldFileLocks()).toBe(0)
  })

  it('serializes read-modify-write sections: no lost update', async () => {
    let content = ''
    const append = (text: string): Promise<void> => withFileLock('/srv/demo/log.txt', async () => {
      const before = content
      await new Promise(resolve => setTimeout(resolve, 1))
      content = `${before}${text}`
    })
    await Promise.all(['a', 'b', 'c', 'd'].map(append))
    expect(content).toBe('abcd')
  })
})
