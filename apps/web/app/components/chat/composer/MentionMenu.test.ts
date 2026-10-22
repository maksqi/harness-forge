import type { ProjectFileEntry } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { testIds } from '~/utils/testids'
import { mcpResourceEntry, projectFileEntry } from '~/utils/testing/fixtures'
import MentionMenu from './MentionMenu.vue'

const items: ProjectFileEntry[] = [projectFileEntry('src/parser.ts'), projectFileEntry('src/parser.test.ts'), projectFileEntry('src/parsers', 'dir')]

const props = {
  open: true,
  query: 'pars',
  items,
  state: 'ready' as const,
  truncated: false,
  projectName: 'harness-forge',
}

function key(init: KeyboardEventInit) {
  return new KeyboardEvent('keydown', { cancelable: true, ...init })
}

const menu = `[data-testid="${testIds.mentionMenu}"]`
const item = `[data-testid="${testIds.mentionMenuItem}"]`

describe('mentionMenu', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the files as a labelled listbox with the state and the count', () => {
    const wrapper = mount(MentionMenu, { props })
    const root = wrapper.get(menu)
    expect(root.attributes()).toMatchObject({ 'role': 'listbox', 'aria-label': 'Files in harness-forge', 'data-state': 'ready', 'data-count': '3' })
    expect(root.attributes('id')).toBe(wrapper.vm.listId)
    expect(root.attributes('aria-busy')).toBeUndefined()
    expect(root.text()).toContain('Files in harness-forge')
    const rows = wrapper.findAll(item)
    expect(rows.map(row => [row.attributes('data-path'), row.attributes('data-kind'), row.attributes('role')])).toEqual([
      ['src/parser.ts', 'file', 'option'],
      ['src/parser.test.ts', 'file', 'option'],
      ['src/parsers', 'dir', 'option'],
    ])
    // Base name first, then the folder (muted); a folder ends with "/".
    expect(rows[0]!.text().replace(/\s+/g, ' ')).toBe('parser.ts src/')
    expect(rows[2]!.text().replace(/\s+/g, ' ')).toBe('parsers/ src/')
    expect(rows[0]!.attributes('aria-selected')).toBe('true')
    expect(wrapper.vm.activeId).toBe(rows[0]!.attributes('id'))
    expect(mount(MentionMenu, { props: { ...props, projectName: null } }).get(menu).attributes('aria-label')).toBe('Files')
  })

  it('highlights the matched characters from scorePath as mark runs', () => {
    const wrapper = mount(MentionMenu, { props: { ...props, items: [projectFileEntry('src/parser.ts')] } })
    const marks = wrapper.findAll('[data-slot="mention-highlight"]')
    expect(marks.map(mark => [mark.element.tagName, mark.text()])).toEqual([['MARK', 'pars']])

    const path = mount(MentionMenu, { props: { ...props, query: 'src/pa', items: [projectFileEntry('src/parser.ts')] } })
    expect(path.findAll('[data-slot="mention-highlight"]').map(mark => mark.text())).toEqual(['pa', 'src/'])

    const empty = mount(MentionMenu, { props: { ...props, query: '' } })
    expect(empty.findAll('[data-slot="mention-highlight"]')).toHaveLength(0)
  })

  it('moves with the arrows and picks with Enter or Tab; Esc closes', async () => {
    const wrapper = mount(MentionMenu, { props })
    const down = key({ key: 'ArrowDown' })
    expect(wrapper.vm.handleKeydown(down)).toBe(true)
    expect(down.defaultPrevented).toBe(true)
    await nextTick()
    expect(wrapper.vm.activeId).toBe(wrapper.findAll(item)[1]!.attributes('id'))
    expect(wrapper.vm.handleKeydown(key({ key: 'ArrowUp' }))).toBe(true)
    expect(wrapper.vm.handleKeydown(key({ key: 'ArrowUp' }))).toBe(true)
    await nextTick()
    expect(wrapper.findAll(item)[2]!.attributes('aria-selected')).toBe('true')

    expect(wrapper.vm.handleKeydown(key({ key: 'Enter' }))).toBe(true)
    expect(wrapper.emitted('select')).toEqual([[items[2]]])
    expect(wrapper.vm.handleKeydown(key({ key: 'Tab' }))).toBe(true)
    expect(wrapper.emitted('select')).toHaveLength(2)

    // Shift+Tab, Shift+Enter and modified keys are left to the textarea.
    expect(wrapper.vm.handleKeydown(key({ key: 'Tab', shiftKey: true }))).toBe(false)
    expect(wrapper.vm.handleKeydown(key({ key: 'Enter', shiftKey: true }))).toBe(false)
    expect(wrapper.vm.handleKeydown(key({ key: 'ArrowDown', altKey: true }))).toBe(false)
    expect(wrapper.vm.handleKeydown(key({ key: 'a' }))).toBe(false)
    expect(wrapper.vm.handleKeydown(key({ key: 'Enter', isComposing: true } as KeyboardEventInit))).toBe(false)

    const escape = key({ key: 'Escape' })
    expect(wrapper.vm.handleKeydown(escape)).toBe(true)
    expect(escape.defaultPrevented).toBe(true)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('starts again at the best match when the results change', async () => {
    const wrapper = mount(MentionMenu, { props })
    wrapper.vm.handleKeydown(key({ key: 'ArrowDown' }))
    await wrapper.setProps({ items: [projectFileEntry('src/parser.ts'), projectFileEntry('README.md')] })
    expect(wrapper.findAll(item)[0]!.attributes('aria-selected')).toBe('true')
    expect(wrapper.findAll(item)[1]!.text()).toBe('README.md')
  })

  it('picks with the mouse without taking the focus', async () => {
    const wrapper = mount(MentionMenu, { props })
    const row = wrapper.findAll(item)[1]!
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    row.element.dispatchEvent(mousedown)
    expect(mousedown.defaultPrevented).toBe(true)
    await row.trigger('pointermove')
    expect(row.attributes('aria-selected')).toBe('true')
    await row.trigger('click')
    expect(wrapper.emitted('select')).toEqual([[items[1]]])
  })

  it('shows "Searching files…" only after 150 ms, keeping the previous rows meanwhile', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MentionMenu, { props: { ...props, items: [], state: 'loading' } })
    expect(wrapper.get(menu).attributes()).toMatchObject({ 'aria-busy': 'true', 'data-state': 'loading', 'data-count': '0' })
    expect(wrapper.text()).not.toContain('Searching files…')
    vi.advanceTimersByTime(149)
    await nextTick()
    expect(wrapper.text()).not.toContain('Searching files…')
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(wrapper.text()).toContain('Searching files…')
    // No key is consumed without rows (Enter sends, Tab moves on).
    expect(wrapper.vm.handleKeydown(key({ key: 'Enter' }))).toBe(false)
    expect(wrapper.vm.handleKeydown(key({ key: 'Tab' }))).toBe(false)
    expect(wrapper.vm.handleKeydown(key({ key: 'ArrowDown' }))).toBe(false)

    await wrapper.setProps({ items, state: 'loading' })
    expect(wrapper.findAll(item)).toHaveLength(3)
    expect(wrapper.text()).not.toContain('Searching files…')
  })

  it('says "No matching files", the error line and the truncation footer', async () => {
    const empty = mount(MentionMenu, { props: { ...props, items: [] } })
    expect(empty.text()).toContain('No matching files')
    expect(empty.vm.activeId).toBeUndefined()
    expect(empty.vm.handleKeydown(key({ key: 'Escape' }))).toBe(true)

    const failed = mount(MentionMenu, { props: { ...props, items: [], state: 'error', errorMessage: 'The project folder is unavailable.' } })
    expect(failed.get(menu).attributes('data-state')).toBe('error')
    expect(failed.text()).toContain('The project folder is unavailable.')
    const generic = mount(MentionMenu, { props: { ...props, items: [], state: 'error' } })
    expect(generic.text()).toContain('Couldn\'t search files.')

    const truncated = mount(MentionMenu, { props: { ...props, truncated: true } })
    expect(truncated.get('[data-slot="mention-truncated"]').text()).toBe('Showing the first 50 matches. Type more to narrow it down.')
    expect(mount(MentionMenu, { props }).find('[data-slot="mention-truncated"]').exists()).toBe(false)
  })

  it('announces the count politely 500 ms after the rows settle', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MentionMenu, { props: { ...props, state: 'loading', items: [] } })
    const announcer = () => wrapper.get('[data-slot="mention-announcer"]')
    expect(announcer().attributes()).toMatchObject({ 'aria-live': 'polite', 'aria-atomic': 'true' })
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(announcer().text()).toBe('')

    await wrapper.setProps({ state: 'ready', items })
    vi.advanceTimersByTime(499)
    await nextTick()
    expect(announcer().text()).toBe('')
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(announcer().text()).toBe('3 files')

    await wrapper.setProps({ items: [projectFileEntry()] })
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(announcer().text()).toBe('1 file')

    await wrapper.setProps({ items: [] })
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(announcer().text()).toBe('No matching files')

    await wrapper.setProps({ open: false })
    expect(announcer().text()).toBe('')
  })

  it('renders nothing while closed and consumes no key', () => {
    const wrapper = mount(MentionMenu, { props: { ...props, open: false } })
    expect(wrapper.find(menu).exists()).toBe(false)
    expect(wrapper.vm.handleKeydown(key({ key: 'ArrowDown' }))).toBe(false)
    expect(wrapper.vm.handleKeydown(key({ key: 'Escape' }))).toBe(false)
    expect(wrapper.vm.activeId).toBeUndefined()
    expect(wrapper.vm.listId).toMatch(/^mention-menu-/)
  })
})

