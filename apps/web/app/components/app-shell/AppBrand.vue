<script setup lang="ts">
// Sidebar header (docs/UI.md 5.1): ember mark + mono wordmark + collapse trigger. In icon mode only the mark
// shows and clicking it expands the sidebar (the trigger icon appears on hover); on touch devices it is a 40px target
// like the other rail buttons (docs/UI.md 14.5). On mobile the trigger closes the sheet.
import { PanelLeftIcon, XIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import BrandMark from '~/components/common/BrandMark.vue'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { testIds } from '~/utils/testids'

const { state, isMobile, toggleSidebar, setOpenMobile } = useSidebar()
const iconMode = computed(() => state.value === 'collapsed' && !isMobile.value)
</script>

<template>
  <Tooltip v-if="iconMode">
    <TooltipTrigger as-child>
      <button
        type="button"
        aria-label="Expand sidebar"
        :data-testid="testIds.sidebarTrigger"
        class="group/brand flex size-8 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none transition-colors duration-(--duration-fast) pointer-coarse:size-10 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/50"
        @click="toggleSidebar"
      >
        <BrandMark :size="16" class="group-hover/brand:hidden group-focus-visible/brand:hidden" />
        <PanelLeftIcon aria-hidden="true" class="hidden size-4 group-hover/brand:block group-focus-visible/brand:block" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="right">
      Expand sidebar
      <KbdCombo keys="mod+b" />
    </TooltipContent>
  </Tooltip>

  <div v-else class="flex h-8 items-center gap-2 pr-0.5 pl-2 pointer-coarse:h-10">
    <BrandMark :size="16" />
    <span class="truncate font-mono text-[13px] font-medium tracking-tight text-sidebar-foreground">harness-forge</span>
    <Button
      v-if="isMobile"
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Close sidebar"
      :data-testid="testIds.sidebarTrigger"
      class="ml-auto text-muted-foreground hover:text-foreground pointer-coarse:size-10"
      @click="setOpenMobile(false)"
    >
      <XIcon />
    </Button>
    <Tooltip v-else>
      <TooltipTrigger as-child>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Toggle sidebar"
          :data-testid="testIds.sidebarTrigger"
          class="ml-auto text-muted-foreground hover:bg-sidebar-accent hover:text-foreground pointer-coarse:size-10"
          @click="toggleSidebar"
        >
          <PanelLeftIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Collapse sidebar
        <KbdCombo keys="mod+b" />
      </TooltipContent>
    </Tooltip>
  </div>
</template>
