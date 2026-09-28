<script setup lang="ts">
// Renders a HarnessError (envelope, init object, HarnessError instance or anything thrown) as an Alert with a
// one-line title, the server message and its action buttons (docs/UI.md 7.4). Presentational: it emits the
// action and the caller performs it. `rate_limited` shows a countdown on Retry while `retryAfterMs` runs.
// With data-testid="chat-error" on the root, the action buttons get data-testid="chat-error-action".
import type { HarnessErrorUiAction } from './harness-error'
import { ChevronRightIcon, CircleAlertIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, useAttrs, watch } from 'vue'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import {
  errorActionLabels,
  errorActions,
  errorDetailsText,
  errorTitle,
  toHarnessErrorView,
} from './harness-error'

const props = withDefaults(defineProps<{
  error: unknown
  providerName?: string
  compact?: boolean
}>(), {
  compact: false,
})

const emit = defineEmits<{
  action: [action: HarnessErrorUiAction]
}>()

const attrs = useAttrs()

const view = computed(() => toHarnessErrorView(props.error))
const title = computed(() => errorTitle(view.value, props.providerName))
const actions = computed(() => errorActions(view.value))
const details = computed(() => (props.compact ? null : errorDetailsText(view.value)))
const isWarning = computed(() => view.value.code === 'rate_limited')
const actionTestId = computed(() => (attrs['data-testid'] === testIds.chatError ? testIds.chatErrorAction : undefined))

// Retry countdown for rate limits.
const now = ref(Date.now())
const shownAt = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined

const retryWaitSeconds = computed(() => {
  const wait = view.value.code === 'rate_limited' ? view.value.retryAfterMs ?? 0 : 0
  const remaining = shownAt.value + wait - now.value
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
})

function stopTicker() {
  if (ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
}

watch(view, () => {
  shownAt.value = Date.now()
  now.value = shownAt.value
  stopTicker()
  if (retryWaitSeconds.value > 0) {
    ticker = setInterval(() => {
      now.value = Date.now()
      if (retryWaitSeconds.value === 0)
        stopTicker()
    }, 250)
  }
}, { immediate: true })

onBeforeUnmount(stopTicker)

// Tinted surfaces keep readable foreground text (docs/UI.md 14.3); the title and the icon carry the color.
const WARNING_CLASS = 'border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning'
// The title mixes a little foreground into the red: plain --destructive on the red tint misses 4.5:1 in dark mode.
const ERROR_CLASS = 'border-destructive/35 bg-destructive/5 dark:bg-destructive/10 *:data-[slot=alert-title]:text-[color-mix(in_oklch,var(--destructive)_80%,var(--foreground))]'

function label(action: HarnessErrorUiAction): string {
  if (action === 'retry' && retryWaitSeconds.value > 0)
    return `Retry in ${retryWaitSeconds.value}s`
  return errorActionLabels[action]
}
</script>

<template>
  <Alert
    :variant="isWarning ? 'default' : 'destructive'"
    :data-code="view.code"
    data-slot="harness-error-alert"
    :class="cn(
      '*:data-[slot=alert-description]:text-foreground/80',
      isWarning ? WARNING_CLASS : ERROR_CLASS,
      compact && 'gap-0 px-3 py-2 text-xs has-data-[slot=alert-action]:pr-28',
    )"
  >
    <TriangleAlertIcon v-if="isWarning" />
    <CircleAlertIcon v-else />
    <AlertTitle :class="cn(compact && 'text-xs')">
      {{ title }}
    </AlertTitle>
    <AlertDescription :class="cn(compact && 'text-xs')">
      {{ view.message }}
    </AlertDescription>

    <AlertAction v-if="compact && actions.length" :class="cn(compact && 'top-1.5 right-2')">
      <Button
        v-for="action in actions"
        :key="action"
        type="button"
        size="xs"
        variant="outline"
        class="text-foreground"
        :data-action="action"
        :data-testid="actionTestId"
        :disabled="action === 'retry' && retryWaitSeconds > 0"
        @click="emit('action', action)"
      >
        {{ label(action) }}
      </Button>
    </AlertAction>
    <div v-else-if="actions.length" class="col-start-2 mt-2 flex flex-wrap gap-2">
      <Button
        v-for="action in actions"
        :key="action"
        type="button"
        size="sm"
        variant="outline"
        class="text-foreground"
        :data-action="action"
        :data-testid="actionTestId"
        :disabled="action === 'retry' && retryWaitSeconds > 0"
        @click="emit('action', action)"
      >
        {{ label(action) }}
      </Button>
    </div>

    <Collapsible v-if="details" class="col-start-2 mt-1">
      <CollapsibleTrigger
        class="group/details inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon class="size-3 transition-transform duration-(--duration-fast) group-data-[state=open]/details:rotate-90" />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre class="mt-1.5 max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap break-words text-foreground">{{ details }}</pre>
      </CollapsibleContent>
    </Collapsible>
  </Alert>
</template>
