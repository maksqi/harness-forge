<script setup lang="ts">
// The official marketplace card of the Marketplaces page (Phase 12, ADR-054; docs/UI.md 8.13, 10.9, 14.2): a region named
// "Anthropic's official plugins" with the repository (mono), Add marketplace (`marketplace-suggestion-add`) and a ×
// named "Dismiss" (`marketplace-suggestion-dismiss`). Rendering it sends no request: the page adds the marketplace on
// `add` and hides the card after `dismiss` (`localStorage['hf-marketplace-suggestion-dismissed']`) or once the repository
// is added. At 390 px the button wraps under the text; on touch screens both buttons are 40 px.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); implementation W12.8 (P12-A).
import { StoreIcon, XIcon } from '@lucide/vue'
import { useId } from 'vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'
import { OFFICIAL_MARKETPLACE } from './marketplaces'

// No props.
const emit = defineEmits<{ add: [], dismiss: [] }>()

const titleId = useId()
</script>

<template>
  <section
    :data-testid="testIds.marketplaceSuggestion"
    :aria-labelledby="titleId"
    class="relative flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border bg-card py-3 pr-12 pl-4"
  >
    <span aria-hidden="true" class="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <StoreIcon class="size-4" />
    </span>
    <div class="grid min-w-0 flex-1 basis-48 gap-0.5">
      <h2 :id="titleId" class="text-sm font-medium">
        Anthropic's official plugins
      </h2>
      <p class="truncate font-mono text-xs text-muted-foreground" :title="OFFICIAL_MARKETPLACE">
        {{ OFFICIAL_MARKETPLACE }}
      </p>
    </div>
    <Button
      type="button"
      size="sm"
      variant="outline"
      :data-testid="testIds.marketplaceSuggestionAdd"
      class="pointer-coarse:h-10 max-sm:w-full"
      @click="emit('add')"
    >
      Add marketplace
    </Button>
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label="Dismiss"
      :data-testid="testIds.marketplaceSuggestionDismiss"
      class="absolute top-2 right-2 text-muted-foreground pointer-coarse:size-10"
      @click="emit('dismiss')"
    >
      <XIcon aria-hidden="true" />
    </Button>
  </section>
</template>
