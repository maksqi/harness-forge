<script setup lang="ts">
// Provider status badge (docs/UI.md 9.1): Connected (success tint), Not configured (outline, muted),
// From env (info tint), Error 401 (destructive tint; the upstream status). `message` becomes a tooltip.
// Tinted badges keep text-foreground in light mode for contrast (docs/UI.md 14.3).
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Attributes (data-testid="provider-status") go to the badge, not to the renderless tooltip root.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  status: ProviderStatusLike
  httpStatus?: number
  message?: string
}>(), {
  httpStatus: undefined,
  message: undefined,
})

/** `ProviderStatus` of docs/DECISIONS.md. */
type ProviderStatusLike = 'connected' | 'not_configured' | 'env' | 'error'

const label = computed(() => {
  switch (props.status) {
    case 'connected':
      return 'Connected'
    case 'env':
      return 'From env'
    case 'error':
      return props.httpStatus ? `Error ${props.httpStatus}` : 'Error'
    default:
      return 'Not configured'
  }
})

const STYLES: Record<ProviderStatusLike, { badge: string, dot: string }> = {
  connected: { badge: 'bg-success/15 text-foreground dark:text-success', dot: 'bg-success' },
  env: { badge: 'bg-info/15 text-foreground dark:text-info', dot: 'bg-info' },
  error: { badge: 'bg-destructive/12 text-foreground dark:text-destructive', dot: 'bg-destructive' },
  not_configured: { badge: 'border-border bg-transparent text-muted-foreground', dot: '' },
}

const style = computed(() => STYLES[props.status] ?? STYLES.not_configured)
</script>

<template>
  <Tooltip :disabled="!message">
    <TooltipTrigger as-child>
      <Badge
        variant="outline"
        data-slot="provider-status"
        :data-status="status"
        :class="cn('gap-1.5 rounded-full font-medium', status !== 'not_configured' && 'border-transparent', style.badge)"
        v-bind="$attrs"
      >
        <span v-if="style.dot" aria-hidden="true" :class="cn('size-1.5 rounded-full', style.dot)" />
        {{ label }}
      </Badge>
    </TooltipTrigger>
    <TooltipContent v-if="message" class="max-w-xs">
      {{ message }}
    </TooltipContent>
  </Tooltip>
</template>
