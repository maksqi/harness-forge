<script setup lang="ts">
// Build / log panel of the Source tab (docs/UI.md 8.10): the problems of the last build (a click jumps to the location)
// and the plugin log fed by live `plugin.log` events (build output lines, `ctx.logger` entries): time, level, message.
// Auto-scrolls unless the user scrolled up; "Clear" hides the entries so far (the Logs tab keeps them).
import type { BuildDiagnostic, BuildResult, PluginLogEntry } from '@harness-forge/shared'
import { ChevronDownIcon, CircleAlertIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { logTime, problemsText } from './source-files'

const props = withDefaults(defineProps<{
  pluginId: string
  diagnostics?: readonly BuildDiagnostic[]
  lastBuild?: BuildResult | null
  building?: boolean
}>(), {
  diagnostics: () => [],
  lastBuild: null,
  building: false,
})

const emit = defineEmits<{
  select: [diagnostic: BuildDiagnostic]
  collapse: []
}>()

const plugins = usePluginsStore()
const scroller = useTemplateRef<HTMLDivElement>('scroller')
/** Entries up to this sequence number are hidden ("Clear"). */
const clearedSeq = ref(0)
const stickToBottom = ref(true)

onMounted(() => {
  void plugins.fetchLogs(props.pluginId).catch(() => {})
})

watch(() => props.pluginId, (id) => {
  clearedSeq.value = 0
  void plugins.fetchLogs(id).catch(() => {})
})

const entries = computed<PluginLogEntry[]>(() => (plugins.logs[props.pluginId] ?? []).filter(entry => entry.seq > clearedSeq.value))

const summary = computed(() => {
  if (props.building)
    return 'Building…'
  const build = props.lastBuild
  if (!build)
    return ''
  const problems = problemsText(props.diagnostics)
  if (build.ok)
    return `Build succeeded in ${Math.round(build.durationMs)} ms${problems ? ` · ${problems}` : ''}`
  return `Build failed${problems ? ` · ${problems}` : ''}`
})

// Warnings use a colored dot, not colored text (UI.md 14.3: warning is not a small-text color in light mode).
const LEVEL_TEXT: Record<PluginLogEntry['level'], string> = {
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-foreground',
  error: 'text-destructive',
}
const LEVEL_DOT: Record<PluginLogEntry['level'], string> = {
  debug: 'bg-muted-foreground/50',
  info: 'bg-muted-foreground',
  warn: 'bg-warning',
  error: 'bg-destructive',
}

function location(diagnostic: BuildDiagnostic): string {
  if (diagnostic.file === null)
    return ''
  const line = diagnostic.line === null ? '' : `:${diagnostic.line}${diagnostic.column === null ? '' : `:${diagnostic.column}`}`
  return `${diagnostic.file}${line}`
}

function clear() {
  const last = (plugins.logs[props.pluginId] ?? []).at(-1)
  clearedSeq.value = last?.seq ?? clearedSeq.value
}

function onScroll() {
  const element = scroller.value
  if (element)
    stickToBottom.value = element.scrollTop + element.clientHeight >= element.scrollHeight - 8
}

watch(() => [entries.value.length, props.diagnostics.length], async () => {
  if (!stickToBottom.value)
    return
  await nextTick()
  const element = scroller.value
  if (element)
    element.scrollTop = element.scrollHeight
})
</script>

<template>
  <section :data-testid="testIds.codeBuildLog" aria-label="Build output" class="flex h-full min-h-0 flex-col bg-background">
    <header class="flex h-9 shrink-0 items-center gap-2 border-b pr-1 pl-3">
      <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Build output</span>
      <span
        v-if="summary"
        role="status"
        :class="cn('truncate text-xs', lastBuild && !lastBuild.ok && !building ? 'text-destructive' : 'text-muted-foreground')"
      >{{ summary }}</span>
      <span class="ml-auto flex items-center gap-1">
        <Button type="button" variant="ghost" size="xs" @click="clear">
          Clear
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Hide build output" title="Hide build output" @click="emit('collapse')">
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      </span>
    </header>
    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto font-mono text-xs" @scroll.passive="onScroll">
      <ul v-if="diagnostics.length > 0" aria-label="Problems" class="border-b py-1">
        <li v-for="(diagnostic, index) in diagnostics" :key="index">
          <button
            type="button"
            class="flex w-full items-start gap-2 px-3 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
            @click="emit('select', diagnostic)"
          >
            <CircleAlertIcon v-if="diagnostic.severity === 'error'" aria-label="Error" class="mt-px size-3.5 shrink-0 text-destructive" />
            <TriangleAlertIcon v-else aria-label="Warning" class="mt-px size-3.5 shrink-0 text-warning" />
            <span class="min-w-0 flex-1 break-words whitespace-pre-wrap">
              <span v-if="location(diagnostic)" class="mr-2 text-muted-foreground">{{ location(diagnostic) }}</span>
              <span>{{ diagnostic.message }}</span>
            </span>
          </button>
        </li>
      </ul>
      <ol aria-label="Plugin log" class="py-1">
        <li
          v-for="entry in entries"
          :key="entry.seq"
          :data-level="entry.level"
          class="flex gap-3 px-3 py-0.5"
        >
          <time :datetime="new Date(entry.at).toISOString()" class="shrink-0 text-muted-foreground tabular-nums">{{ logTime(entry.at) }}</time>
          <span class="flex w-12 shrink-0 items-center gap-1.5 text-muted-foreground uppercase">
            <span aria-hidden="true" :class="cn('size-1.5 rounded-full', LEVEL_DOT[entry.level])" />
            {{ entry.level }}
          </span>
          <span :class="cn('min-w-0 flex-1 break-words whitespace-pre-wrap', LEVEL_TEXT[entry.level])">{{ entry.message }}</span>
        </li>
        <li v-if="entries.length === 0 && diagnostics.length === 0" class="px-3 py-2 font-sans text-muted-foreground">
          Build output and log entries of this plugin appear here.
        </li>
      </ol>
    </div>
  </section>
</template>
