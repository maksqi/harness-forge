<script setup lang="ts">
// A settings page could not load its data: what failed, the server message and Retry.
import { CircleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toHarnessError } from '~/utils/errors'

const props = withDefaults(defineProps<{
  error: unknown
  title: string
  pending?: boolean
}>(), {
  pending: false,
})

const emit = defineEmits<{ retry: [] }>()

const message = computed(() => toHarnessError(props.error).message)
</script>

<template>
  <Alert
    data-slot="settings-load-error"
    class="border-destructive/35 bg-destructive/5 pr-24 dark:bg-destructive/10"
  >
    <CircleAlertIcon aria-hidden="true" class="text-destructive" />
    <AlertTitle>{{ title }}</AlertTitle>
    <AlertDescription class="text-foreground/80">
      {{ message }}
    </AlertDescription>
    <AlertAction>
      <Button type="button" size="xs" variant="outline" :disabled="pending" @click="emit('retry')">
        <Spinner v-if="pending" data-icon="inline-start" />
        Retry
      </Button>
    </AlertAction>
  </Alert>
</template>
