import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import ModelCaps from './ModelCaps.vue'

type Props = InstanceType<typeof ModelCaps>['$props']

function mountCaps(props: Props) {
  return mount(defineComponent({
    render: () => h(TooltipProvider, null, { default: () => h(ModelCaps, props) }),
  }), { attachTo: document.body })
}

function caps(wrapper: ReturnType<typeof mountCaps>) {
  return wrapper.findAll('[data-value]').map(item => [item.attributes('data-value'), item.get('.sr-only').text()])
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('modelCaps', () => {
  it('shows vision, tools, reasoning, image output and PDF input in order, each with screen reader text', () => {
    const wrapper = mountCaps({ capabilities: { vision: true, tools: true, reasoning: true, imageOutput: true, pdf: true, structuredOutput: true } })
    expect(caps(wrapper)).toEqual([
      ['vision', 'Vision'],
      ['tools', 'Tools'],
      ['reasoning', 'Reasoning'],
      ['imageOutput', 'Image output'],
      ['pdf', 'PDF input'],
    ])
    expect(wrapper.findAll('svg[aria-hidden="true"]')).toHaveLength(5)
    wrapper.unmount()
  })

  it('shows the Image icon "Image output" for a chat model with image output', () => {
    const wrapper = mountCaps({ capabilities: { vision: true, imageOutput: true } })
    expect(caps(wrapper)).toEqual([['vision', 'Vision'], ['imageOutput', 'Image output']])
    expect(wrapper.get('[data-value="imageOutput"] svg').attributes('aria-hidden')).toBe('true')
    wrapper.unmount()
  })

  it('adds the context window and renders nothing without capabilities or context', () => {
    const withContext = mountCaps({ capabilities: { tools: true }, contextWindow: 200_000, size: 'md' })
    expect(withContext.text()).toContain('200K')
    expect(withContext.get('[data-slot="model-caps"]').classes()).toContain('gap-2')
    withContext.unmount()

    const empty = mountCaps({ capabilities: { imageOutput: false, structuredOutput: true } })
    expect(empty.find('[data-slot="model-caps"]').exists()).toBe(false)
    empty.unmount()
  })
})
