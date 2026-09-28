<script setup lang="ts">
// An error of the wizard (draft tests, create / save): title and message of the HarnessError plus the redacted
// upstream detail, without the settings / login actions of HarnessErrorAlert (the wizard is where it gets fixed).
import { CircleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { errorTitle, toHarnessErrorView } from '~/components/common/harness-error'

const props = defineProps<{ error: unknown, providerName?: string }>()
defineSlots<{ default?: () => any }>()

const view = computed(() => toHarnessErrorView(props.error))
const title = computed(() => errorTitle(view.value, props.providerName))
/** The short, redacted upstream message of provider errors (never raw JSON). */
const details = computed(() => {
  const value = view.value.details
  return typeof value === 'object' && value !== null && typeof (value as { upstream?: unknown }).upstream === 'string'
    ? (value as { upstream: string }).upstream
    : null
})
</script>

<template>
  <Alert
    variant="destructive"
    data-slot="wizard-error"
    :data-code="view.code"
    class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10 *:data-[slot=alert-description]:text-foreground/80"
  >
    <CircleAlertIcon />
    <AlertTitle>{{ title }}</AlertTitle>
    <AlertDescription>
      <p>{{ view.message }}</p>
      <p v-if="details" class="mt-1 font-mono text-xs break-words text-muted-foreground">
        {{ details }}
      </p>
      <div v-if="$slots.default" class="mt-2 flex flex-wrap gap-2">
        <slot />
      </div>
    </AlertDescription>
  </Alert>
</template>
