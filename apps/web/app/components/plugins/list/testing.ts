// Test helpers for the Plugins tab components (not app code: only *.test.ts files import this module).
import type { Component } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

type RouteTarget = string | { path?: string, query?: Record<string, unknown> }

/** The href a NuxtLink `to` resolves to, with its query string. */
export function hrefOf(to: RouteTarget): string {
  if (typeof to === 'string')
    return to
  const query = new URLSearchParams(
    Object.entries(to.query ?? {})
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  ).toString()
  return `${to.path ?? ''}${query ? `?${query}` : ''}`
}

/** NuxtLink stand-in: an anchor with the resolved href (attributes and listeners fall through to it). */
export const NuxtLinkStub = defineComponent({
  name: 'NuxtLink',
  props: { to: { type: [String, Object], required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: hrefOf(props.to as RouteTarget) }, slots.default?.())
  },
})

/**
 * A stand-in for a component another agent builds (InstallDialog, TrustDialog, TrustWarning, PluginSourceTab,
 * McpServersPanel): a div carrying its props as `data-*` attributes.
 */
export function componentStub(name: string, props: readonly string[], emits: readonly string[] = []) {
  return defineComponent({
    name,
    props: Object.fromEntries(props.map(prop => [prop, null])),
    emits: [...emits],
    setup(values) {
      return () => h('div', {
        'data-stub': name,
        ...Object.fromEntries(props.map(prop => [`data-${prop.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`, JSON.stringify(values[prop] ?? null)])),
      })
    },
  })
}

/** Stubs for every cross-agent component the Plugins tab renders by name, plus NuxtLink. */
export const PLUGIN_STUBS = {
  NuxtLink: NuxtLinkStub,
  InstallDialog: componentStub('InstallDialog', ['open', 'initialSource'], ['update:open', 'installed']),
  TrustDialog: componentStub('TrustDialog', ['open', 'pluginId'], ['update:open', 'trusted']),
  TrustWarning: componentStub('TrustWarning', ['plugin', 'inspection']),
  LazyPluginSourceTab: componentStub('PluginSourceTab', ['pluginId', 'readonly']),
  LazyMcpServersPanel: componentStub('McpServersPanel', ['pluginId']),
}

/** Mounts `component` like the default layout does: inside SidebarProvider and TooltipProvider. */
export function mountInShell(component: Component, props: Record<string, unknown> = {}) {
  return mount({
    render: () => h(SidebarProvider, null, {
      default: () => h(TooltipProvider, null, { default: () => h(component, props) }),
    }),
  }, { attachTo: document.body, global: { stubs: PLUGIN_STUBS } })
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

/** Opens a reka-ui menu or select trigger the way a keyboard user does. */
export async function openWithKeyboard(trigger: Element): Promise<void> {
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()
}
