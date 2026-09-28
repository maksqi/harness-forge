<script setup lang="ts">
// Plain-HTTP warning of Settings -> Providers (docs/UI.md 9.1): shown when the page is served over http:// from a
// host other than loopback, because keys typed here then cross the network in clear.
import { TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { testIds } from '~/utils/testids'
import { isPlainHttpFromNetwork } from './providers'

const props = defineProps<{
  /** Defaults to `window.location` (tests pass their own). */
  location?: Pick<Location, 'protocol' | 'hostname'>
}>()

const visible = isPlainHttpFromNetwork(props.location ?? (typeof window === 'undefined'
  ? { protocol: 'https:', hostname: 'localhost' }
  : window.location))
</script>

<template>
  <Alert
    v-if="visible"
    :data-testid="testIds.insecureBanner"
    class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning"
  >
    <TriangleAlertIcon aria-hidden="true" />
    <AlertDescription class="text-foreground">
      You're using plain HTTP. Keys you enter can be read on the network. Use HTTPS or localhost.
    </AlertDescription>
  </Alert>
</template>
