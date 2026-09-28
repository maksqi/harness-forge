import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../../logger.ts'
import { createSemaphore } from './lock.ts'
import { createStagingArea, prevCopyId } from './staging.ts'
import { removeTempDirs, tempDir } from './testing.ts'

afterEach(() => {
  removeTempDirs()
})

function area(root: string) {
  const pluginsDir = join(root, 'plugins')
  const stagingDir = join(pluginsDir, '.staging')
  mkdirSync(stagingDir, { recursive: true })
  const logs = createMemoryLogger()
  return { pluginsDir, stagingDir, logs, staging: createStagingArea({ pluginsDir, stagingDir, logger: logs.logger }) }
}

const UUID = '0b0f8c2e-6a39-4d4b-9f39-2f1f2f3f4f5f'

describe('staging area', () => {
  it('creates fresh directories and removes only paths inside the staging area', async () => {
    const { stagingDir, staging, pluginsDir } = area(tempDir())
    const first = await staging.create()
    const second = await staging.create()
    expect(first).not.toBe(second)
    expect(first.startsWith(stagingDir)).toBe(true)
    await staging.remove(first)
    expect(existsSync(first)).toBe(false)
    mkdirSync(join(pluginsDir, 'keep'))
    await staging.remove(join(pluginsDir, 'keep'))
    expect(existsSync(join(pluginsDir, 'keep'))).toBe(true)
    expect(staging.prevPath('my-plugin')).toMatch(/\.staging\/my-plugin\.prev-[\da-f-]{36}$/)
  })

  it('restores an interrupted swap and deletes every other staging entry at boot', async () => {
    const root = tempDir()
    const { pluginsDir, stagingDir, staging } = area(root)
    mkdirSync(join(stagingDir, `restore-me.prev-${UUID}`))
    writeFileSync(join(stagingDir, `restore-me.prev-${UUID}`, 'plugin.json'), '{"old":true}')
    mkdirSync(join(pluginsDir, 'present'))
    mkdirSync(join(stagingDir, `present.prev-${UUID}`))
    mkdirSync(join(stagingDir, UUID))
    writeFileSync(join(stagingDir, UUID, 'half.txt'), 'x')
    writeFileSync(join(stagingDir, 'stray-file'), 'x')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep')
    symlinkSync(outside, join(stagingDir, 'link-to-outside'))

    await staging.recover()

    expect(readFileSync(join(pluginsDir, 'restore-me', 'plugin.json'), 'utf8')).toBe('{"old":true}')
    expect(readdirSync(stagingDir)).toEqual([])
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(join(pluginsDir, 'present'))).toEqual([])
  })

  it('recognizes .prev copies', () => {
    expect(prevCopyId(`my-plugin.prev-${UUID}`)).toBe('my-plugin')
    expect(prevCopyId(`Bad_Id.prev-${UUID}`)).toBeNull()
    expect(prevCopyId(UUID)).toBeNull()
  })
})

describe('semaphore', () => {
  it('runs at most n tasks at once, in order', async () => {
    const limit = createSemaphore(2)
    let running = 0
    let peak = 0
    const order: number[] = []
    const task = (index: number) => limit(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(index)
      running -= 1
      return index
    })
    expect(await Promise.all([0, 1, 2, 3, 4].map(task))).toEqual([0, 1, 2, 3, 4])
    expect(peak).toBe(2)
    expect(order.sort()).toEqual([0, 1, 2, 3, 4])
  })
})
