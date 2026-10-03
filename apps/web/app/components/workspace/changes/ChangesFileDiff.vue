<script setup lang="ts">
// The lazy diff of an open changes row (docs/UI.md 7.21): `GET /api/chats/:id/changes/diff?source={view}&path=` through
// workspace.fileDiff (aborted on unmount; a 3-line skeleton meanwhile), then DiffView with the diff's hunks, its
// added / removed as `stats` and line numbers; the notes for a binary file, a file too large for a diff and a base
// that is no longer stored; "Couldn't load the diff" with Retry (data-slot="changes-diff-error") on a failure. A refresh
// of the view (its entry's `loadedAt` changes; the store dropped the cached diffs) reloads it, keeping the shown diff
// until the new one arrives. Each loaded diff is reported to the panel (its `currentSha` is the revert's `expectedSha`).
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props below, no emits; no root test id (data-slot="changes-diff",
// data-state = loading | ready | error).
import type { FileDiff, HarnessError } from '@harness-forge/shared'
import type { ChangesView } from './changes-rows'
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import DiffView from '~/components/chat/parts/tools/DiffView.vue'
import { useWorkspaceStore } from '~/stores/workspace'
import { isAbortError, toHarnessError } from '~/utils/errors'
import { CHANGES_PANEL_CONTEXT } from './changes-context'

const props = defineProps<{
  chatId: string
  view: ChangesView
  path: string
}>()

const workspace = useWorkspaceStore()
const context = inject(CHANGES_PANEL_CONTEXT, null)

const diff = shallowRef<FileDiff | null>(null)
const error = shallowRef<HarnessError | null>(null)
const loading = ref(false)
let controller: AbortController | null = null

async function load() {
  controller?.abort()
  const own = new AbortController()
  controller = own
  loading.value = true
  error.value = null
  try {
    const result = await workspace.fileDiff(props.chatId, props.view, props.path, { signal: own.signal })
    if (own.signal.aborted)
      return
    diff.value = result
    context?.diffLoaded(props.view, props.path, result)
  }
  catch (failure) {
    if (own.signal.aborted || isAbortError(failure))
      return
    error.value = toHarnessError(failure)
  }
  finally {
    if (controller === own) {
      controller = null
      loading.value = false
    }
  }
}

watch(() => [props.chatId, props.view, props.path], () => {
  diff.value = null
  void load()
}, { immediate: true })

/** The view's last successful fetch: a refresh dropped the cached diffs, so the diff loads again. */
const loadedAt = computed(() => (props.view === 'chat' ? workspace.chat[props.chatId] : workspace.git[props.chatId])?.loadedAt ?? null)
watch(loadedAt, (now, before) => {
  if (now !== null && before !== null && now !== before)
    void load()
})

onBeforeUnmount(() => {
  controller?.abort()
  controller = null
})

const state = computed(() => (error.value ? 'error' : diff.value ? 'ready' : 'loading'))

/** What a ready diff shows instead of the lines, if anything. */
const note = computed(() => {
  const value = diff.value
  if (!value)
    return null
  if (value.binary)
    return 'Binary file. No preview.'
  if (value.tooLarge)
    return 'This file is too large to show a diff.'
  if (value.source === 'chat' && !value.baseAvailable)
    return 'The earlier version of this file is no longer stored, so it can\'t be shown or reverted.'
  return null
})

const created = computed(() => diff.value?.status === 'added' || diff.value?.status === 'untracked')
const stats = computed(() => {
  const changes = diff.value?.diff
  return changes ? { additions: changes.added, deletions: changes.removed } : null
})
</script>

<template>
  <div data-slot="changes-diff" :data-state="state" :aria-busy="loading || undefined" class="flex min-w-0 flex-col">
    <div v-if="state === 'loading'" class="flex flex-col gap-1.5 rounded-md border p-2.5" aria-hidden="true">
      <Skeleton class="h-3 w-2/3" />
      <Skeleton class="h-3 w-5/6" />
      <Skeleton class="h-3 w-1/2" />
    </div>
    <div
      v-else-if="state === 'error'"
      data-slot="changes-diff-error"
      :data-code="error?.code"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs"
    >
      <span class="font-medium text-foreground">Couldn't load the diff</span>
      <span class="min-w-0 flex-1 text-muted-foreground">{{ error?.message }}</span>
      <Button type="button" size="xs" variant="outline" class="pointer-coarse:h-10" @click="load">
        Retry
      </Button>
    </div>
    <p v-else-if="note" data-slot="changes-diff-note" class="rounded-md border px-2.5 py-2 text-xs text-muted-foreground">
      {{ note }}
    </p>
    <DiffView
      v-else-if="diff"
      :hunks="diff.diff?.hunks ?? []"
      :path="path"
      :created="created"
      :truncated="diff.diff ? diff.diff.truncated : true"
      :stats="stats"
      :line-numbers="true"
    />
  </div>
</template>
