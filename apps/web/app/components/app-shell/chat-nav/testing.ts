// Test helpers for the W2.4 app-shell components (not app code: only *.test.ts files import this module).
import type { Component } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

/** NuxtLink stand-in: an anchor with the resolved href (attributes and listeners fall through to it). */
export const NuxtLinkStub = defineComponent({
  name: 'NuxtLink',
  props: { to: { type: [String, Object], required: true } },
  setup(props, { slots }) {
    return () => {
      const to = props.to as string | { path: string }
      return h('a', { href: typeof to === 'string' ? to : to.path }, slots.default?.())
    }
  },
})

/** Mounts `component` the way layouts/default.vue does: inside SidebarProvider and TooltipProvider. */
export function mountInShell(component: Component) {
  return mount({
    render: () => h(SidebarProvider, null, {
      default: () => h(TooltipProvider, null, { default: () => h(component) }),
    }),
  }, { attachTo: document.body, global: { stubs: { NuxtLink: NuxtLinkStub } } })
}

/**
 * Mounts a second, standalone component (e.g. a toast) next to a mountInShell() tree. The stubs must match:
 * @vue/test-utils installs them through one global vnode transform, so the last mount's stubs apply to every tree.
 */
export function mountStandalone(component: Component, props: Record<string, unknown> = {}) {
  return mount(component, { props, attachTo: document.body, global: { stubs: { NuxtLink: NuxtLinkStub } } })
}

/** Lets promises, Vue updates and reka-ui's deferred work settle. */
export async function settle(rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await flushPromises()
    await nextTick()
  }
}

export function byTestId<T extends Element = HTMLElement>(id: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`)
}

export function allByTestId<T extends Element = HTMLElement>(id: string, root: ParentNode = document.body): T[] {
  return Array.from(root.querySelectorAll<T>(`[data-testid="${id}"]`))
}

/** A controllable IntersectionObserver: `FakeIntersectionObserver.report(true)` marks every target as visible. */
export class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  readonly targets = new Set<Element>()

  constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit = {}) {
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: Element) {
    this.targets.add(target)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  static report(isIntersecting: boolean) {
    for (const observer of FakeIntersectionObserver.instances) {
      const entries = [...observer.targets].map(target => ({ target, isIntersecting }) as IntersectionObserverEntry)
      if (entries.length > 0)
        observer.callback(entries, observer as unknown as IntersectionObserver)
    }
  }
}

/** Dispatches a keydown on `target` (default: the focused element or body) and returns the event. */
export function press(init: KeyboardEventInit & { key: string }, target?: EventTarget | null): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  ;(target ?? document.activeElement ?? document.body).dispatchEvent(event)
  return event
}
