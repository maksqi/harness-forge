<script setup lang="ts">
import type { MarketplaceSummary } from '@harness-forge/shared'
// The marketplace chips of the Marketplaces page (Phase 12, ADR-054; docs/UI.md 2.19, 8.13, 10.9, 14.1, 14.2, 14.5): a
// group named "Marketplace" of toggle chips — All {n} (`marketplace-row`, `data-marketplace-id=""`) and one chip per
// marketplace (`marketplace-row`, `data-marketplace-id`, `data-state` ok | error) "{name} {n}" plus "· {u} updates" with
// the update icon, a warning icon after a failed refresh and a spinner while it is busy (`busyIds`); each chip is named
// "{name}, {n} plugins" (", {u} updates", ", last refresh failed"). Arrow keys, Home and End move between the chips (one
// tab stop: the selected chip); a pick keeps the focus on the chip. Below `sm` a `Select` named "Marketplace" replaces
// the chips. The selected marketplace's menu (`marketplace-row-menu`, "Actions for {name}"): Refresh
// (`marketplace-refresh`) and Remove… (`marketplace-remove`). Store-free.
// Props, emits and the root test ids are frozen from Gate P12-0b (C46 stub); implementation W12.8 (P12-A).
// W12.19: the narrow Select is 40 px tall (`data-[size=default]:h-10`: a plain `h-10` loses to the frozen SelectTrigger's
// `data-[size=default]:h-9`).
import type { AcceptableValue } from 'reka-ui'
import { CircleArrowUpIcon, MoreHorizontalIcon, RotateCwIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'
import { computed, useTemplateRef } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { chipName, updatesText } from './marketplaces'

const props = defineProps<{ items: readonly MarketplaceSummary[], selectedId: string | null, busyIds?: readonly string[] }>()

const emit = defineEmits<{ select: [id: string | null], refresh: [id: string], remove: [id: string] }>()

/** The value of the All option of the narrow `Select` (reka refuses an empty value; marketplace ids start with `mkt_`). */
const ALL_VALUE = '__all__'

/** `sm` and wider: chips; narrower: a `Select`. */
const wide = useMediaQuery('(min-width: 640px)')
const group = useTemplateRef<HTMLElement>('group')

const total = computed(() => props.items.reduce((sum, item) => sum + item.plugins, 0))
const selected = computed(() => (props.selectedId ? props.items.find(item => item.id === props.selectedId) ?? null : null))
/** The chip with the tab stop: the selected one, else All. */
const focusId = computed(() => selected.value?.id ?? '')

/** "{name} {n}" plus "· {u} updates" (an option of the narrow `Select`). */
function optionText(item: MarketplaceSummary): string {
  return item.updates > 0 ? `${item.name} ${item.plugins} ${updatesText(item.updates)}` : `${item.name} ${item.plugins}`
}

function isBusy(id: string): boolean {
  return props.busyIds?.includes(id) ?? false
}

function pick(id: string | null): void {
  if (id !== props.selectedId)
    emit('select', id)
}

function onSelectValue(value: AcceptableValue): void {
  if (typeof value === 'string')
    pick(value === ALL_VALUE ? null : value)
}

/** Arrow keys, Home and End move the focus between the chips (wrapping); Enter or Space picks the focused chip. */
function onKeydown(event: KeyboardEvent): void {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
  if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey)
    return
  const chips = Array.from(group.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.marketplaceRow}"]`) ?? [])
  const index = chips.findIndex(chip => chip === document.activeElement)
  if (index === -1 || chips.length === 0)
    return
  event.preventDefault()
  let next = index
  if (event.key === 'Home')
    next = 0
  else if (event.key === 'End')
    next = chips.length - 1
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
    next = (index - 1 + chips.length) % chips.length
  else
    next = (index + 1) % chips.length
  chips[next]?.focus()
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-2">
    <div
      v-if="wide"
      ref="group"
      role="group"
      aria-label="Marketplace"
      class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
      @keydown="onKeydown"
    >
      <Button
        type="button"
        size="sm"
        :variant="selectedId === null ? 'secondary' : 'ghost'"
        :data-testid="testIds.marketplaceRow"
        data-marketplace-id=""
        data-state="ok"
        :aria-pressed="selectedId === null ? 'true' : 'false'"
        :tabindex="focusId === '' ? 0 : -1"
        class="pointer-coarse:h-10"
        @click="pick(null)"
      >
        All <span class="tabular-nums text-muted-foreground">{{ total }}</span>
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
        :aria-label="chipName(item)"
        :aria-busy="isBusy(item.id) || undefined"
        :tabindex="focusId === item.id ? 0 : -1"
        class="max-w-full min-w-0 pointer-coarse:h-10"
        @click="pick(item.id)"
      >
        <Spinner v-if="isBusy(item.id)" aria-hidden="true" data-icon="inline-start" />
        <span class="truncate">{{ item.name }}</span>
        <span class="tabular-nums text-muted-foreground">{{ item.plugins }}</span>
        <span v-if="item.updates > 0" class="inline-flex items-center gap-1 text-info">
          <CircleArrowUpIcon aria-hidden="true" class="size-3.5" />
          <span class="tabular-nums">{{ updatesText(item.updates) }}</span>
        </span>
        <TriangleAlertIcon v-if="item.lastError" aria-hidden="true" class="text-warning" />
      </Button>
    </div>

    <Select v-else :model-value="selectedId ?? ALL_VALUE" @update:model-value="onSelectValue">
      <SelectTrigger aria-label="Marketplace" data-slot="marketplace-select" class="min-w-0 flex-1 data-[size=default]:h-10">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectItem :value="ALL_VALUE" data-marketplace-id="" class="min-h-10">
          All {{ total }}
        </SelectItem>
        <SelectItem
          v-for="item in items"
          :key="item.id"
          :value="item.id"
          :data-marketplace-id="item.id"
          :aria-label="chipName(item)"
          class="min-h-10"
        >
          {{ optionText(item) }}
          <TriangleAlertIcon v-if="item.lastError" aria-hidden="true" class="text-warning" />
        </SelectItem>
      </SelectContent>
    </Select>

    <DropdownMenu v-if="selected">
      <DropdownMenuTrigger as-child>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          :aria-label="`Actions for ${selected.name}`"
          :data-testid="testIds.marketplaceRowMenu"
          :class="cn('shrink-0 pointer-coarse:size-10', !wide && 'size-10')"
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          :disabled="isBusy(selected.id)"
          :data-testid="testIds.marketplaceRefresh"
          class="pointer-coarse:min-h-10"
          @select="emit('refresh', selected.id)"
        >
          <RotateCwIcon aria-hidden="true" />
          Refresh
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          :disabled="isBusy(selected.id)"
          :data-testid="testIds.marketplaceRemove"
          class="pointer-coarse:min-h-10"
          @select="emit('remove', selected.id)"
        >
          <Trash2Icon aria-hidden="true" />
          Remove…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
