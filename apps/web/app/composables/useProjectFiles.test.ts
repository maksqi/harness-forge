import type { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { projectId } from '~/utils/testing/fixtures'
import { useProjectFiles } from './useProjectFiles'

describe('useProjectFiles (P9-0b signature)', () => {
  it('rejects both calls until W9.8 implements them', async () => {
    const files = useProjectFiles()
    const notImplemented = (error: HarnessError) => error.code === 'not_implemented'
    await expect(files.search(projectId(1), 'pars', { limit: 10 })).rejects.toSatisfy(notImplemented)
    await expect(files.attach(projectId(1), 'src/parser.ts')).rejects.toSatisfy(notImplemented)
  })
})
