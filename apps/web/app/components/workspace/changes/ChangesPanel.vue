<script setup lang="ts">
// The changes panel (docs/UI.md 2.15, 7.21, 14; ADR-036, ADR-037): an h-12 header (the h2 "Changes" that labels the
// pane, the Tabs This chat | Git (changes-view-option, data-value; the choice persists), Refresh (changes-refresh, spins
// with aria-busy) and Close (changes-close)), then one scroll area: the error alert (changes-error, data-code; earlier
// rows stay), the summary line (changes-summary, data-count), the rows (ChangesFileRow, accordions with lazy diffs) or
// ChangesEmpty, and the footer notes (truncated list, untracked changes). It owns the RevertFileDialog: after a revert
// a polite region announces "Reverted {path}" and focus moves to the next row (else the previous one, else the view
// tabs). Data comes from the workspace store: the shown view loads on mount and on a view switch, again when the chat
// moves to another project, on Refresh and on window focus while the Git view shows (the store follows the server
// events). Used as the desktop pane (`variant="pane"`, inside ChatWorkspace's <aside>) and inside the right sheet below
// 1024px (`variant="sheet"`, with a 40px Close).
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; root changes-panel (data-view = chat |
// git, data-state = loading | ready | error | unavailable).
import type { FileDiff, RestoreResult } from '@harness-forge/shared'
import type { ChangesRow, ChangesView } from './changes-rows'
import { RefreshCwIcon, XIcon } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, provide, reactive, ref, shallowRef, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useChangesPanel } from '~/composables/useChangesPanel'
import { useWorkspaceStore } from '~/stores/workspace'
import { testIds } from '~/utils/testids'
import { CHANGES_PANEL_CONTEXT } from './changes-context'
import {
  CHANGES_HEADING_ID,
  CHANGES_PANEL_ID,
  changesEmptyReason,
  changesSummary,
  changesTruncatedNote,
  chatChangeRows,
  gitChangeRows,
  untrackedNote,
} from './changes-rows'
import ChangesEmpty from './ChangesEmpty.vue'
import ChangesFileRow from './ChangesFileRow.vue'
import RevertFileDialog from './RevertFileDialog.vue'

const props = defineProps<{
  chatId: string
  projectId: string
  variant: 'pane' | 'sheet'
}>()

const emit = defineEmits<{
  /** Close was clicked (the caller closes the panel and returns focus to the toggle). */
  close: []
}>()

const VIEWS: ReadonlyArray<{ value: ChangesView, label: string }> = [
  { value: 'chat', label: 'This chat' },
  { value: 'git', label: 'Git' },
]

const panel = useChangesPanel()
const workspace = useWorkspaceStore()
const root = ref<HTMLElement | null>(null)

const view = computed<ChangesView>(() => panel.view.value)

function setView(value: string | number) {
  if (value === 'chat' || value === 'git')
    panel.view.value = value
}

const entry = computed(() => (view.value === 'chat' ? workspace.chat[props.chatId] : workspace.git[props.chatId]) ?? null)
const data = computed(() => entry.value?.data ?? null)
const loading = computed(() => entry.value?.loading ?? false)
const error = computed(() => entry.value?.error ?? null)

const rows = computed<ChangesRow[]>(() => {
  const value = data.value
  if (!value)
    return []
  return 'untracked' in value ? chatChangeRows(value) : gitChangeRows(value)
})

const state = computed<'loading' | 'ready' | 'error' | 'unavailable'>(() => {
  if (error.value)
    return 'error'
  if (!data.value)
    return 'loading'
  return data.value.available ? 'ready' : 'unavailable'
})

const summary = computed(() => (data.value ? changesSummary(view.value, data.value) : ''))
const emptyReason = computed(() => (data.value ? changesEmptyReason(view.value, data.value) : null))
const truncated = computed(() => (data.value?.truncated ? changesTruncatedNote(view.value) : null))
const untracked = computed(() => {
  const value = data.value
  return value && 'untracked' in value && value.available ? untrackedNote(value.untracked) : null
})

function fetchView(target: ChangesView, force = false): Promise<void> {
  return target === 'chat'
    ? workspace.fetchChatChanges(props.chatId, { force })
    : workspace.fetchGit(props.chatId, { force })
}

watch(view, value => void fetchView(value), { immediate: true })
// The chat moved to another project: both views now describe another folder.
watch(() => props.projectId, () => {
  void fetchView(view.value, true)
})
useEventListener(globalThis.window, 'focus', () => {
  if (view.value === 'git')
    void workspace.fetchGit(props.chatId)
})

function refresh() {
  void fetchView(view.value, true)
}

// ---------- rows ----------

const keyOf = (target: ChangesView, path: string) => `${target}\n${path}`

/** Open rows per view (`${view}\n${path}`). */
const openRows = ref(new Set<string>())
/** `FileDiff.currentSha` of every diff the user saw (null: the file was missing). */
const shas = reactive(new Map<string, string | null>())

function isOpen(row: ChangesRow): boolean {
  return openRows.value.has(keyOf(view.value, row.path))
}

function setRowOpen(row: ChangesRow, open: boolean) {
  const next = new Set(openRows.value)
  if (open)
    next.add(keyOf(view.value, row.path))
  else
    next.delete(keyOf(view.value, row.path))
  openRows.value = next
}

provide(CHANGES_PANEL_CONTEXT, {
  diffLoaded: (target: ChangesView, path: string, diff: FileDiff) => {
    shas.set(keyOf(target, path), diff.currentSha)
  },
  revertStale: (target: ChangesView, path: string) => {
    if (target !== view.value)
      return
    const next = new Set(openRows.value)
    next.add(keyOf(target, path))
    openRows.value = next
  },
})

