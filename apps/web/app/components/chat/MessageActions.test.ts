import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import MessageActions from './MessageActions.vue'

type Props = InstanceType<typeof MessageActions>['$props']

function mountActions(props: Partial<Props> = {}) {
  const events: string[] = []
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(MessageActions, {
        copyText: () => 'text',
        ...props,
        onRegenerate: () => events.push('regenerate'),
        onEdit: () => events.push('edit'),
        onDeleteVersion: () => events.push('delete-version'),
        onRewind: () => events.push('rewind'),
      }, {
        'after-copy': () => h('button', { 'data-testid': 'after-copy' }, 'Read aloud'),
        'default': () => h('span', { 'data-testid': 'meta' }, 'meta'),
      }),
    }),
  }), { attachTo: document.body })
  return { wrapper, events }
}

/** The test ids of the row's children, in order. */
function order(wrapper: ReturnType<typeof mountActions>['wrapper']): Array<string | undefined> {
  const row = wrapper.get('[data-slot="message-actions"]')
  return [...row.element.children].map(child => (child as HTMLElement).dataset.testid)
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('messageActions', () => {
  it('shows Copy, the after-copy slot and the meta by default', () => {
    const { wrapper } = mountActions()
    expect(order(wrapper)).toEqual([testIds.messageCopy, 'after-copy', 'meta'])
  })

  it('hides Copy for a reply without text', () => {
    const { wrapper } = mountActions({ canCopy: false })
    expect(wrapper.find(`[data-testid="${testIds.messageCopy}"]`).exists()).toBe(false)
    expect(order(wrapper)).toEqual(['after-copy', 'meta'])
  })

  it('orders Copy, the after-copy slot, Regenerate, Edit, Delete this version and the meta', () => {
    const { wrapper } = mountActions({ canRegenerate: true, canEdit: true, canDeleteVersion: true })
    expect(order(wrapper)).toEqual([
      testIds.messageCopy,
      'after-copy',
      testIds.messageRegenerate,
      testIds.messageEdit,
      testIds.messageDeleteVersion,
      'meta',
    ])
  })

  it('offers "Delete this version" only when allowed, as a 40px touch target hidden while the transcript is busy', async () => {
    expect(mountActions().wrapper.find(`[data-testid="${testIds.messageDeleteVersion}"]`).exists()).toBe(false)
    const { wrapper, events } = mountActions({ canDeleteVersion: true })
    const button = wrapper.get(`[data-testid="${testIds.messageDeleteVersion}"]`)
    expect(button.attributes('aria-label')).toBe('Delete this version')
    expect(button.classes()).toEqual(expect.arrayContaining(['pointer-coarse:size-10', 'group-data-[busy=true]/transcript:hidden']))
    await button.trigger('click')
    expect(events).toEqual(['delete-version'])
  })

  it('offers "Rewind files to here" after Edit and before Delete this version, only with canRewind (Phase 8)', async () => {
    expect(mountActions({ canEdit: true }).wrapper.find(`[data-testid="${testIds.messageRewind}"]`).exists()).toBe(false)
    const { wrapper, events } = mountActions({ canEdit: true, canRewind: true, canDeleteVersion: true })
    expect(order(wrapper)).toEqual([
      testIds.messageCopy,
      'after-copy',
      testIds.messageEdit,
      testIds.messageRewind,
      testIds.messageDeleteVersion,
      'meta',
    ])
    const button = wrapper.get(`[data-testid="${testIds.messageRewind}"]`)
    expect(button.attributes('aria-label')).toBe('Rewind files to here')
    expect(button.classes()).toEqual(expect.arrayContaining(['pointer-coarse:size-10', 'group-data-[busy=true]/transcript:hidden']))
    await button.trigger('click')
    expect(events).toEqual(['rewind'])
  })

  it('emits regenerate and edit', async () => {
    const { wrapper, events } = mountActions({ canRegenerate: true, canEdit: true })
    await wrapper.get(`[data-testid="${testIds.messageRegenerate}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.messageEdit}"]`).trigger('click')
    expect(events).toEqual(['regenerate', 'edit'])
  })
})
