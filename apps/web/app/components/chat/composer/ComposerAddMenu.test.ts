// ComposerAddMenu (docs/UI.md 7.7; Phase 14, C54 declares `mentionResources`): the mention item is offered in project chats
// ("Mention a file") and, with `mentionResources`, in any chat ("Mention a file or resource").
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import ComposerAddMenu from './ComposerAddMenu.vue'

afterEach(() => {
  document.body.replaceChildren()
})

async function openMenu(props: { projectChat?: boolean, mentionResources?: boolean }) {
  const wrapper = mount({ render: () => h(TooltipProvider, null, { default: () => h(ComposerAddMenu, props) }) }, { attachTo: document.body })
  const trigger = wrapper.get(`[data-testid="${testIds.composerAdd}"]`)
  await trigger.trigger('pointerdown', { button: 0, ctrlKey: false, pointerType: 'mouse' })
  await trigger.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  return { wrapper, mention: () => document.body.querySelector<HTMLElement>(`[data-testid="${testIds.composerMention}"]`) }
}

describe('composerAddMenu: mention item', () => {
  it('reads "Mention a file" in a project chat and "Mention a file or resource" with MCP resources', async () => {
    const project = await openMenu({ projectChat: true })
    expect(project.mention()?.textContent?.trim()).toBe('Mention a file')
    project.wrapper.unmount()
    document.body.replaceChildren()

    const resources = await openMenu({ mentionResources: true })
    expect(resources.mention()?.textContent?.trim()).toBe('Mention a file or resource')
    resources.wrapper.unmount()
    document.body.replaceChildren()

    const none = await openMenu({})
    expect(document.body.querySelector(`[data-testid="${testIds.composerAttach}"]`)).not.toBeNull()
    expect(none.mention()).toBeNull()
    none.wrapper.unmount()
  })
})