// ---------- revert ----------

const revertRow = shallowRef<ChangesRow | null>(null)
const revertOpen = ref(false)
const revertSha = computed(() => {
  const row = revertRow.value
  if (!row)
    return undefined
  const key = keyOf(view.value, row.path)
  return shas.has(key) ? shas.get(key) ?? null : undefined
})

function onRevert(row: ChangesRow) {
  revertRow.value = row
  revertOpen.value = true
}

/** The polite region's text ("Reverted {path}"). */
const announcement = ref('')

function rowButton(path: string): HTMLElement | null {
  const rowsInPanel = root.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.changesFile}"]`) ?? []
  const element = [...rowsInPanel].find(item => item.dataset.path === path)
  return element?.querySelector<HTMLElement>('button[aria-expanded]') ?? null
}

function focusActiveTab() {
  root.value?.querySelector<HTMLElement>(`[data-testid="${testIds.changesViewOption}"][data-state="active"]`)?.focus()
}

async function onReverted(_result: RestoreResult, path: string) {
  const list = rows.value
  const index = list.findIndex(row => row.path === path)
  const target = index < 0 ? undefined : list[index + 1] ?? list[index - 1]
  announcement.value = ''
  await nextTick()
  announcement.value = `Reverted ${path}`
  const button = target ? rowButton(target.path) : null
  if (button)
    button.focus()
  else
    focusActiveTab()
}
</script>

<template>
  <div
    :id="CHANGES_PANEL_ID"
    ref="root"
    :data-testid="testIds.changesPanel"
    :data-view="view"
    :data-state="state"
    :data-variant="variant"
    class="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
  >
    <Tabs :model-value="view" class="min-h-0 flex-1 gap-0" @update:model-value="setView">
      <div class="flex h-(--header-height) shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <h2 :id="CHANGES_HEADING_ID" class="shrink-0 text-sm font-medium">
          Changes
        </h2>
        <TabsList class="h-8 min-w-0 pointer-coarse:h-10">
          <TabsTrigger
            v-for="option in VIEWS"
            :key="option.value"
            :value="option.value"
            :data-testid="testIds.changesViewOption"
            :data-value="option.value"
            class="px-2 text-xs"
          >
            {{ option.label }}
          </TabsTrigger>
        </TabsList>
        <div class="ml-auto flex shrink-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh changes"
            title="Refresh changes"
            :aria-busy="loading || undefined"
            :data-testid="testIds.changesRefresh"
            class="text-muted-foreground hover:text-foreground pointer-coarse:size-10"
            @click="refresh"
          >
            <RefreshCwIcon :class="cn(loading && 'animate-spin motion-reduce:animate-none')" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            :size="variant === 'sheet' ? 'icon-lg' : 'icon-sm'"
            aria-label="Close changes"
            title="Close changes"
            :data-testid="testIds.changesClose"
            class="text-muted-foreground hover:text-foreground pointer-coarse:size-10"
            @click="emit('close')"
          >
            <XIcon />
          </Button>
        </div>
      </div>

      <TabsContent :value="view" class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <div v-if="state === 'loading'" class="flex flex-col gap-2.5 px-4 py-3" aria-hidden="true">
          <div v-for="index in 3" :key="index" class="flex items-center gap-2">
            <Skeleton class="size-4 shrink-0" />
            <Skeleton class="h-3.5 flex-1" />
          </div>
        </div>
        <template v-else>
          <div v-if="error" class="px-3 pt-3">
            <Alert variant="destructive" :data-testid="testIds.changesError" :data-code="error.code">
              <AlertTitle>Couldn't load the changes</AlertTitle>
              <AlertDescription class="text-foreground/80">
                {{ error.message }}
              </AlertDescription>
              <div class="col-start-2 mt-2">
                <Button type="button" size="sm" variant="outline" class="text-foreground pointer-coarse:h-10" @click="refresh">
                  Retry
                </Button>
              </div>
            </Alert>
          </div>
          <template v-if="data">
            <p
              v-if="summary"
              :data-testid="testIds.changesSummary"
              :data-count="rows.length"
              class="truncate px-4 pt-3 pb-1 text-xs text-muted-foreground tabular-nums"
              :title="summary"
            >
              {{ summary }}
            </p>
            <ChangesEmpty v-if="emptyReason" :reason="emptyReason" />
            <ul v-else class="flex flex-col py-1">
              <li v-for="row in rows" :key="row.path" class="min-w-0">
                <ChangesFileRow
                  :chat-id="chatId"
                  :view="view"
                  :row="row"
                  :open="isOpen(row)"
                  @update:open="setRowOpen(row, $event)"
                  @revert="onRevert"
                />
              </li>
            </ul>
            <p v-if="truncated" data-slot="changes-truncated" class="px-4 py-2 text-xs text-muted-foreground">
              {{ truncated }}
            </p>
            <p v-if="untracked" data-slot="changes-untracked" class="px-4 py-2 text-xs text-muted-foreground">
              {{ untracked }}
            </p>
          </template>
        </template>
      </TabsContent>
    </Tabs>

    <div aria-live="polite" aria-atomic="true" class="sr-only">
      {{ announcement }}
    </div>

    <RevertFileDialog
      v-model:open="revertOpen"
      :chat-id="chatId"
      :view="view"
      :row="revertRow"
      :expected-sha="revertSha"
      @reverted="onReverted"
    />
  </div>
</template>
