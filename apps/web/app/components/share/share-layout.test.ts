// layouts/share.vue (docs/UI.md 5): the frame of the public share page.
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import ShareLayout from '~/layouts/share.vue'
import { testIds } from '~/utils/testids'

const mocks = vi.hoisted(() => ({ colorMode: null as null | { preference: string, value: string } }))

// ThemeToggle reads the color mode through the shell's nuxt-imports module ('#imports' does not resolve in Vitest).
vi.mock('~/components/app-shell/nuxt-imports', () => ({
  useColorMode: () => mocks.colorMode,
}))

function mountLayout() {
  mocks.colorMode = reactive({ preference: 'dark', value: 'dark' })
  // app.vue provides the TooltipProvider around every layout.
  return mount({
    render: () => h(TooltipProvider, null, {
      default: () => h(ShareLayout, null, { default: () => h('p', { id: 'page' }, 'Snapshot') }),
    }),
  }, { attachTo: document.body })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('share layout', () => {
  it('shows the brand as plain text and the collapsed theme menu in the header', () => {
    const wrapper = mountLayout()
    const header = wrapper.get('header')
    expect(header.find('[data-slot="brand-mark"]').exists()).toBe(true)
    expect(header.text()).toBe('harness-forge')
    expect(header.find('a').exists()).toBe(false)
    const toggle = header.get(`[data-testid="${testIds.themeToggle}"]`)
    expect(toggle.element.tagName).toBe('BUTTON')
    expect(toggle.attributes('aria-haspopup')).toBe('menu')
    expect(toggle.attributes('aria-label')).toBe('Theme: Dark')
    wrapper.unmount()
  })

  it('renders the page in <main> without the app shell or any store', () => {
    // No Pinia is active here: the sidebar, the palette and the dialogs all read stores, so mounting any of them
    // (or anything else that loads a store) would throw.
    const wrapper = mountLayout()
    expect(wrapper.get('main').find('#page').text()).toBe('Snapshot')
    expect(document.body.querySelector(`[data-testid="${testIds.sidebar}"]`)).toBeNull()
    wrapper.unmount()
  })
})
