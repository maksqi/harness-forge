<script setup lang="ts">
// One provider in Settings -> Providers (docs/UI.md 2.5, 9.1): color icon, name, subtitle ("23 models",
// "Local — no key", "via {plugin}"), status badge, Configure / Add key and the enable switch. One line from `sm`;
// below it the badge and the button move to a second line.
import type { ProviderSummary } from '@harness-forge/shared'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import ProviderStatusBadge from '~/components/providers/ProviderStatusBadge.vue'
import { testIds } from '~/utils/testids'
import { configureLabel, providerSubtitle, statusMessage } from './providers'

const props = withDefaults(defineProps<{
  provider: ProviderSummary
  pluginName?: string | null
  /** The enable switch is saving. */
  pending?: boolean
}>(), {
  pluginName: null,
  pending: false,
})

const emit = defineEmits<{
  'configure': []
  'update:enabled': [value: boolean]
}>()

const subtitle = computed(() => providerSubtitle(props.provider, props.pluginName))
const actionLabel = computed(() => configureLabel(props.provider))
</script>

<template>
  <div
    role="listitem"
    :data-testid="testIds.providerRow"
    :data-provider-id="provider.id"
    :data-enabled="provider.enabled"
    class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_7.5rem_5.5rem_auto]"
  >
    <ProviderIcon
      :id="provider.id"
      :icon="provider.icon"
      :name="provider.name"
      size="lg"
      variant="color"
      :class="cn('col-start-1 row-span-2 row-start-1 sm:row-span-1', !provider.enabled && 'opacity-50 grayscale')"
    />
    <div :class="cn('col-start-2 row-start-1 min-w-0', !provider.enabled && 'opacity-60')">
      <p class="truncate text-sm font-medium">
        {{ provider.name }}
      </p>
      <p v-if="subtitle" class="truncate text-xs text-muted-foreground">
        {{ subtitle }}
      </p>
    </div>
    <div class="col-start-2 row-start-2 flex sm:col-start-3 sm:row-start-1">
      <ProviderStatusBadge
        :status="provider.status"
        :http-status="provider.lastError?.status"
        :message="statusMessage(provider)"
        :data-testid="testIds.providerStatus"
      />
    </div>
    <Button
      type="button"
      size="sm"
      variant="outline"
      :aria-label="`${actionLabel}: ${provider.name}`"
      :data-testid="testIds.providerConfigure"
      class="col-start-3 row-start-2 justify-self-end sm:col-start-4 sm:row-start-1 sm:w-full"
      @click="emit('configure')"
    >
      {{ actionLabel }}
    </Button>
    <Switch
      size="sm"
      :model-value="provider.enabled"
      :disabled="pending"
      :aria-label="`Enable ${provider.name}`"
      :data-testid="testIds.providerEnabled"
      class="col-start-3 row-start-1 justify-self-end sm:col-start-5"
      @update:model-value="value => emit('update:enabled', value)"
    />
  </div>
</template>
