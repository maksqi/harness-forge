<script setup lang="ts">
// The update banner of the plugin detail page (Phase 12, ADR-054; docs/UI.md 8.13, 10.9): above the tabs while a
// marketplace offers another version (`data-slot="plugin-update-banner"`): "Version {version} is available from
// {marketplace}." ("A newer commit is available from {marketplace}." without a version) and Update… (`plugin-update`),
// which the page answers with MarketplaceInstallDialog in update mode. Renders nothing without an update. Store-free.
// Props, emits and the root slot are frozen from Gate P12-0b (C46 stub); W12.9 implements the banner in P12-A: a polite
// `status` (not an alert: it is news, not a problem), and Update… is 40 px tall on touch screens.
import type { PluginUpdate } from '@harness-forge/shared'
import { CircleArrowUpIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'

const props = defineProps<{ update: PluginUpdate | null, marketplaceName: string | null }>()

const emit = defineEmits<{ update: [] }>()

const text = computed(() => {
  const update = props.update
  if (!update)
    return ''
  const from = props.marketplaceName ?? 'its marketplace'
  return update.availableVersion
    ? `Version ${update.availableVersion} is available from ${from}.`
    : `A newer commit is available from ${from}.`
})
</script>

<template>
  <Alert v-if="update" role="status" data-slot="plugin-update-banner" :data-version="update.availableVersion ?? ''">
    <CircleArrowUpIcon aria-hidden="true" />
    <AlertDescription class="flex flex-wrap items-center gap-x-3 gap-y-1 text-foreground">
      <span>{{ text }}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        class="pointer-coarse:h-10"
        :data-testid="testIds.pluginUpdate"
        @click="emit('update')"
      >
        Update…
      </Button>
    </AlertDescription>
  </Alert>
</template>
