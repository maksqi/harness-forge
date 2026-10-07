<script setup lang="ts">
// One plugin of a marketplace (Phase 12, ADR-054; docs/UI.md 2.19, 8.13, 10.9, 14.2, 14.5): an `<article>` named
// "{name}, {state}" (`marketplace-entry`, `data-name`, `data-state` available | installed | update | unsupported,
// `data-marketplace-id`; state words "Available", "Installed", "Update available", "Unsupported"). Line 1: the name
// (mono), the version and the category, then the state and its action — Install… (`marketplace-entry-install`, named
// "Install {name}") for available entries, "Installed" and Open (a link to the plugin page, `data-action="open-plugin"`)
// for installed ones, "Installed · Update to {version}" and Update… (`marketplace-entry-update`, named "Update {name}")
// for updates, "Unsupported source ({type})" with the reason as its description (no button) for unsupported ones. Line
// 2: the marketplace name (on All, from MarketplacesView through `MARKETPLACE_ENTRY_CONTEXT`), the description, the tags
// and the source (`sourceText`). Below `sm` the action takes its own 40 px line. Store-free.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); implementation W12.8 (P12-A).
import type { MarketplaceEntryView } from './marketplaces'
import { ArrowUpRightIcon, CircleArrowUpIcon, DownloadIcon } from '@lucide/vue'
import { computed, inject, useId } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { pluginDetailRoute } from '~/components/plugins/list/plugin-display'
import { testIds } from '~/utils/testids'
import { MARKETPLACE_ENTRY_CONTEXT } from './entry-context'
import { ENTRY_STATE_WORDS, entryStatusText, middleTruncate, sourceText } from './marketplaces'

const props = defineProps<{ entry: MarketplaceEntryView, busy?: boolean }>()

const emit = defineEmits<{ install: [], update: [] }>()

const context = inject(MARKETPLACE_ENTRY_CONTEXT, null)
const reasonId = useId()

const name = computed(() => props.entry.entry.name)
const state = computed(() => props.entry.state)
const status = computed(() => entryStatusText(props.entry))
const source = computed(() => sourceText(props.entry.entry.source))
const reason = computed(() => (state.value === 'unsupported' ? props.entry.entry.unsupportedReason ?? null : null))
/** The plugin page of an installed entry. */
const openRoute = computed(() => (props.entry.pluginId ? pluginDetailRoute(props.entry.pluginId) : null))
/** Line 2 after the description: the marketplace (on All), the tags and the source. */
const meta = computed(() => {
  const parts: string[] = []
  if (context?.showMarketplace.value)
    parts.push(props.entry.marketplaceName)
  parts.push(...props.entry.entry.tags)
  parts.push(middleTruncate(source.value))
  return parts
})
</script>

<template>
  <article
    :data-testid="testIds.marketplaceEntry"
    :data-name="name"
    :data-state="state"
    :data-marketplace-id="entry.marketplaceId"
    :aria-label="`${name}, ${ENTRY_STATE_WORDS[state]}`"
    :aria-describedby="reason ? reasonId : undefined"
    :aria-busy="busy || undefined"
    class="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 py-3"
  >
    <div class="grid min-w-0 flex-1 basis-60 gap-1">
      <p class="min-w-0 break-words">
        <span class="font-mono text-sm font-medium break-all">{{ name }}</span>
        <template v-if="entry.entry.version">
          {{ ' ' }}<span class="font-mono text-xs text-muted-foreground">{{ entry.entry.version }}</span>
        </template>
        <template v-if="entry.entry.category">
          {{ ' · ' }}<span class="text-xs text-muted-foreground">{{ entry.entry.category }}</span>
        </template>
      </p>
      <p v-if="entry.entry.description" class="text-sm text-muted-foreground">
        {{ entry.entry.description }}
      </p>
      <p class="min-w-0 text-xs break-words text-muted-foreground" :title="source">
        <template v-for="(part, index) in meta" :key="index">
          <template v-if="index > 0">
            {{ ' · ' }}
          </template>
          <span :class="cn(index === meta.length - 1 && 'font-mono break-all')">{{ part }}</span>
        </template>
      </p>
      <p v-if="reason" :id="reasonId" class="text-xs text-muted-foreground">
        {{ reason }}
      </p>
    </div>

    <div class="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full max-sm:justify-between">
      <Badge
        v-if="status"
        variant="outline"
        data-slot="marketplace-entry-status"
        :class="cn('font-normal', state === 'update' && 'border-info/40 text-info', state === 'unsupported' && 'text-muted-foreground')"
      >
        <CircleArrowUpIcon v-if="state === 'update'" aria-hidden="true" />
        {{ status }}
      </Badge>
      <Button
        v-if="state === 'available'"
        type="button"
        size="sm"
        variant="outline"
        :disabled="busy"
        :aria-label="`Install ${name}`"
        :data-testid="testIds.marketplaceEntryInstall"
        class="max-sm:ml-auto max-sm:h-10 pointer-coarse:h-10"
        @click="emit('install')"
      >
        <DownloadIcon aria-hidden="true" data-icon="inline-start" />
        Install…
      </Button>
      <Button
        v-else-if="state === 'update'"
        type="button"
        size="sm"
        :disabled="busy"
        :aria-label="`Update ${name}`"
        :data-testid="testIds.marketplaceEntryUpdate"
        class="max-sm:h-10 pointer-coarse:h-10"
        @click="emit('update')"
      >
        Update…
      </Button>
      <Button
        v-else-if="state === 'installed' && openRoute"
        as-child
        size="sm"
        variant="ghost"
        class="max-sm:h-10 pointer-coarse:h-10"
      >
        <NuxtLink :to="openRoute" data-action="open-plugin" :aria-label="`Open ${name}`">
          Open
          <ArrowUpRightIcon aria-hidden="true" data-icon="inline-end" />
        </NuxtLink>
      </Button>
    </div>
  </article>
</template>
