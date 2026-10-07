import type { HookData } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { MODEL_LABEL_RESOLVER } from '~/components/providers/model-label'
import { testIds } from '~/utils/testids'
import { hookData, hookRecordId } from '~/utils/testing/fixtures'
import HookNote from './HookNote.vue'

function note(data: HookData, variant: 'inline' | 'turn' | 'tool' = 'inline', pluginName: string | null = null) {
  const wrapper = mount(HookNote, { props: { data, variant, pluginName }, attachTo: document.body })
  return { wrapper, root: () => wrapper.get(`[data-testid="${testIds.hookNote}"]`) }
}

const message = { toolCallId: undefined, toolName: undefined }

describe('hookNote', () => {
  it('is a note named "Hook {event}: {summary}" with the event, the outcome, the source and the variant', () => {
    const { root } = note(hookData(), 'tool')
    expect(root().attributes()).toMatchObject({
      'data-event': 'PreToolUse',
      'data-outcome': 'denied',
      'data-source': 'project',
      'data-variant': 'tool',
      'role': 'note',
      'aria-label': 'Hook PreToolUse: Blocked by a PreToolUse hook: Writes to dist/ are not allowed.',
    })
    expect(root().get('[data-slot="hook-note-line"]').text()).toBe('Blocked by a PreToolUse hook: Writes to dist/ are not allowed.')
    expect(root().get('[data-slot="hook-note-source"]').text()).toBe('· Project hook')
    // Denials and stops carry the ShieldBan icon; a denial is destructive.
    expect(root().find('svg').classes().join(' ')).toMatch(/shield-ban/)
    expect(root().find('svg').classes()).toContain('text-destructive')
  })

  it('opens the context with "Show context" (aria-expanded, aria-controls) and closes it with "Hide context"', async () => {
    const data = hookData({ ...message, event: 'SessionStart', outcome: 'context', reason: undefined, context: 'Branch: main\n<b>not html</b>', hooks: [{ source: 'personal', label: 'cat context.md', exitCode: 0, durationMs: 12 }] })
    const { wrapper, root } = note(data)
    expect(root().text()).toContain('Hook added context · SessionStart')
    const toggle = wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`)
    expect(toggle.text()).toBe('Show context')
    expect(toggle.attributes()).toMatchObject({ 'aria-expanded': 'false', 'data-state': 'closed' })
    expect(toggle.attributes('aria-controls')).toBeUndefined()
    expect(wrapper.find(`[data-testid="${testIds.hookNoteDetails}"]`).exists()).toBe(false)

    await toggle.trigger('click')
    const details = wrapper.get(`[data-testid="${testIds.hookNoteDetails}"]`)
    expect(toggle.text()).toBe('Hide context')
    expect(toggle.attributes()).toMatchObject({ 'aria-expanded': 'true', 'data-state': 'open', 'aria-controls': details.attributes('id') })
    const context = details.get('[data-slot="hook-context"]')
    expect(context.element.tagName).toBe('PRE')
    expect(context.text()).toBe('Branch: main\n<b>not html</b>')
    expect(context.find('b').exists()).toBe(false)
    // One source line per hook: the source, the label in mono, the exit code and the duration.
    expect(details.get('[data-slot="hook-source"]').text().replace(/\s+/g, ' ')).toBe('Personal hook · cat context.md · exit 0 · 0.1s')

    await toggle.trigger('click')
    expect(wrapper.find(`[data-testid="${testIds.hookNoteDetails}"]`).exists()).toBe(false)
  })

  it('shows a failed hook with "Show output": each hook\'s error text', async () => {
    const data = hookData({ event: 'PostToolUse', outcome: 'error', reason: undefined, hooks: [
      { source: 'project', label: 'prettier --write', exitCode: 1, durationMs: 2_300, error: 'prettier: not found' },
      { source: 'personal', label: 'pnpm lint', exitCode: 0, durationMs: 400 },
    ] })
    const { wrapper, root } = note(data, 'tool')
    expect(root().text()).toContain('A PostToolUse hook failed: exit 1')
    expect(root().get('[data-slot="hook-note-source"]').text()).toBe('· 2 hooks')
    expect(root().find('svg').classes()).toContain('text-warning')
    const toggle = wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`)
    expect(toggle.text()).toBe('Show output')
    await toggle.trigger('click')
    expect(toggle.text()).toBe('Hide output')
    const details = wrapper.get(`[data-testid="${testIds.hookNoteDetails}"]`)
    expect(details.findAll('[data-slot="hook-output"]').map(output => output.text())).toEqual(['prettier: not found'])
    expect(details.findAll('[data-slot="hook-source"]').map(line => line.text().replace(/\s+/g, ' '))).toEqual([
      'Project hook · prettier --write · exit 1 · 2s',
      'Personal hook · pnpm lint · exit 0 · 0.4s',
    ])
  })

  it('shows each hook\'s system message under the line, always', () => {
    const data = hookData({ hooks: [
      { source: 'project', label: 'guard.sh', exitCode: 2, durationMs: 9, systemMessage: 'Use the staging bucket.' },
      { source: 'personal', label: 'audit.sh', exitCode: 0, durationMs: 9, systemMessage: '  ' },
    ] })
    const { root } = note(data)
    expect(root().findAll('[data-slot="hook-system-message"]').map(line => line.text())).toEqual(['Hook: Use the staging bucket.'])
    // The system message has its own slot: `hook-output` is only a failed hook's error text in the details.
    expect(root().find('[data-slot="hook-output"]').exists()).toBe(false)
  })

  it('keeps the system messages and the error output of a failed hook in separate slots', async () => {
    const data = hookData({ event: 'PostToolUse', outcome: 'error', reason: undefined, hooks: [
      { source: 'project', label: 'prettier --write', exitCode: 1, durationMs: 20, error: 'prettier: not found', systemMessage: 'Formatting skipped.' },
    ] })
    const { wrapper, root } = note(data, 'tool')
    await wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`).trigger('click')
    expect(root().findAll('[data-slot="hook-system-message"]').map(line => line.text())).toEqual(['Hook: Formatting skipped.'])
    const outputs = root().findAll('[data-slot="hook-output"]')
    expect(outputs.map(output => [output.element.tagName, output.text()])).toEqual([['PRE', 'prettier: not found']])
  })

  it('names a plugin hook by the plugin\'s name, other plugins by their id', async () => {
    const data = hookData({ ...message, event: 'Stop', outcome: 'stopped', reason: 'Build is red.', hooks: [
      { source: 'plugin', pluginId: 'hook-pack', label: 'sh "$CLAUDE_PLUGIN_ROOT/stop.sh"', exitCode: 0, durationMs: 50 },
      { source: 'plugin', pluginId: 'other-pack', label: 'other-pack: run.stop', exitCode: null, durationMs: 1_000 },
    ] })
    const { wrapper, root } = note(data, 'inline', 'Hook pack')
    expect(root().text()).toContain('A hook stopped the agent: Build is red.')
    expect(root().attributes('data-source')).toBe('plugin')
    await wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`).trigger('click')
    expect(wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`).text()).toBe('Hide details')
    expect(wrapper.findAll('[data-slot="hook-source"]').map(line => line.text().replace(/\s+/g, ' '))).toEqual([
      'From Hook pack · sh "$CLAUDE_PLUGIN_ROOT/stop.sh" · exit 0 · 0.1s',
      'From other-pack · other-pack: run.stop · 1s',
    ])
  })

  it('shows the input a rewriting hook gave the tool', async () => {
    const data = hookData({ outcome: 'rewritten', reason: undefined, updatedInput: { path: 'src/b.ts', content: 'x' } })
    const { wrapper, root } = note(data, 'tool')
    expect(root().text()).toContain('Input changed by a PreToolUse hook')
    await wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`).trigger('click')
    const details = wrapper.get(`[data-testid="${testIds.hookNoteDetails}"]`)
    expect(details.text()).toContain('Input the tool ran with')
    expect(JSON.parse(details.get('[data-slot="hook-updated-input"]').text())).toEqual({ path: 'src/b.ts', content: 'x' })
  })

  it('shows a PostToolUse block\'s feedback in its details', async () => {
    const data = hookData({ event: 'PostToolUse', outcome: 'blocked', reason: undefined, context: 'Lint errors in src/a.ts\nline 3: no-unused-vars' })
    const { wrapper, root } = note(data, 'tool')
    expect(root().text()).toContain('A PostToolUse hook told the agent: Lint errors in src/a.ts')
    await wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`).trigger('click')
    expect(wrapper.get('[data-slot="hook-context"]').text()).toBe('Lint errors in src/a.ts\nline 3: no-unused-vars')
  })

  it('renders a turn note as a card: the reason as its body and its details always open, without a toggle', () => {
    const data = hookData({ ...message, id: hookRecordId(5), event: 'Stop', outcome: 'continued', reason: 'Tests are failing: fix them before you stop.' })
    const { wrapper, root } = note(data, 'turn')
    expect(root().classes()).toEqual(expect.arrayContaining(['rounded-lg', 'border']))
    expect(root().text()).toContain('A Stop hook asked the agent to continue')
    expect(root().get('[data-slot="hook-note-reason"]').text()).toBe('Tests are failing: fix them before you stop.')
    expect(wrapper.find(`[data-testid="${testIds.hookNoteToggle}"]`).exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${testIds.hookNoteDetails}"]`).text()).toContain('Project hook')
  })

  it('shows only the line of an inline continuation (the carrier below carries the reason)', () => {
    const data = hookData({ ...message, event: 'Stop', outcome: 'continued', reason: 'Run the tests.' })
    const { wrapper, root } = note(data)
    expect(root().find('[data-slot="hook-note-reason"]').exists()).toBe(false)
    expect(root().text()).not.toContain('Run the tests.')
    expect(wrapper.find(`[data-testid="${testIds.hookNoteToggle}"]`).exists()).toBe(true)
  })

  it('has no toggle when nothing is behind it', () => {
    const { wrapper, root } = note(hookData({ outcome: 'allowed', reason: undefined, hooks: [] }), 'tool')
    expect(root().attributes('data-source')).toBeUndefined()
    expect(root().find('[data-slot="hook-note-source"]').exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.hookNoteToggle}"]`).exists()).toBe(false)
  })
})

