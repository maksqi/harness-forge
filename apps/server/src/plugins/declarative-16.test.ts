// Harness manifests of plugin API 1.6.0 (W12.1-T7): `contributes.skills[].baseDir` is registered, prompt hook handlers
// of `contributes.hooks` register with the command handlers (the registry reads them as prompts) and a plugin with
// prompt-only hooks loads without trust; `^1.5.0` manifests load unchanged (`examples.test.ts`: hook-pack, agent-pack).
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginTestApp, manifest, removeTempDirs } from './__fixtures__/harness.ts'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0))
    await close()
  removeTempDirs()
})

describe('a harness manifest of plugin API 1.6.0', () => {
  it('registers skills with baseDir and prompt-only hooks without trust', async () => {
    const h = await createPluginTestApp({
      plugins: [{
        id: 'prompt-pack',
        files: {
          'plugin.json': manifest('prompt-pack', {
            engines: { harness: '^1.6.0' },
            contributes: {
              skills: [{ name: 'house-rules', description: 'House rules.', content: 'Read docs/rules.md.', baseDir: 'docs' }],
              hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the work done? [[ph:ok]]', timeout: 5, statusMessage: 'Checking the work' }] }] },
            },
          }),
          'docs/rules.md': '# Rules\n',
        },
      }],
    })
    closers.push(() => h.close())
    const { plugins: host, registry } = h.t.deps
    const detail = await host.get('prompt-pack')
    expect(detail).toMatchObject({ state: 'active', format: 'harness', runsCode: false, trust: { required: false, trusted: true } })
    expect(registry.skills.get('house-rules')?.definition).toEqual({ name: 'house-rules', description: 'House rules.', content: 'Read docs/rules.md.', baseDir: 'docs' })
    const hooks = registry.hookCommands.get('prompt-pack')!
    expect(hooks.hooks).toEqual([])
    expect(hooks.prompts).toEqual([expect.objectContaining({ event: 'Stop', prompt: 'Is the work done? [[ph:ok]]', timeoutSec: 5, statusMessage: 'Checking the work', continueOnBlock: false })])
    expect(hooks.diagnostics).toEqual([])
    expect(detail.contributions).toMatchObject({ skills: ['house-rules'], commandHooks: 0 })
  })

  it('a command hook next to the prompt hook still needs trust', async () => {
    const h = await createPluginTestApp({
      plugins: [{
        id: 'mixed-pack',
        files: {
          'plugin.json': manifest('mixed-pack', {
            engines: { harness: '^1.6.0' },
            contributes: { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Done?' }, { type: 'command', command: 'sh stop.sh' }] }] } },
          }),
        },
      }],
    })
    closers.push(() => h.close())
    expect(h.t.deps.plugins.state('mixed-pack')).toBe('untrusted')
    expect(h.t.deps.registry.hookCommands.get('mixed-pack')).toBeUndefined()
  })
})
