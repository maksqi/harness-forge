<script setup lang="ts">
// STUB (C3). W2.4 replaces this file: the Mod+/ list built from the useShortcuts() registry and bound to
// ui.shortcutsOpen (docs/UI.md 10.4, 12). Contract: no props, no emits; mounted once by layouts/default.vue.
// Until then it opens on Mod+/ or on the `hf:open-shortcuts` window event and lists the shortcuts of UI.md 12.
import { useEventListener } from '@vueuse/core'
import { ref } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { testIds } from '~/utils/testids'

const open = ref(false)

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey))
    return
  if (event.code === 'Slash' || event.key === '/') {
    event.preventDefault()
    open.value = !open.value
  }
})
useEventListener(window, 'hf:open-shortcuts', () => {
  open.value = true
})

const groups: Array<{ heading: string, items: Array<{ keys: string, description: string }> }> = [
  {
    heading: 'General',
    items: [
      { keys: 'mod+k', description: 'Search chats and actions' },
      { keys: 'mod+shift+o', description: 'New chat' },
      { keys: 'mod+b', description: 'Toggle sidebar' },
      { keys: 'mod+/', description: 'Show keyboard shortcuts' },
    ],
  },
  {
    heading: 'Chat',
    items: [
      { keys: 'shift+escape', description: 'Focus the composer' },
      { keys: 'alt+m', description: 'Choose model' },
      { keys: 'alt+r', description: 'Set reasoning effort' },
      { keys: 'alt+p', description: 'Set permission mode' },
    ],
  },
  {
    heading: 'Composer',
    items: [
      { keys: 'enter', description: 'Send' },
      { keys: 'shift+enter', description: 'New line' },
      { keys: 'escape', description: 'Stop the response' },
      { keys: 'arrowup', description: 'Edit the last message' },
    ],
  },
]
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :data-testid="testIds.shortcutsDialog" class="gap-5 sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription class="sr-only">
          Shortcuts available in harness-forge.
        </DialogDescription>
      </DialogHeader>
      <div class="grid gap-5">
        <section v-for="group in groups" :key="group.heading" class="grid gap-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">
            {{ group.heading }}
          </h3>
          <dl class="grid">
            <div
              v-for="item in group.items"
              :key="item.keys"
              class="flex h-8 items-center justify-between gap-4 border-b border-border/60 last:border-b-0"
            >
              <dt class="text-sm">
                {{ item.description }}
              </dt>
              <dd>
                <KbdCombo :keys="item.keys" />
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
