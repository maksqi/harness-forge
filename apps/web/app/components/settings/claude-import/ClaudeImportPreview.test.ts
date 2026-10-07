// Step 2 of the Import from Claude Code dialog (Phase 12, ADR-055; docs/UI.md 2.19, 9.14, 14.2; W12.10-T2):
// ClaudeImportPreview, ClaudeImportGroup and ClaudeImportItem over a plan with every status and kind: "Found {n} items"
// in a polite region, the groups in order with a mixed Select all, statuses as words, the resolution select from the
// item's actions, the CLAUDE.md mode inside its item, the turned-off notes with their switch and the variable inputs.
import type { ClaudeImportPlan } from '@harness-forge/shared'
import type { ClaudeImportSelection } from './claude-import'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { testIds } from '~/utils/testids'
import { claudeImportItem, claudeImportPlan } from '~/utils/testing/fixtures'
import { defaultSelection } from './claude-import'
import ClaudeImportPreview from './ClaudeImportPreview.vue'

const KEYS = {
  reviewer: 'agent:reviewer:agents/reviewer.md',
  planner: 'agent:planner:agents/planner.md',
  explore: 'agent:explore:agents/explore.md',
  same: 'agent:same:agents/same.md',
  deploy: 'command:deploy:commands/deploy.md',
  guard: 'hook:PreToolUse[0][0]:settings.json',
  tests: 'hook:Stop[0][0]:settings.json',
  github: 'mcp-server:github:.claude.json',
  docs: 'mcp-server:docs:.claude.json#/work/app',
  rule: 'shell-rule:npm run test:settings.json',
  claudeMd: 'instructions:CLAUDE.md:CLAUDE.md',
  secrets: 'permission:allow:Read(./secrets/**):settings.json',
  broken: 'hook:PostToolUse[1][0]:settings.json',
}

function richPlan(): ClaudeImportPlan {
  return claudeImportPlan({
    items: [
      claudeImportItem({ key: KEYS.reviewer }),
      claudeImportItem({ key: KEYS.planner, name: 'planner', source: { file: 'agents/planner.md' }, status: 'update', actions: ['skip', 'overwrite', 'rename'], defaultAction: 'skip', renameTo: 'planner-2' }),
      claudeImportItem({ key: KEYS.explore, name: 'explore', source: { file: 'agents/explore.md' }, status: 'conflict', actions: ['skip', 'rename'], defaultAction: 'skip', renameTo: 'explore-2', warnings: ['linked'] }),
      claudeImportItem({ key: KEYS.same, name: 'same', source: { file: 'agents/same.md' }, status: 'unchanged', actions: [], defaultAction: 'skip' }),
      claudeImportItem({ key: KEYS.deploy, kind: 'command', name: 'deploy', source: { file: 'commands/deploy.md' }, summary: 'Deploys the app', warnings: ['runs-commands'], executable: true }),
      claudeImportItem({ key: KEYS.guard, kind: 'hook', name: 'PreToolUse (Bash)', source: { file: 'settings.json' }, summary: 'Runs a command on PreToolUse for Bash: sh', warnings: ['runs-commands'], executable: true }),
      claudeImportItem({ key: KEYS.tests, kind: 'hook', name: 'Stop', source: { file: 'settings.json' }, summary: 'Asks a model on Stop.' }),
      claudeImportItem({ key: KEYS.github, kind: 'mcp-server', name: 'github', source: { file: '.claude.json' }, summary: 'stdio: npx', warnings: ['runs-commands', 'needs-variables'], variables: ['GITHUB_TOKEN'], executable: true }),
      claudeImportItem({ key: KEYS.docs, kind: 'mcp-server', name: 'docs', source: { file: '.claude.json', project: '/work/app' }, summary: 'http: docs.example.com', warnings: ['project-server'] }),
      claudeImportItem({ key: KEYS.rule, kind: 'shell-rule', name: 'Bash(npm run test)', source: { file: 'settings.json' }, summary: 'npm run test', warnings: ['prefix-broader'] }),
      claudeImportItem({ key: KEYS.claudeMd, kind: 'instructions', name: 'CLAUDE.md', source: { file: 'CLAUDE.md' }, status: 'update', actions: ['append', 'replace', 'skip'], defaultAction: 'append', summary: 'CLAUDE.md (3 lines, 80 characters) becomes part of the global instructions.' }),
      claudeImportItem({ key: KEYS.secrets, kind: 'permission', name: 'Read(./secrets/**)', source: { file: 'settings.json' }, status: 'unsupported', actions: [], defaultAction: 'skip', summary: 'Only allowed Bash commands are imported.' }),
      claudeImportItem({ key: KEYS.broken, kind: 'hook', name: 'PostToolUse', source: { file: 'settings.json' }, status: 'invalid', actions: [], defaultAction: 'skip', summary: 'The hook has no command.', diagnostics: [{ level: 'error', code: 'invalid-handler', message: 'The hook has no command.' }] }),
    ],
  })
}

