<script setup lang="ts">
// 8px status dot in a fixed 20px slot, so rows never shift when it appears (docs/UI.md 5.10).
// Needs a TooltipProvider ancestor (app.vue). Pass data-testid through attributes.
import type { StatusDotStatus } from './status'
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { statusDotClasses, statusDotLabels } from './status'

const props = defineProps<{ status: StatusDotStatus, label?: string }>()

const text = computed(() => props.label || statusDotLabels[props.status])
</script>

<template>
  <span
    data-slot="status-dot"
    :data-status="status"
    class="relative inline-flex size-5 shrink-0 items-center justify-center"
  >
    <Tooltip>
      <TooltipTrigger as-child>
        <span aria-hidden="true" class="absolute inset-0 flex items-center justify-center">
          <span :class="cn('size-2 rounded-full', statusDotClasses[status])" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {{ text }}
      </TooltipContent>
    </Tooltip>
    <span class="sr-only">{{ text }}</span>
  </span>
</template>
