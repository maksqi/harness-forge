<script setup lang="ts">
// The official marketplace card of the Marketplaces page (Phase 12, ADR-054; docs/UI.md 8.13, 10.9): "Anthropic's
// official plugins" with the repository and Add marketplace (`marketplace-suggestion-add`) and a × named "Dismiss"
// (`marketplace-suggestion-dismiss`). Rendering it sends no request; the page adds the marketplace on `add` and hides the
// card after `dismiss` (`localStorage['hf-marketplace-suggestion-dismissed']`) or once the repository is added.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.8 implements the card in P12-A.
import { XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'
import { OFFICIAL_MARKETPLACE } from './marketplaces'

// No props.
const emit = defineEmits<{ add: [], dismiss: [] }>()
</script>

<template>
  <section
    :data-testid="testIds.marketplaceSuggestion"
    aria-label="Anthropic's official plugins"
    class="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border bg-card p-4"
  >
    <div class="grid min-w-0 flex-1 gap-0.5">
      <p class="text-sm font-medium">
        Anthropic's official plugins
      </p>
      <p class="truncate font-mono text-xs text-muted-foreground">
        {{ OFFICIAL_MARKETPLACE }}
      </p>
    </div>
    <Button type="button" size="sm" :data-testid="testIds.marketplaceSuggestionAdd" class="pointer-coarse:h-10" @click="emit('add')">
      Add marketplace
    </Button>
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label="Dismiss"
      :data-testid="testIds.marketplaceSuggestionDismiss"
      class="pointer-coarse:size-10"
      @click="emit('dismiss')"
    >
      <XIcon aria-hidden="true" />
    </Button>
  </section>
</template>