describe('hookNote: Phase 12 (W12.13-T3)', () => {
  const promptHook = { source: 'project' as const, label: 'Did the tests pass?\nAnswer from $ARGUMENTS', exitCode: null, durationMs: 900, kind: 'prompt' as const, model: 'mock:prompt-hook' }

  it('marks an allow harness-forge did not follow as still asking, with the explanation and the reason in the details', async () => {
    const { wrapper, root } = note(hookData({ outcome: 'allowed', harnessAsked: true, reason: 'The command is read-only.' }), 'tool')
    expect(root().attributes('data-state')).toBe('still-asks')
    expect(root().get('[data-slot="hook-note-line"]').text()).toBe('Allowed by hook · still asks')
    expect(root().attributes('aria-label')).toBe('Hook PreToolUse: Allowed by hook · still asks')
    await wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`).trigger('click')
    const details = wrapper.get('[data-slot="hook-still-asks"]')
    expect(details.text()).toContain('harness-forge still asks for this call (plan mode, a tool that runs commands, or an Always ask policy).')
    expect(details.text()).toContain('The command is read-only.')
    // A plain allow has no state.
    expect(note(hookData({ outcome: 'allowed', reason: undefined })).root().attributes('data-state')).toBeUndefined()
  })

  it('names a prompt hook\'s source and model (the resolver\'s name, else the model id) and its prompt\'s first line', async () => {
    const data = hookData({ event: 'Stop', ...message, outcome: 'continued', reason: 'Run the tests.', hooks: [promptHook] })
    const plain = note(data)
    expect(plain.root().get('[data-slot="hook-note-line"]').text()).toBe('A Stop hook asked the agent to continue')
    expect(plain.root().get('[data-slot="hook-note-source"]').text()).toBe('· Project prompt hook · prompt-hook')

    const named = mount(HookNote, {
      props: { data, variant: 'inline', pluginName: null },
      global: { provide: { [MODEL_LABEL_RESOLVER as symbol]: (ref: string) => (ref === 'mock:prompt-hook' ? { name: 'Prompt Hook Judge' } : null) } },
      attachTo: document.body,
    })
    expect(named.get('[data-slot="hook-note-source"]').text()).toBe('· Project prompt hook · Prompt Hook Judge')
    await named.get(`[data-testid="${testIds.hookNoteToggle}"]`).trigger('click')
    const source = named.get('[data-slot="hook-source"]')
    expect(source.text()).toContain('Project prompt hook · Prompt Hook Judge')
    expect(source.text()).toContain('Did the tests pass?')
    expect(source.text()).not.toContain('$ARGUMENTS')
  })

  it('names a plugin\'s prompt hook "Prompt hook from {plugin}"', () => {
    const { root } = note(hookData({ outcome: 'allowed', reason: undefined, hooks: [{ ...promptHook, source: 'plugin', pluginId: 'review-kit', model: undefined }] }), 'tool', 'Review kit')
    expect(root().get('[data-slot="hook-note-source"]').text()).toBe('· Prompt hook from Review kit')
  })

  it('explains an unreadable prompt hook answer in its output', async () => {
    const { wrapper, root } = note(hookData({ ...message, event: 'Stop', outcome: 'error', reason: undefined, hooks: [promptHook] }))
    expect(root().get('[data-slot="hook-note-line"]').text()).toBe('A Stop hook failed')
    const toggle = wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`)
    expect(toggle.text()).toBe('Show output')
    await toggle.trigger('click')
    expect(wrapper.get('[data-slot="hook-output"]').text()).toBe('The model\'s answer could not be read.')
  })

  // W12.17-T2 (W12.5's records): a prompt hook's "no" that changes nothing (`impossible: true` on Stop / SubagentStop,
  // any "no" on PermissionRequest) is stored as outcome `context` with the answer in `reason` and no `context`.
  const judge = { source: 'personal' as const, label: 'Is the task really done?\nThe event: $ARGUMENTS', exitCode: null, durationMs: 1200, kind: 'prompt' as const, model: 'anthropic:claude-haiku-4-5' }

  it('shows the answer of a Stop or SubagentStop prompt hook whose "no" changes nothing', async () => {
    for (const event of ['Stop', 'SubagentStop'] as const) {
      const data = hookData({ ...message, event, outcome: 'context', context: undefined, reason: 'The deploy needs credentials\nthe agent does not have.', hooks: [judge] })
      const { wrapper, root } = note(data)
      expect(root().attributes()).toMatchObject({ 'data-event': event, 'data-outcome': 'context', 'data-source': 'personal' })
      expect(root().get('[data-slot="hook-note-line"]').text()).toBe(`A ${event} hook answered: The deploy needs credentials the agent does not have.`)
      expect(root().attributes('aria-label')).toBe(`Hook ${event}: A ${event} hook answered: The deploy needs credentials the agent does not have.`)
      expect(root().get('[data-slot="hook-note-source"]').text()).toBe('· Personal prompt hook · claude-haiku-4-5')
      // Not a context: the toggle names the details, which hold no context block and no output.
      const toggle = wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`)
      expect(toggle.text()).toBe('Show details')
      await toggle.trigger('click')
      expect(wrapper.find('[data-slot="hook-context"]').exists()).toBe(false)
      expect(wrapper.find('[data-slot="hook-output"]').exists()).toBe(false)
      const source = wrapper.get('[data-slot="hook-source"]')
      expect(source.text()).toContain('Personal prompt hook · claude-haiku-4-5')
      expect(source.text()).toContain('Is the task really done?')
      expect(source.text()).not.toContain('$ARGUMENTS')
      // A prompt hook has no exit code: the duration alone.
      expect(source.text()).toMatch(/· 1s$/)
      wrapper.unmount()
    }
  })

  it('shows a PermissionRequest prompt hook\'s "no" in its tool row\'s note, from a plugin with the model\'s name', () => {
    const data = hookData({
      id: hookRecordId(7),
      event: 'PermissionRequest',
      outcome: 'context',
      context: undefined,
      reason: 'Deleting files needs a person.',
      hooks: [{ ...judge, source: 'plugin', pluginId: 'review-kit', model: 'mock:prompt-hook' }],
    })
    const named = mount(HookNote, {
      props: { data, variant: 'tool', pluginName: 'Review kit' },
      global: { provide: { [MODEL_LABEL_RESOLVER as symbol]: (ref: string) => (ref === 'mock:prompt-hook' ? { name: 'Prompt Hook Judge' } : null) } },
      attachTo: document.body,
    })
    const root = named.get(`[data-testid="${testIds.hookNote}"]`)
    expect(root.attributes()).toMatchObject({ 'data-event': 'PermissionRequest', 'data-outcome': 'context', 'data-variant': 'tool' })
    expect(root.get('[data-slot="hook-note-line"]').text()).toBe('A PermissionRequest hook answered: Deleting files needs a person.')
    expect(root.get('[data-slot="hook-note-source"]').text()).toBe('· Prompt hook from Review kit · Prompt Hook Judge')
    // Neither a denial nor an error: the plain hook icon.
    expect(root.find('svg').classes().join(' ')).toMatch(/webhook/)
    expect(root.find('svg').classes()).toContain('text-muted-foreground')
  })

  it('shows a PostCompact record\'s system message without claiming a context', async () => {
    const data = hookData({ ...message, event: 'PostCompact', outcome: 'context', reason: undefined, context: undefined, hooks: [{ source: 'personal', label: 'sh log.sh', exitCode: 0, durationMs: 4, systemMessage: 'Saved a copy of the summary.' }] })
    const { wrapper, root } = note(data)
    expect(root().get('[data-slot="hook-note-line"]').text()).toBe('A PostCompact hook sent a message')
    expect(root().get('[data-slot="hook-system-message"]').text()).toBe('Hook: Saved a copy of the summary.')
    expect(wrapper.get(`[data-testid="${testIds.hookNoteToggle}"]`).text()).toBe('Show details')
  })
})
