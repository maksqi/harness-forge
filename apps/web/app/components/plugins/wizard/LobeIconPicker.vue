<script setup lang="ts">
// LobeHub icon picker of the provider wizard (docs/UI.md 8.5): a search field and a virtualized grid of the icons of
// `GET /api/icons/lobe`. Icons are server URLs drawn by ProviderIcon (never inlined SVG).
import { RotateCwIcon, SearchIcon } from '@lucide/vue'
import { useElementSize, useVirtualList } from '@vueuse/core'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { testIds } from '~/utils/testids'
import { lobeIconRef, useLobeIcons } from './lobe-icons'

const props = withDefaults(defineProps<{ modelValue: string, invalid?: boolean }>(), { invalid: false })
const emit = defineEmits<{ 'update:modelValue': [slug: string] }>()

/** Row height and cell pitch of the grid, in px. */
const CELL = 52
/** Columns used before the grid has been measured (tests, first paint). */
const FALLBACK_COLUMNS = 8

const { state, load } = useLobeIcons()
const query = ref('')

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (needle === '')
    return state.items
  const compact = needle.replace(/-/g, '')
  return state.items.filter(item => item.slug.includes(needle) || item.slug.replace(/-/g, '').includes(compact))
})

const columns = ref(FALLBACK_COLUMNS)
const rows = computed(() => {
  const result: Array<typeof filtered.value> = []
  for (let index = 0; index < filtered.value.length; index += columns.value)
    result.push(filtered.value.slice(index, index + columns.value))
  return result
})

const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(rows, { itemHeight: CELL, overscan: 4 })
const { width } = useElementSize(containerProps.ref)
watch(width, (value) => {
  // 8px of padding; at least four columns so narrow screens still show a useful grid.
  columns.value = value > 0 ? Math.max(4, Math.floor((value - 8) / CELL)) : FALLBACK_COLUMNS
})

// Scrolls the selected icon into view once the grid is shown and measured (edit mode, restored drafts), until the
// user starts searching.
const revealPending = ref(true)
watch(query, () => {
  revealPending.value = false
})
watch([() => state.loaded, columns, containerProps.ref], async () => {
  if (!revealPending.value || !state.loaded || !containerProps.ref.value)
    return
  await nextTick()
  const index = filtered.value.findIndex(item => item.slug === props.modelValue)
  if (index >= 0)
    scrollTo(Math.floor(index / columns.value))
}, { flush: 'post' })

onMounted(() => {
  void load()
})

function select(slug: string) {
  emit('update:modelValue', slug)
}
</script>

<template>
  <div data-slot="lobe-icon-picker" class="grid gap-2">
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        v-model="query"
        type="search"
        placeholder="Search icons…"
        aria-label="Search LobeHub icons"
        autocomplete="off"
        spellcheck="false"
        :data-testid="testIds.wizardIconSearch"
      />
    </InputGroup>

    <div
      v-if="state.error"
      role="alert"
      class="flex items-center justify-between gap-3 rounded-md border border-destructive/35 bg-destructive/5 px-3 py-2 text-sm dark:bg-destructive/10"
    >
      <span>The icon list could not be loaded.</span>
      <Button type="button" size="sm" variant="outline" @click="load(true)">
        <RotateCwIcon data-icon="inline-start" aria-hidden="true" />
        Retry
      </Button>
    </div>
    <div v-else-if="!state.loaded" class="grid grid-cols-8 gap-1 rounded-md border p-1" aria-busy="true" aria-label="Loading icons">
      <Skeleton v-for="index in 16" :key="index" class="size-12 rounded-md" />
    </div>
    <p v-else-if="filtered.length === 0" class="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
      No icons match "{{ query }}".
    </p>
    <div
      v-else
      v-bind="containerProps"
      role="group"
      aria-label="LobeHub icons"
      :aria-invalid="invalid || undefined"
      class="hf-scroll-stable max-h-56 overflow-y-auto rounded-md border bg-background p-1 aria-invalid:border-destructive"
    >
      <div v-bind="wrapperProps">
        <div v-for="row in list" :key="row.index" class="flex gap-1" :style="{ height: `${CELL}px` }">
          <button
            v-for="item in row.data"
            :key="item.slug"
            type="button"
            :title="item.slug"
            :aria-label="item.slug"
            :aria-pressed="item.slug === modelValue"
            :data-testid="testIds.wizardIconOption"
            :data-value="item.slug"
            class="flex size-12 shrink-0 items-center justify-center rounded-md border border-transparent outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:border-primary aria-pressed:bg-primary/10"
            @click="select(item.slug)"
          >
            <ProviderIcon :icon="lobeIconRef(item.slug, item.hasColor, state.version)" :name="item.slug" variant="color" size="md" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="state.loaded" class="text-xs text-muted-foreground">
      <template v-if="modelValue">
        Selected: <span class="font-mono text-foreground">{{ modelValue }}</span> ·
      </template>
      {{ filtered.length }} of {{ state.items.length }} LobeHub icons
    </p>
  </div>
</template>
