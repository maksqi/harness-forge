<script setup lang="ts">
// The marketplace chips of the Marketplaces page (Phase 12, ADR-054; docs/UI.md 8.13, 10.9): a ToggleGroup named
// "Marketplace" with All {n} (`marketplace-row`, `data-marketplace-id=""`) and one chip per marketplace (`marketplace-row`,
// `data-marketplace-id`, `data-state` ok | error; "· {u} updates", a warning icon after a failed refresh, a spinner
// while busy), a Select below `sm`; the selected marketplace's menu (`marketplace-row-menu`, "Actions for {name}"):
// Refresh (`marketplace-refresh`) and Remove… (`marketplace-remove`). Store-free.
// Props, emits and the root test ids are frozen from Gate P12-0b (C46 stub); W12.8 implements the strip in P12-A.
import type { MarketplaceSummary } from '@harness-forge/shared'
import { MoreHorizontalIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'

const props = defineProps<{ items: readonly MarketplaceSummary[], selectedId: string | null, busyIds?: readonly string[] }>()

const emit = defineEmits<{ select: [id: string | null], refresh: [id: string], remove: [id: string] }>()

const total = computed(() => props.items.reduce((sum, item) => sum + item.plugins, 0))
const selected = computed(() => (props.selectedId ? props.items.find(item => item.id === props.selectedId) ?? null : null))
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Marketplace">
    <Button
      type="button"
      size="sm"
      :variant="selectedId === null ? 'secondary' : 'ghost'"
      :data-testid="testIds.marketplaceRow"
      data-marketplace-id=""
      data-state="ok"
      :aria-pressed="selectedId === null ? 'true' : 'false'"
      @click="emit('select', null)"
    >
      All {{ total }}
    </Button>
    <Button
      v-for="item in items"
      :key="item.id"
      type="button"
      size="sm"
      :variant="selectedId === item.id ? 'secondary' : 'ghost'"
      :data-testid="testIds.marketplaceRow"
      :data-marketplace-id="item.id"
      :data-state="item.lastError ? 'error' : 'ok'"
      :aria-pressed="selectedId === item.id ? 'true' : 'false'"
      :aria-busy="busyIds?.includes(item.id) || undefined"
      :class="cn(item.lastError && 'text-warning')"
      @click="emit('select', item.id)"
    >
      {{ item.name }} {{ item.plugins }}<template v-if="item.updates > 0">
        · {{ item.updates }} updates
      </template>
    </Button>
    <DropdownMenu v-if="selected">
      <DropdownMenuTrigger as-child>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          :aria-label="`Actions for ${selected.name}`"
          :data-testid="testIds.marketplaceRowMenu"
          class="pointer-coarse:size-10"
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem :data-testid="testIds.marketplaceRefresh" @select="emit('refresh', selected.id)">
          Refresh
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" :data-testid="testIds.marketplaceRemove" @select="emit('remove', selected.id)">
          Remove…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
