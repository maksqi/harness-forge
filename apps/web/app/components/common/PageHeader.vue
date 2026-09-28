<script setup lang="ts">
// Header for non-chat pages (docs/UI.md 5.6): h-12 bar with the sidebar trigger (only when the sidebar is
// collapsed or on mobile), the page title and an actions slot; optional description below the bar.
import { computed } from 'vue'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import KbdCombo from './KbdCombo.vue'

defineProps<{ title: string, description?: string }>()
defineSlots<{
  /** Buttons and inputs on the right of the title row. */
  actions?: () => any
  /** Extra content under the title row. */
  default?: () => any
}>()

// Outside a SidebarProvider (e.g. the auth layout) there is no trigger to show.
const sidebar = useSidebar(null)
const showTrigger = computed(() => !!sidebar && (sidebar.isMobile.value || sidebar.state.value === 'collapsed'))
</script>

<template>
  <header :data-testid="testIds.pageHeader" data-slot="page-header" class="shrink-0 bg-background">
    <div class="flex h-(--header-height) items-center gap-2">
      <Tooltip v-if="showTrigger">
        <TooltipTrigger as-child>
          <SidebarTrigger
            :data-testid="testIds.sidebarTrigger"
            aria-label="Toggle sidebar"
            class="-ml-2 text-muted-foreground hover:text-foreground pointer-coarse:size-10"
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Toggle sidebar
          <KbdCombo keys="mod+b" />
        </TooltipContent>
      </Tooltip>
      <h1 class="min-w-0 truncate text-xl font-semibold tracking-tight">
        {{ title }}
      </h1>
      <div v-if="$slots.actions" class="ml-auto flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <p v-if="description" class="-mt-1 pb-2 text-sm text-muted-foreground">
      {{ description }}
    </p>
    <slot />
  </header>
</template>
