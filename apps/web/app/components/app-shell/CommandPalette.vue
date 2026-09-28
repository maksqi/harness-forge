<script setup lang="ts">
// STUB (C3). W2.4 replaces this file: Mod+K palette bound to ui.paletteOpen with chat search and actions, and
// the global shortcuts (useGlobalShortcuts) registered in its setup (docs/UI.md 10.4, 12).
// Contract: no props, no emits; mounted once by layouts/default.vue. Until then it opens on Mod+K or on the
// `hf:open-command-palette` window event (sent by the ChatNav stub) and offers a few static actions.
import type { Component } from 'vue'
import { BlocksIcon, KeyboardIcon, MonitorIcon, MoonIcon, SettingsIcon, SquarePenIcon, SunIcon } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { ref } from 'vue'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { testIds } from '~/utils/testids'
import { navigateTo, useColorMode } from './nuxt-imports'

interface PaletteAction {
  value: string
  label: string
  icon: Component
  keys?: string
  run: () => void
}

const open = ref(false)
const colorMode = useColorMode()

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey))
    return
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault()
    open.value = !open.value
  }
})
useEventListener(window, 'hf:open-command-palette', () => {
  open.value = true
})

function run(action: PaletteAction) {
  open.value = false
  action.run()
}

const groups: Array<{ heading: string, actions: PaletteAction[] }> = [
  {
    heading: 'Go to',
    actions: [
      { value: 'new-chat', label: 'New chat', icon: SquarePenIcon, keys: 'mod+shift+o', run: () => void navigateTo('/') },
      { value: 'plugins', label: 'Plugins', icon: BlocksIcon, run: () => void navigateTo('/plugins') },
      { value: 'settings', label: 'Settings', icon: SettingsIcon, run: () => void navigateTo('/settings/providers') },
    ],
  },
  {
    heading: 'Theme',
    actions: [
      { value: 'theme-dark', label: 'Theme: Dark', icon: MoonIcon, run: () => { colorMode.preference = 'dark' } },
      { value: 'theme-light', label: 'Theme: Light', icon: SunIcon, run: () => { colorMode.preference = 'light' } },
      { value: 'theme-system', label: 'Theme: System', icon: MonitorIcon, run: () => { colorMode.preference = 'system' } },
    ],
  },
  {
    heading: 'Help',
    actions: [
      {
        value: 'shortcuts',
        label: 'Keyboard shortcuts',
        icon: KeyboardIcon,
        keys: 'mod+/',
        run: () => window.dispatchEvent(new CustomEvent('hf:open-shortcuts')),
      },
    ],
  },
]
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :data-testid="testIds.commandPalette"
      :show-close-button="false"
      class="top-[20%] translate-y-0 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-lg"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>Command palette</DialogTitle>
        <DialogDescription>Search chats and run actions.</DialogDescription>
      </DialogHeader>
      <Command class="rounded-xl!">
        <CommandInput :data-testid="testIds.commandPaletteInput" placeholder="Search chats and actions…" />
        <CommandList class="max-h-80 p-1">
          <CommandEmpty class="text-muted-foreground">
            No results
          </CommandEmpty>
          <!-- The heading classes target data-slot because ui/command styles a cmdk attribute reka never sets. -->
          <CommandGroup
            v-for="group in groups"
            :key="group.heading"
            :heading="group.heading"
            class="**:data-[slot=command-group-heading]:px-2 **:data-[slot=command-group-heading]:py-1.5 **:data-[slot=command-group-heading]:text-xs **:data-[slot=command-group-heading]:font-medium **:data-[slot=command-group-heading]:text-muted-foreground"
          >
            <CommandItem
              v-for="action in group.actions"
              :key="action.value"
              :value="action.value"
              :data-testid="testIds.commandPaletteItem"
              :data-value="action.value"
              @select="run(action)"
            >
              <component :is="action.icon" aria-hidden="true" class="text-muted-foreground" />
              <span>{{ action.label }}</span>
              <CommandShortcut v-if="action.keys" class="tracking-normal">
                <KbdCombo :keys="action.keys" />
              </CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>
</template>
