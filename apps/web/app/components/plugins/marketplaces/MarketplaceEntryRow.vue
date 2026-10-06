<script setup lang="ts">
// One plugin of a marketplace (Phase 12, ADR-054; docs/UI.md 8.13, 10.9): an `<article>` named "{name}, {state}"
// (`marketplace-entry`, `data-name`, `data-state` available | installed | update | unsupported, `data-marketplace-id`):
// the name, version and category; Install… (`marketplace-entry-install`, "Install {name}") for available entries,
// "Installed" and Open (`data-action="open-plugin"`) for installed ones, "Installed · Update to {version}" and Update…
// (`marketplace-entry-update`, "Update {name}") for updates, "Unsupported source ({type})" for unsupported ones; the
// description, the tags and the source line (`sourceText`). Store-free.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.8 implements the row in P12-A.
import type { MarketplaceEntryView } from './marketplaces'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'
import { sourceText } from './marketplaces'

const props = defineProps<{ entry: MarketplaceEntryView, busy?: boolean }>()

const emit = defineEmits<{ install: [], update: [] }>()

const STATE_WORDS: Readonly<Record<MarketplaceEntryView['state'], string>> = {
  available: 'Available',
  installed: 'Installed',
  update: 'Update available',
  unsupported: 'Unsupported',
}

const name = computed(() => props.entry.entry.name)
const source = computed(() => sourceText(props.entry.entry.source))
</script>

<template>
  <article
    :data-testid="testIds.marketplaceEntry"
    :data-name="name"
    :data-state="entry.state"
    :data-marketplace-id="entry.marketplaceId"
    :aria-label="`${name}, ${STATE_WORDS[entry.state]}`"
    :aria-busy="busy || undefined"
    class="flex min-w-0 flex-wrap items-start gap-3 py-3"
  >
    <div class="grid min-w-0 flex-1 gap-0.5">
      <p class="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span class="font-mono text-sm font-medium">{{ name }}</span>
        <span v-if="entry.entry.version" class="font-mono text-xs text-muted-foreground">{{ entry.entry.version }}</span>
        <span v-if="entry.entry.category" class="text-xs text-muted-foreground">{{ entry.entry.category }}</span>
      </p>
      <p v-if="entry.entry.description" class="text-sm text-muted-foreground">
        {{ entry.entry.description }}
      </p>
      <p class="text-xs text-muted-foreground">
        {{ source }}
      </p>
    </div>
    <Button
      v-if="entry.state === 'available'"
      type="button"
      size="sm"
      :disabled="busy"
      :aria-label="`Install ${name}`"
      :data-testid="testIds.marketplaceEntryInstall"
      @click="emit('install')"
    >
      Install…
    </Button>
    <Button
      v-else-if="entry.state === 'update'"
      type="button"
      size="sm"
      :disabled="busy"
      :aria-label="`Update ${name}`"
      :data-testid="testIds.marketplaceEntryUpdate"
      @click="emit('update')"
    >
      Update…
    </Button>
    <span v-else class="text-xs text-muted-foreground">
      {{ entry.state === 'installed' ? 'Installed' : `Unsupported source (${entry.entry.source.kind})` }}
    </span>
  </article>
</template>
