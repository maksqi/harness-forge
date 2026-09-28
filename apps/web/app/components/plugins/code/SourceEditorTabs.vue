<script setup lang="ts">
// Open-file tabs of the Source tab (docs/UI.md 8.10): name, a dirty dot that turns into the close button on hover or
// focus, middle-click closes, Left / Right / Home / End move between tabs. The parent asks before closing a dirty tab.
import { XIcon } from '@lucide/vue'
import { nextTick, useTemplateRef } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { baseName } from './source-files'

export interface SourceTabItem {
  path: string
  dirty: boolean
}

const props = defineProps<{
  tabs: readonly SourceTabItem[]
  activePath: string | null
}>()

const emit = defineEmits<{
  select: [path: string]
  close: [path: string]
}>()

const list = useTemplateRef<HTMLDivElement>('list')

function onAuxClick(event: MouseEvent, path: string) {
  if (event.button !== 1)
    return
  event.preventDefault()
  emit('close', path)
}

async function onKeydown(event: KeyboardEvent) {
  const index = props.tabs.findIndex(tab => tab.path === props.activePath)
  if (index < 0)
    return
  const targets: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: props.tabs.length - 1 }
  const target = targets[event.key]
  if (target === undefined || target < 0 || target >= props.tabs.length)
    return
  event.preventDefault()
  emit('select', props.tabs[target]!.path)
  await nextTick()
  list.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
}
</script>

<template>
  <div
    ref="list"
    role="tablist"
    aria-label="Open files"
    class="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:thin]"
    @keydown="onKeydown"
  >
    <div
      v-for="tab in tabs"
      :key="tab.path"
      :class="cn(
        'group/tab relative flex shrink-0 items-center border-r text-sm',
        tab.path === activePath ? 'bg-background text-foreground' : 'bg-muted/40 text-muted-foreground hover:text-foreground',
      )"
      :data-testid="testIds.codeEditorTab"
      :data-path="tab.path"
      :data-dirty="tab.dirty ? 'true' : 'false'"
      @auxclick="onAuxClick($event, tab.path)"
      @mousedown.middle.prevent
    >
      <span v-if="tab.path === activePath" aria-hidden="true" class="absolute inset-x-0 top-0 h-0.5 bg-primary" />
      <button
        type="button"
        role="tab"
        :aria-selected="tab.path === activePath"
        :tabindex="tab.path === activePath ? 0 : -1"
        :title="tab.path"
        class="flex h-9 max-w-56 items-center truncate pr-1 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        @click="emit('select', tab.path)"
      >
        <span class="truncate">{{ baseName(tab.path) }}</span>
        <span v-if="tab.dirty" class="sr-only">(unsaved)</span>
      </button>
      <button
        type="button"
        :aria-label="`Close ${baseName(tab.path)}`"
        :title="tab.dirty ? 'Unsaved changes' : undefined"
        class="relative mr-1.5 flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        @click="emit('close', tab.path)"
      >
        <span
          v-if="tab.dirty"
          aria-hidden="true"
          class="size-2 rounded-full bg-foreground/70 group-hover/tab:hidden group-focus-within/tab:hidden"
        />
        <XIcon
          aria-hidden="true"
          :class="cn('size-3.5', tab.dirty && 'hidden group-hover/tab:block group-focus-within/tab:block')"
        />
      </button>
    </div>
  </div>
</template>
