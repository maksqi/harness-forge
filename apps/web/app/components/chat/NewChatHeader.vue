<script setup lang="ts">
// Header of the empty state `/` (docs/UI.md 2.2, 5.6): no title and no menu, only the sidebar trigger while the
// sidebar is collapsed or a sheet (below md), where the page would otherwise offer no way to open it. It floats over
// the page, so the greeting keeps its place whether the trigger shows or not.
import { computed } from 'vue'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { testIds } from '~/utils/testids'

// Outside a SidebarProvider (tests, the auth layout) there is no trigger to show.
const sidebar = useSidebar(null)
const showTrigger = computed(() => !!sidebar && (sidebar.isMobile.value || sidebar.state.value === 'collapsed'))
</script>

<template>
  <header
    v-if="showTrigger"
    data-slot="new-chat-header"
    class="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-(--header-height) items-center px-4 md:px-6"
  >
    <Tooltip>
      <TooltipTrigger as-child>
        <SidebarTrigger
          :data-testid="testIds.sidebarTrigger"
          aria-label="Toggle sidebar"
          class="pointer-events-auto -ml-2 text-muted-foreground hover:text-foreground pointer-coarse:size-10"
        />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Toggle sidebar
        <KbdCombo keys="mod+b" />
      </TooltipContent>
    </Tooltip>
  </header>
</template>
