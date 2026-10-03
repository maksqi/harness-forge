<script setup lang="ts">
// The expanded body of an agent tool row (docs/UI.md 7.2, 7.25): the agent view (TodoList or PlanBody, the default
// slot) in the muted body box, then the toggle "Raw input and output" (`tool-raw-toggle`, `data-state` open | closed)
// that shows the generic blocks of the `raw` slot, like WorkspaceToolBody. Store-free (ToolPart and ShareToolRow).
import { ChevronRightIcon } from '@lucide/vue'
import { ref, useId } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'

const slots = defineSlots<{ default?: () => unknown, raw?: () => unknown }>()

const rawOpen = ref(false)
const rawId = useId()
</script>

<template>
  <div data-slot="agent-tool-body" class="flex min-w-0 flex-col gap-2">
    <div class="min-w-0 rounded-md bg-muted/50 p-3">
      <slot />
    </div>
    <template v-if="slots.raw">
      <button
        type="button"
        :data-testid="testIds.toolRawToggle"
        :data-state="rawOpen ? 'open' : 'closed'"
        :aria-expanded="rawOpen"
        :aria-controls="rawOpen ? rawId : undefined"
        class="group/raw flex h-7 items-center gap-1 self-start rounded-sm px-1 -ml-1 font-sans text-[11px] font-medium text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
        @click="rawOpen = !rawOpen"
      >
        Raw input and output
        <ChevronRightIcon
          aria-hidden="true"
          :class="cn('size-3 transition-transform duration-(--duration-base)', rawOpen && 'rotate-90')"
        />
      </button>
      <div v-if="rawOpen" :id="rawId" data-slot="tool-raw" class="flex min-w-0 flex-col gap-3">
        <slot name="raw" />
      </div>
    </template>
  </div>
</template>