describe('mentionMenu: MCP resources (Phase 14)', () => {
  const resources = [
    mcpResourceEntry(),
    mcpResourceEntry({ serverId: 'fs', serverName: 'Files', uri: 'file:///shot.png', name: 'shot.png', title: 'Screenshot', mimeType: 'image/png' }),
  ]
  const section = `[data-testid="${testIds.mentionMenuSection}"]`
  const resourceRow = `[data-testid="${testIds.mentionMenuResource}"]`

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the files-only menu as it was while the resources are idle', () => {
    const wrapper = mount(MentionMenu, { props: { ...props, resources, resourcesState: 'idle' as const } })
    expect(wrapper.get(menu).attributes()).toMatchObject({ 'aria-label': 'Files in harness-forge', 'data-count': '3' })
    expect(wrapper.findAll(section).map(group => group.attributes('data-value'))).toEqual(['files'])
    expect(wrapper.findAll(resourceRow)).toHaveLength(0)
    const plain = mount(MentionMenu, { props })
    expect(plain.props('resources')).toEqual([])
    expect(plain.props('resourcesState')).toBe('idle')
  })

  it('renders one listbox with two labelled groups, files first, and resource rows with server and MIME type', () => {
    const wrapper = mount(MentionMenu, { props: { ...props, resources, resourcesState: 'ready' as const } })
    const root = wrapper.get(menu)
    expect(root.attributes()).toMatchObject({ 'role': 'listbox', 'aria-label': 'Files and MCP resources', 'data-state': 'ready', 'data-count': '5' })
    const groups = wrapper.findAll(section)
    expect(groups.map(group => [group.attributes('role'), group.attributes('data-value'), wrapper.get(`#${group.attributes('aria-labelledby')}`).text()]))
      .toEqual([['group', 'files', 'Files in harness-forge'], ['group', 'resources', 'MCP resources']])
    const rows = wrapper.findAll(resourceRow)
    expect(rows.map(row => [row.attributes('role'), row.attributes('data-server-id'), row.attributes('data-uri'), row.attributes('aria-label')])).toEqual([
      ['option', 'github', 'repo://owner/name/README.md', 'README.md, GitHub, text/markdown'],
      ['option', 'fs', 'file:///shot.png', 'Screenshot, Files, image/png'],
    ])
    expect(rows[1]!.get('[data-slot="mention-resource-title"]').text()).toBe('Screenshot')
    expect(rows[1]!.get('[data-slot="mention-resource-server"]').text()).toBe('Files')
    expect(rows[1]!.get('[data-slot="mention-resource-mime"]').text()).toBe('image/png')
    expect(rows[0]!.classes()).toContain('pointer-coarse:min-h-10')
    // The option ids run on after the files' ones.
    expect(rows[0]!.attributes('id')).toBe(`${wrapper.vm.listId}-option-3`)
  })

  it('a chat without a project shows only the resources', () => {
    const wrapper = mount(MentionMenu, { props: { ...props, items: [], files: false, projectName: null, resources, resourcesState: 'loading' as const } })
    expect(wrapper.get(menu).attributes()).toMatchObject({ 'aria-label': 'MCP resources', 'data-state': 'loading', 'aria-busy': 'true', 'data-count': '2' })
    expect(wrapper.findAll(section).map(group => group.attributes('data-value'))).toEqual(['resources'])
    expect(wrapper.findAll(item)).toHaveLength(0)
    expect(wrapper.text()).not.toContain('No matching files')
  })

  it('moves across both sections with the arrows and picks a resource with Enter, Tab or a click', async () => {
    const wrapper = mount(MentionMenu, { props: { ...props, resources, resourcesState: 'ready' as const } })
    for (let index = 0; index < 3; index++)
      wrapper.vm.handleKeydown(key({ key: 'ArrowDown' }))
    await nextTick()
    const rows = wrapper.findAll(resourceRow)
    expect(wrapper.vm.activeId).toBe(rows[0]!.attributes('id'))
    expect(rows[0]!.attributes('aria-selected')).toBe('true')
    expect(wrapper.vm.handleKeydown(key({ key: 'Enter' }))).toBe(true)
    expect(wrapper.emitted('select-resource')).toEqual([[resources[0]]])
    expect(wrapper.emitted('select')).toBeUndefined()
    wrapper.vm.handleKeydown(key({ key: 'ArrowDown' }))
    wrapper.vm.handleKeydown(key({ key: 'Tab' }))
    expect(wrapper.emitted('select-resource')).toEqual([[resources[0]], [resources[1]]])
    // Wrapping around from the last resource reaches the first file.
    wrapper.vm.handleKeydown(key({ key: 'ArrowDown' }))
    wrapper.vm.handleKeydown(key({ key: 'Enter' }))
    expect(wrapper.emitted('select')).toEqual([[items[0]]])

    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    rows[1]!.element.dispatchEvent(mousedown)
    expect(mousedown.defaultPrevented).toBe(true)
    await rows[1]!.trigger('click')
    expect(wrapper.emitted('select-resource')).toHaveLength(3)

    // Resources alone: Enter picks the first one.
    const only = mount(MentionMenu, { props: { ...props, items: [], files: false, resources, resourcesState: 'ready' as const } })
    expect(only.vm.handleKeydown(key({ key: 'Enter' }))).toBe(true)
    expect(only.emitted('select-resource')).toEqual([[resources[0]]])
  })

  it('says "Searching resources…" after 150 ms, "No matching resources" and the error line', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MentionMenu, { props: { ...props, resources: [], resourcesState: 'loading' as const } })
    const status = () => wrapper.find('[data-slot="mention-resources-status"]')
    expect(status().exists()).toBe(false)
    vi.advanceTimersByTime(150)
    await nextTick()
    expect(status().text()).toBe('Searching resources…')
    await wrapper.setProps({ resourcesState: 'ready' })
    expect(status().text()).toBe('No matching resources')
    await wrapper.setProps({ resourcesState: 'error' })
    expect(status().text()).toBe('Couldn\'t list MCP resources.')
    expect(status().classes()).toContain('text-destructive')
    // The files keep their own state.
    expect(wrapper.get(menu).attributes('data-state')).toBe('ready')
  })

  it('shows the truncation line and the servers that are not connected', () => {
    const wrapper = mount(MentionMenu, {
      props: { ...props, resources, resourcesState: 'ready' as const, resourcesTruncated: true, resourcesUnavailable: ['Linear', 'docs'] },
    })
    expect(wrapper.get('[data-slot="mention-resources-truncated"]').text()).toBe('Showing the first 50 resources. Type more to narrow it down.')
    expect(wrapper.get('[data-slot="mention-resources-unavailable"]').text()).toBe('Not listed: Linear, docs (not connected).')
    const plain = mount(MentionMenu, { props: { ...props, resources, resourcesState: 'ready' as const } })
    expect(plain.find('[data-slot="mention-resources-truncated"]').exists()).toBe(false)
    expect(plain.find('[data-slot="mention-resources-unavailable"]').exists()).toBe(false)
  })

  it('announces the files and the resources once both settled', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MentionMenu, { props: { ...props, resources: [], resourcesState: 'loading' as const } })
    const announcer = () => wrapper.get('[data-slot="mention-announcer"]')
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(announcer().text()).toBe('')
    await wrapper.setProps({ resources: [resources[0]!], resourcesState: 'ready' })
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(announcer().text()).toBe('3 files, 1 resource')
    await wrapper.setProps({ items: [], files: false })
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(announcer().text()).toBe('1 resource')
  })
})
