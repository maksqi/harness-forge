// The C43 stubs of the plugin skill-file helpers (P12-0b): the final signatures, an empty list and `not_found` for a
// read; both honor an aborted signal. W12.1 implements them and extends these tests.
import { describe, expect, it } from 'vitest'
import { listPluginSkillFiles, readPluginSkillFile } from './skill-files.ts'

describe('plugin skill files (C43 stubs)', () => {
  it('lists nothing and reads nothing (not_found)', async () => {
    const signal = new AbortController().signal
    expect(await listPluginSkillFiles('/srv/plugins/review-kit', 'skills/pdf', signal)).toEqual([])
    expect(await listPluginSkillFiles('/srv/plugins/review-kit', 'skills/pdf')).toEqual([])
    await expect(readPluginSkillFile('/srv/plugins/review-kit', 'skills/pdf', 'reference.md', signal)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('an aborted signal rejects both', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(listPluginSkillFiles('/srv/plugins/review-kit', 'skills/pdf', controller.signal)).rejects.toThrow('stopped')
    await expect(readPluginSkillFile('/srv/plugins/review-kit', 'skills/pdf', 'reference.md', controller.signal)).rejects.toThrow('stopped')
  })
})
