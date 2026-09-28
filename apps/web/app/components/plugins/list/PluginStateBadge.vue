<script setup lang="ts">
// State badge of a plugin (docs/UI.md 8.7): Active (success tint), Disabled (muted outline), Loading (spinner),
// Untrusted / Incompatible (warning tint), Error (destructive tint). `message` becomes a tooltip. Tinted badges keep
// foreground text in light mode for contrast (docs/UI.md 14.3).
import type { PluginState } from '@harness-forge/shared'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { PLUGIN_STATE_LABELS } from './plugin-display'

// Attributes (data-testid="plugin-state") go to the badge, not to the renderless tooltip root.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{ state: PluginState, message?: string | null }>(), { message: null })

const STYLES: Record<PluginState, { badge: string, dot: string }> = {
  active: { badge: 'border-transparent bg-success/15 text-foreground dark:text-success', dot: 'bg-success' },
  disabled: { badge: 'border-border bg-transparent text-muted-foreground', dot: 'border-[1.5px] border-muted-foreground' },
  loading: { badge: 'border-transparent bg-muted text-foreground', dot: '' },
  untrusted: { badge: 'border-transparent bg-warning/15 text-foreground dark:text-warning', dot: 'bg-warning' },
  incompatible: { badge: 'border-transparent bg-warning/15 text-foreground dark:text-warning', dot: 'bg-warning' },
  error: { badge: 'border-transparent bg-destructive/12 text-foreground dark:text-destructive', dot: 'bg-destructive' },
}

const style = computed(() => STYLES[props.state])
</script>

<template>
  <Tooltip :disabled="!message">
    <TooltipTrigger as-child>
      <Badge
        variant="outline"
        data-slot="plugin-state-badge"
        :data-state="state"
        :class="cn('gap-1.5 rounded-full font-medium', style.badge)"
        v-bind="$attrs"
      >
        <Spinner v-if="state === 'loading'" aria-hidden="true" class="size-3" />
        <span v-else aria-hidden="true" :class="cn('size-1.5 rounded-full', style.dot)" />
        {{ PLUGIN_STATE_LABELS[state] }}
      </Badge>
    </TooltipTrigger>
    <TooltipContent v-if="message" class="max-w-xs">
      {{ message }}
    </TooltipContent>
  </Tooltip>
</template>
