<script setup lang="ts">
// Compaction divider (docs/UI.md 2.16, 7.24, 10.6, 14.2; ADR-040): a full-width row at the position of a
// `data-compaction` part (ChatMessage renders it for block kind `compaction`). Two `aria-hidden` rules around the
// FoldVertical icon, the label, the meta line "42 messages summarized · 182K → 9K tokens" (hidden below `sm`) and the
// toggle "Show summary" / "Hide summary". The summary card (collapsed by default, not persisted) holds "Focus: …", the
// summary as Markdown with Copy and the footnote "The model sees this summary instead of the messages above."; it
// scrolls inside `max-h-[50dvh]`. Opening or closing it keeps focus on the toggle.
// Contract (frozen from Gate P9-0b): props `data` + `variant`; root `compaction-divider` with `data-kind` (the
// trigger), `data-variant` and `data-count` (messages summarized), `role="group"` named by the label; no state
// attribute (a marker is always finished); `compaction-toggle` (`data-state`, `aria-expanded`, `aria-controls`);
// `compaction-summary` while open.
import type { CompactionData } from '@harness-forge/shared'
import type { CompactionVariant } from './compaction'
import { ChevronRightIcon, FoldVerticalIcon } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { cn } from '@/lib/utils'
import CopyButton from '~/components/common/CopyButton.vue'
import Markdown from '~/components/common/Markdown.vue'
import { testIds } from '~/utils/testids'
import { compactionLabel, compactionMeta } from './compaction'

const props = defineProps<{
  data: CompactionData
  /** 'history' = the first rendered block of its message; 'run' = after other blocks of its message (in-run). */
  variant: CompactionVariant
}>()

const open = ref(false)
const summaryId = `compaction-summary-${useId()}`
const label = computed(() => compactionLabel(props.data, props.variant))
const meta = computed(() => compactionMeta(props.data))
const focus = computed(() => props.data.focus?.trim() ?? '')
</script>

<template>
  <div
    :data-testid="testIds.compactionDivider"
    :data-kind="data.trigger"
    :data-variant="variant"
    :data-count="data.messagesCompacted"
    role="group"
    :aria-label="label"
    class="flex min-w-0 flex-col gap-2"
  >
    <div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:gap-3">
      <span aria-hidden="true" class="h-px min-w-2 flex-1 bg-border sm:min-w-6" />
      <FoldVerticalIcon aria-hidden="true" class="size-3.5 shrink-0" />
      <span class="min-w-0 truncate font-medium">{{ label }}</span>
      <span data-slot="compaction-meta" class="hidden shrink-0 tabular-nums sm:inline">
        <span aria-hidden="true">· </span>{{ meta }}
      </span>
      <button
        type="button"
        :data-testid="testIds.compactionToggle"
        :data-state="open ? 'open' : 'closed'"
        :aria-expanded="open"
        :aria-controls="summaryId"
        class="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
        @click="open = !open"
      >
        {{ open ? 'Hide summary' : 'Show summary' }}
        <ChevronRightIcon
          aria-hidden="true"
          :class="cn('size-3 transition-transform duration-(--duration-base)', open && 'rotate-90')"
        />
      </button>
      <span aria-hidden="true" class="h-px min-w-2 flex-1 bg-border sm:min-w-6" />
    </div>
    <div
      v-if="open"
      :id="summaryId"
      :data-testid="testIds.compactionSummary"
      class="flex max-h-[50dvh] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-sm"
    >
      <div class="flex min-w-0 items-center justify-between gap-2 px-4 pt-2.5 pb-1">
        <span class="text-xs font-medium text-muted-foreground">Summary</span>
        <CopyButton :text="data.summary" label="Copy summary" class="pointer-coarse:size-10" />
      </div>
      <div
        role="region"
        aria-label="Summary"
        tabindex="0"
        class="min-h-0 min-w-0 overflow-y-auto px-4 pb-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <p v-if="focus" data-slot="compaction-focus" class="mb-2 text-xs break-words text-muted-foreground">
          Focus: {{ focus }}
        </p>
        <Markdown :content="data.summary" :final="true" class="font-reading" />
      </div>
      <p class="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        The model sees this summary instead of the messages above.
      </p>
    </div>
  </div>
</template>
