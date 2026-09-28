<script setup lang="ts">
// Logs tab (docs/UI.md 8.11): the plugin's log ring buffer from `GET /api/plugins/:id/logs`, then live `plugin.log`
// events (the plugins store appends them; it keeps the newest 500). Mono rows: time · level · message. Level filter
// All / Info / Warn / Error (that level and above), "Copy" (the visible entries as text) and "Clear view" (hides what
// is there now; new entries keep coming). Follows new entries unless the user scrolled up.
import type { PluginLogEntry } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { LogLevelFilter } from './plugin-detail'
import { EraserIcon, ScrollTextIcon } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import CopyButton from '~/components/common/CopyButton.vue'
import { useServerEvents } from '~/composables/useServerEvents'
import { usePluginsStore } from '~/stores/plugins'
import { isAbortError, toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { formatLogTime, isLogLevelFilter, LOG_LEVEL_FILTERS, logMatchesLevel, logsAsText } from './plugin-detail'

const props = defineProps<{ pluginId: string }>()

const plugins = usePluginsStore()
const events = useServerEvents()

const loading = ref(false)
const loadError = ref<string | null>(null)
const level = ref<LogLevelFilter>('all')
/** Entries up to this sequence number are hidden by "Clear view". */
const clearedAfter = ref<number | null>(null)

const scroller = useTemplateRef<HTMLElement>('scroller')
/** The view follows new entries while the user is at the bottom. */
const following = ref(true)

const entries = computed<PluginLogEntry[]>(() => plugins.logs[props.pluginId] ?? [])
const loaded = computed(() => props.pluginId in plugins.logs && !loading.value)
const afterClear = computed(() => (clearedAfter.value === null ? entries.value : entries.value.filter(entry => entry.seq > clearedAfter.value!)))
const visible = computed(() => afterClear.value.filter(entry => logMatchesLevel(entry, level.value)))
const liveLabel = computed(() => {
  switch (events.status.value) {
    case 'open':
      return 'Live'
    case 'connecting':
    case 'waiting':
      return 'Reconnecting…'
    default:
      return 'Not connected'
  }
})

async function load() {
  loading.value = true
  loadError.value = null
  try {
    await plugins.fetchLogs(props.pluginId)
  }
  catch (error) {
    if (!isAbortError(error))
      loadError.value = toHarnessError(error).message
  }
  finally {
    loading.value = false
  }
  await scrollToEnd()
}

onMounted(load)
watch(() => props.pluginId, () => {
  clearedAfter.value = null
  void load()
})

function onLevel(value: AcceptableValue | AcceptableValue[]) {
  // A single ToggleGroup cannot be emptied: clicking the active item again keeps it.
  if (isLogLevelFilter(value))
    level.value = value
}

function clearView() {
  clearedAfter.value = entries.value.at(-1)?.seq ?? clearedAfter.value
}

function onScroll() {
  const element = scroller.value
  if (element)
    following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 24
}

async function scrollToEnd() {
  await nextTick()
  const element = scroller.value
  if (element)
    element.scrollTop = element.scrollHeight
}

watch(() => visible.value.at(-1)?.seq, () => {
  if (following.value)
    void scrollToEnd()
})

const LEVEL_CLASS: Record<PluginLogEntry['level'], string> = {
  debug: 'text-muted-foreground',
  info: 'text-foreground/80',
  warn: 'bg-warning/15 text-foreground dark:text-warning',
  error: 'bg-destructive/12 text-foreground dark:text-destructive',
}

function dataText(entry: PluginLogEntry): string | null {
  if (entry.data === undefined)
    return null
  try {
    return JSON.stringify(entry.data)
  }
  catch {
    return null
  }
}
</script>

<template>
  <section :data-testid="testIds.pluginLogs" :data-plugin-id="pluginId" aria-label="Plugin logs" class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        :model-value="level"
        :data-testid="testIds.pluginLogsLevel"
        :data-value="level"
        aria-label="Minimum level"
        @update:model-value="onLevel"
      >
        <ToggleGroupItem v-for="option in LOG_LEVEL_FILTERS" :key="option.value" :value="option.value" class="px-3 text-xs">
          {{ option.label }}
        </ToggleGroupItem>
      </ToggleGroup>
      <span class="ml-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="off">
        <span aria-hidden="true" :class="cn('size-1.5 rounded-full', liveLabel === 'Live' ? 'bg-success' : 'border border-muted-foreground')" />
        {{ liveLabel }}
      </span>
      <div class="ml-auto flex items-center gap-1">
        <CopyButton :text="() => logsAsText(visible)" label="Copy" size="sm" :disabled="visible.length === 0" />
        <Button type="button" variant="ghost" size="xs" class="text-muted-foreground hover:text-foreground" :disabled="afterClear.length === 0" @click="clearView">
          <EraserIcon aria-hidden="true" data-icon="inline-start" />
          Clear view
        </Button>
      </div>
    </div>

    <div
      ref="scroller"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      :aria-busy="loading || undefined"
      class="hf-scroll-stable h-[min(60vh,32rem)] min-h-64 overflow-y-auto overscroll-contain rounded-lg border bg-card font-mono text-xs"
      @scroll.passive="onScroll"
    >
      <div v-if="!loaded && !loadError" aria-hidden="true" class="flex flex-col gap-2 p-3">
        <Skeleton v-for="n in 6" :key="n" class="h-3.5" :style="{ width: `${40 + ((n * 17) % 50)}%` }" />
      </div>

      <div v-else-if="loadError && entries.length === 0" class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center font-sans">
        <p class="text-sm text-foreground">
          Could not load the logs
        </p>
        <p class="text-sm text-muted-foreground">
          {{ loadError }}
        </p>
        <Button type="button" size="sm" variant="outline" :disabled="loading" @click="load">
          Retry
        </Button>
      </div>

      <div v-else-if="visible.length === 0" class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center font-sans">
        <ScrollTextIcon aria-hidden="true" class="size-5 text-muted-foreground" />
        <p class="text-sm text-muted-foreground">
          <template v-if="afterClear.length > 0">
            No entries at this level.
          </template>
          <template v-else-if="clearedAfter !== null">
            View cleared. New entries appear here.
          </template>
          <template v-else>
            No log entries yet. Messages, warnings and errors of this plugin appear here as they happen.
          </template>
        </p>
        <Button v-if="clearedAfter !== null && entries.length > 0" type="button" variant="ghost" size="xs" @click="clearedAfter = null">
          Show earlier entries
        </Button>
      </div>

      <ol v-else class="flex flex-col py-1.5">
        <li
          v-for="entry in visible"
          :key="entry.seq"
          :data-testid="testIds.pluginLogEntry"
          :data-level="entry.level"
          :data-seq="entry.seq"
          class="grid grid-cols-[auto_3.25rem_minmax(0,1fr)] items-baseline gap-x-3 px-3 py-0.5 hover:bg-muted/50"
        >
          <time :datetime="new Date(entry.at).toISOString()" class="text-muted-foreground tabular-nums">{{ formatLogTime(entry.at) }}</time>
          <span :class="cn('justify-self-start rounded-sm px-1 text-[11px] leading-4 font-medium uppercase', LEVEL_CLASS[entry.level])">{{ entry.level }}</span>
          <span class="min-w-0 break-words whitespace-pre-wrap text-foreground">{{ entry.message }}<span v-if="dataText(entry)" class="ml-2 text-muted-foreground">{{ dataText(entry) }}</span></span>
        </li>
      </ol>
    </div>
  </section>
</template>
