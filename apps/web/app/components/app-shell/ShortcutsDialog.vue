<script setup lang="ts">
// Keyboard shortcuts dialog (docs/UI.md 10.4, 12): Mod+/ or the command palette. Lists the useShortcuts() registry
// by group (General, Chat, Composer, Editor) with platform key labels (⌘⇧O on macOS, Ctrl Shift O elsewhere).
// Features register their shortcuts while they are on screen (e.g. the composer's Alt shortcuts on chat pages).
// While the `altShortcuts` setting is off, Alt shortcuts read "Off". Bound to ui.shortcutsOpen.
// Contract: no props, no emits; mounted once by layouts/default.vue.
import type { ShortcutDef, ShortcutGroup } from '~/composables/useShortcuts'
import { computed, useId } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { useShortcuts } from '~/composables/useShortcuts'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'

interface ShortcutSection {
  group: ShortcutGroup
  items: ShortcutDef[]
}

const ui = useUiStore()
const settings = useSettingsStore()
const shortcuts = useShortcuts()
const uid = useId()

const open = computed({
  get: () => ui.shortcutsOpen,
  set: (value: boolean) => {
    if (value)
      ui.openShortcuts()
    else
      ui.shortcutsOpen = false
  },
})

/** Same rule as the registry: `alt` when given, else whether the combo holds Alt. */
function isAltShortcut(def: ShortcutDef): boolean {
  return def.alt ?? def.keys.split('+').some(token => ['alt', 'option'].includes(token.trim().toLowerCase()))
}

const altOff = computed(() => !settings.resolved.altShortcuts)

function isOff(def: ShortcutDef): boolean {
  return altOff.value && isAltShortcut(def)
}

/** `list()` is ordered by group and reactive to (un)registrations. */
const sections = computed<ShortcutSection[]>(() => {
  const result: ShortcutSection[] = []
  for (const def of shortcuts.list()) {
    const last = result.at(-1)
    if (last?.group === def.group)
      last.items.push(def)
    else
      result.push({ group: def.group, items: [def] })
  }
  return result
})

const showAltNote = computed(() => altOff.value && sections.value.some(section => section.items.some(isAltShortcut)))

/** A read-only list: focus the dialog itself rather than ringing its close button (Tab still reaches it). */
function onOpenAutoFocus(event: Event) {
  event.preventDefault()
  ;(event.target as HTMLElement | null)?.focus({ preventScroll: true })
}

function headingId(group: ShortcutGroup) {
  return `${uid}-${group.toLowerCase()}`
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :data-testid="testIds.shortcutsDialog" class="gap-5 sm:max-w-md" @open-auto-focus="onOpenAutoFocus">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription class="sr-only">
          Keyboard shortcuts available on this page.
        </DialogDescription>
      </DialogHeader>

      <div class="-mx-1 grid max-h-[min(32rem,65dvh)] gap-5 overflow-y-auto px-1">
        <section
          v-for="section in sections"
          :key="section.group"
          :aria-labelledby="headingId(section.group)"
          :data-group="section.group"
          class="grid gap-1.5"
        >
          <h3 :id="headingId(section.group)" class="text-xs font-medium text-muted-foreground">
            {{ section.group }}
          </h3>
          <dl class="grid">
            <div
              v-for="def in section.items"
              :key="def.id"
              :data-shortcut-id="def.id"
              :data-state="isOff(def) ? 'off' : 'on'"
              class="flex min-h-8 items-center justify-between gap-4 border-b border-border/60 py-1 last:border-b-0"
            >
              <dt :class="cn('min-w-0 text-sm', isOff(def) && 'text-muted-foreground')">
                {{ def.description }}
              </dt>
              <dd class="flex shrink-0 items-center gap-2">
                <span v-if="isOff(def)" class="text-[11px] text-muted-foreground">Off</span>
                <KbdCombo :keys="def.keys" :class="cn(isOff(def) && 'opacity-50')" />
              </dd>
            </div>
          </dl>
        </section>

        <p v-if="sections.length === 0" class="text-sm text-muted-foreground">
          No keyboard shortcuts on this page.
        </p>
      </div>

      <p v-if="showAltNote" class="text-xs text-muted-foreground">
        Alt shortcuts are off. Turn them on in
        <NuxtLink
          to="/settings/general"
          class="text-foreground underline decoration-primary/60 underline-offset-2 hover:decoration-primary"
          @click="open = false"
        >
          <span>Settings → General</span>
        </NuxtLink>.
      </p>
    </DialogContent>
  </Dialog>
</template>