let latest: ClaudeImportSelection | null = null

/** Mounts the preview with a v-model owner, like the dialog. */
function render(plan: ClaudeImportPlan = richPlan()) {
  latest = defaultSelection(plan)
  const selection = ref<ClaudeImportSelection>(latest)
  return mount(defineComponent({
    setup: () => () => h(ClaudeImportPreview, {
      'plan': plan,
      'selection': selection.value,
      'onUpdate:selection': (value: ClaudeImportSelection) => {
        selection.value = value
        latest = value
      },
    }),
  }), { attachTo: document.body })
}

afterEach(() => {
  document.body.replaceChildren()
  latest = null
})

function byTestId<T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`)
}

function allByTestId(id: string, root: ParentNode = document.body): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
}

function item(name: string): HTMLElement {
  return allByTestId(testIds.claudeImportItem).find(element => element.dataset.name === name)!
}

function group(kind: string): HTMLElement {
  return allByTestId(testIds.claudeImportGroup).find(element => element.dataset.kind === kind)!
}

async function settle() {
  await flushPromises()
  await nextTick()
}

function choose(select: HTMLSelectElement, value: string) {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('claudeImportPreview', () => {
  it('announces the items and lists the groups in order, unsupported last', () => {
    render()
    const found = document.body.querySelector('[role="status"]')!
    expect(found.textContent?.trim()).toBe('Found 13 items')
    expect(found.getAttribute('aria-live')).toBe('polite')
    expect(byTestId(testIds.claudeImportPreview)?.dataset.count).toBe('13')
    expect(allByTestId(testIds.claudeImportGroup).map(element => [element.dataset.kind, element.dataset.count])).toEqual([
      ['agent', '4'],
      ['command', '1'],
      ['hook', '2'],
      ['mcp-server', '2'],
      ['shell-rule', '1'],
      ['instructions', '1'],
      ['unsupported', '2'],
    ])
    const agents = group('agent')
    expect(agents.getAttribute('role')).toBe('group')
    expect(document.getElementById(agents.getAttribute('aria-labelledby')!)?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Agents · 4')
    expect(group('hook').querySelector('h3')?.textContent).toContain('(runs commands)')
    expect(byTestId(testIds.claudeImportSelectAll, group('unsupported'))).toBeNull()
    expect(byTestId(testIds.claudeImportSelect, group('unsupported'))).toBeNull()
  })

  it('shows statuses as words, the file, linked sources and the unsupported reasons', () => {
    render()
    const words = allByTestId(testIds.claudeImportItem).map(element => [element.dataset.name, element.dataset.status, element.querySelector('[data-slot="claude-import-status"]')?.textContent])
    expect(words).toContainEqual(['reviewer', 'new', 'New'])
    expect(words).toContainEqual(['planner', 'update', 'Replaces yours'])
    expect(words).toContainEqual(['explore', 'conflict', 'Conflict'])
    expect(words).toContainEqual(['same', 'unchanged', 'Unchanged'])
    expect(words).toContainEqual(['Read(./secrets/**)', 'unsupported', 'Unsupported'])
    expect(words).toContainEqual(['PostToolUse', 'invalid', 'Invalid'])
    expect(item('explore').textContent).toContain('agents/explore.md · linked')
    expect(item('Read(./secrets/**)').textContent).toContain('Only allowed Bash commands are imported.')
    expect(byTestId(testIds.claudeImportSelect, item('same'))).toBeNull()
    // The invalid item's summary is its only error line (no repeat).
    expect(item('PostToolUse').textContent?.match(/The hook has no command\./g)).toHaveLength(1)
    expect(item('Bash(npm run test)').textContent).toContain('Becomes a prefix rule')
    expect(item('Stop').querySelector('svg')).not.toBeNull()
  })

  it('names each checkbox by kind and name and picks the defaults', () => {
    render()
    expect(byTestId(testIds.claudeImportSelect, item('reviewer'))?.getAttribute('aria-label')).toBe('Agent reviewer')
    expect(byTestId(testIds.claudeImportSelect, item('github'))?.getAttribute('aria-label')).toBe('MCP server github')
    expect(byTestId(testIds.claudeImportSelect, item('reviewer'))?.dataset.state).toBe('checked')
    expect(byTestId(testIds.claudeImportSelect, item('planner'))?.dataset.state).toBe('unchecked')
    expect(byTestId(testIds.claudeImportSelect, item('explore'))?.dataset.state).toBe('unchecked')
  })

  it('reports a mixed Select all and picks or clears every selectable item of its group', async () => {
    render()
    const all = byTestId(testIds.claudeImportSelectAll, group('agent'))!
    expect(all.dataset.state).toBe('indeterminate')
    expect(all.getAttribute('aria-checked')).toBe('mixed')
    expect(all.querySelector('svg')?.getAttribute('class')).toContain('minus')
    expect(group('agent').textContent).toContain('Select all 3')
    all.click()
    await settle()
    expect(latest!.items[KEYS.reviewer]).toEqual({ action: 'import' })
    expect(latest!.items[KEYS.planner]).toEqual({ action: 'overwrite' })
    expect(latest!.items[KEYS.explore]).toEqual({ action: 'rename', renameTo: 'explore-2' })
    expect(Object.hasOwn(latest!.items, KEYS.same)).toBe(false)
    expect(byTestId(testIds.claudeImportSelectAll, group('agent'))!.dataset.state).toBe('checked')
    byTestId(testIds.claudeImportSelectAll, group('agent'))!.click()
    await settle()
    expect([KEYS.reviewer, KEYS.planner, KEYS.explore].some(key => Object.hasOwn(latest!.items, key))).toBe(false)
    expect(latest!.items[KEYS.deploy]).toEqual({ action: 'import' })
  })

  it('offers the resolutions the item allows and keeps the checkbox in step', async () => {
    render()
    const conflict = byTestId<HTMLSelectElement>(testIds.claudeImportResolution, item('explore'))!
    expect([...conflict.options].map(option => [option.value, option.textContent?.trim()])).toEqual([['skip', 'Keep mine'], ['rename', 'Import as explore-2']])
    expect(conflict.dataset.value).toBe('skip')
    choose(conflict, 'rename')
    await settle()
    expect(latest!.items[KEYS.explore]).toEqual({ action: 'rename', renameTo: 'explore-2' })
    expect(byTestId(testIds.claudeImportSelect, item('explore'))?.dataset.state).toBe('checked')
    expect(byTestId(testIds.claudeImportResolution, item('explore'))?.dataset.value).toBe('rename')

    const update = byTestId<HTMLSelectElement>(testIds.claudeImportResolution, item('planner'))!
    expect([...update.options].map(option => option.value)).toEqual(['skip', 'overwrite', 'rename'])
    choose(update, 'overwrite')
    await settle()
    expect(latest!.items[KEYS.planner]).toEqual({ action: 'overwrite' })
    choose(byTestId<HTMLSelectElement>(testIds.claudeImportResolution, item('planner'))!, 'skip')
    await settle()
    expect(Object.hasOwn(latest!.items, KEYS.planner)).toBe(false)
    expect(byTestId(testIds.claudeImportResolution, item('reviewer'))).toBeNull()
  })

  it('puts the CLAUDE.md mode in its item and keeps the selection mode in step', async () => {
    render()
    const mode = byTestId<HTMLSelectElement>(testIds.claudeImportInstructionsMode, item('CLAUDE.md'))!
    expect([...mode.options].map(option => option.textContent?.trim())).toEqual(['Append', 'Replace', 'Skip'])
    expect(mode.dataset.value).toBe('append')
    expect(latest!.instructions).toBe('append')
    expect(byTestId(testIds.claudeImportResolution, item('CLAUDE.md'))).toBeNull()
    choose(mode, 'replace')
    await settle()
    expect(latest!.items[KEYS.claudeMd]).toEqual({ action: 'replace' })
    expect(latest!.instructions).toBe('replace')
    choose(byTestId<HTMLSelectElement>(testIds.claudeImportInstructionsMode)!, 'skip')
    await settle()
    expect(Object.hasOwn(latest!.items, KEYS.claudeMd)).toBe(false)
    expect(latest!.instructions).toBe('skip')
    expect(byTestId(testIds.claudeImportSelect, item('CLAUDE.md'))?.dataset.state).toBe('unchecked')
    byTestId(testIds.claudeImportSelect, item('CLAUDE.md'))!.click()
    await settle()
    expect(latest!.instructions).toBe('append')
  })

  it('offers only Replace and Skip when appending would not fit', () => {
    render(claudeImportPlan({ items: [claudeImportItem({ key: KEYS.claudeMd, kind: 'instructions', name: 'CLAUDE.md', status: 'update', actions: ['replace', 'skip'], defaultAction: 'skip' })] }))
    const mode = byTestId<HTMLSelectElement>(testIds.claudeImportInstructionsMode)!
    expect([...mode.options].map(option => option.value)).toEqual(['replace', 'skip'])
    expect(mode.dataset.value).toBe('skip')
    expect(latest!.instructions).toBe('skip')
  })

  it('imports commands turned off unless their switch is on, and says why', async () => {
    render()
    const deploy = item('deploy')
    const note = deploy.querySelector<HTMLElement>('[data-slot="claude-import-turned-off"]')!
    expect(note.textContent?.trim()).toBe('Imported turned off: it runs shell lines.')
    const toggle = deploy.querySelector<HTMLButtonElement>('[data-action="enable"]')!
    expect(toggle.getAttribute('aria-describedby')).toBe(note.id)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    toggle.click()
    await settle()
    expect(latest!.items[KEYS.deploy]).toEqual({ action: 'import', enable: true })
    item('deploy').querySelector<HTMLButtonElement>('[data-action="enable"]')!.click()
    await settle()
    expect(latest!.items[KEYS.deploy]).toEqual({ action: 'import' })

    expect(item('github').querySelector('[data-slot="claude-import-turned-off"]')?.textContent?.trim()).toBe('Imported turned off: it starts a program.')
    expect(item('docs').querySelector('[data-slot="claude-import-turned-off"]')?.textContent?.trim()).toBe('From the project /work/app: imported turned off.')
    expect(item('docs').querySelector('[data-action="enable"]')).toBeNull()
    expect(item('Stop').querySelector('[data-slot="claude-import-turned-off"]')).toBeNull()
  })

  it('asks for the values an MCP server needs and keeps them in its choice', async () => {
    render()
    const github = item('github')
    expect(github.textContent).toContain('Needs GITHUB_TOKEN')
    const input = github.querySelector<HTMLInputElement>('[data-action="variable"][data-name="GITHUB_TOKEN"]')!
    expect(input.type).toBe('password')
    input.value = 'ghp_value'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(latest!.items[KEYS.github]).toEqual({ action: 'import', variables: { GITHUB_TOKEN: 'ghp_value' } })
    byTestId(testIds.claudeImportSelect, item('github'))!.click()
    await settle()
    expect(Object.hasOwn(latest!.items, KEYS.github)).toBe(false)
    expect(item('github').querySelector<HTMLInputElement>('[data-action="variable"]')!.disabled).toBe(true)
  })
})
