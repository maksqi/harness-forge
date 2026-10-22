<script setup lang="ts">
// The `@` file menu of a project chat (docs/UI.md 2.16, 7.26, 10.6, 14; ADR-042): mounted by ChatComposer after
// SlashMenu, with the state of `useFileMentions`. The SlashMenu contract: a listbox above the composer while `open`; the
// textarea keeps focus and forwards its keydown events to `handleKeydown` (true = consumed: ↑/↓ move, Enter or Tab
// pick, Esc closes) and points `aria-activedescendant` at `activeId`. Props, emits, exposes and root test id frozen
// from Gate P9-0b (C25); built by W9.8.
// Rows: `FileText` (file) or `Folder` (dir), the base name and its folder in muted text (under the name on phones), the
// characters `scorePath` matched as `<mark data-slot="mention-highlight">` runs (no raw HTML rendering). States: "Searching
// files…" (only after 150 ms of loading without rows; the previous rows stay meanwhile), "No matching files", the error
// line, and the footer "Showing the first 50 matches. Type more to narrow it down." when the index was cut. A polite
// region announces "{n} files" / "No matching files" 500 ms after the rows settle.
// Root `mention-menu` (`data-state` loading | ready | error, `data-count`; `role="listbox"`, `aria-busy` while loading);
// `mention-menu-item` per entry (`data-path`, `data-kind`).
// Phase 14 (ADR-061; C54 declares, W14.8 implements; frozen from Gate P14-0b): the optional `resources` (the MCP resources
// of `useResourceMentions`) and `resourcesState`, and the emit `select-resource`. One listbox holds two `role="group"`
// sections (`mention-menu-section`, `data-value` files | resources), each labelled by its sticky heading ("Files in
// {project}", "MCP resources"), so `aria-activedescendant` runs across both (files first). A resource row
// (`mention-menu-resource`, `data-server-id`, `data-uri`; 40px on coarse pointers): an icon from the MIME type, the title
// (else the name), an outline badge with the server's name and the MIME type muted; it is named "{title}, {server}, {mime
// type}". States: "Searching resources…" (after 150 ms without rows), "No matching resources", "Couldn't list MCP
// resources."; the truncation line and "Not listed: {names} (not connected)." (`data-slot="mention-resources-unavailable"`).
// `resourcesState: 'idle'` hides the section. W14.8 adds three optional props (additive; the defaults keep the frozen
// behavior): `files` (false hides the files section: a chat without a project), `resourcesTruncated` and
// `resourcesUnavailable` (the names of the servers whose resources are missing). The root `data-state` is the files'
// state (the resources' state without files) and `data-count` counts every option.
import type { McpResourceEntry, ProjectFileEntry } from '@harness-forge/shared'
import type { ResourceIconKind } from './mention-menu'
import { FileIcon, FileTextIcon, FileTypeIcon, FolderIcon, ImageIcon, Loader2Icon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import {
  mentionCountLabel,
  mentionRowLabel,
  resourceCountLabel,
  resourceIconKind,
  resourceOptionLabel,
  resourcesUnavailableText,
  resourceTitle,
} from './mention-menu'

const props = withDefaults(defineProps<{
  open: boolean
  /** What was typed after the `@`. */
  query: string
  /** The ranked matches of the project's files (`GET /projects/:id/files`). */
  items: readonly ProjectFileEntry[]
  state: 'loading' | 'ready' | 'error'
  /** The error line of the `error` state ("Couldn't search files."). */
  errorMessage?: string | null
  /** The project's index was cut: "Showing the first 50 matches. Type more to narrow it down." */
  truncated: boolean
  /** The project's name ("Files in {project}"). */
  projectName: string | null
  /** + Phase 14: the MCP resources matching the query (`useResourceMentions().items`); default none. */
  resources?: readonly McpResourceEntry[]
  /** + Phase 14: the state of the resource listing (`useResourceMentions().state`); default `idle`. */
  resourcesState?: 'idle' | 'loading' | 'ready' | 'error'
  /** + W14.8: the files section shows (a project chat); default true. */
  files?: boolean
  /** + W14.8: more resources matched than were listed; default false. */
  resourcesTruncated?: boolean
  /** + W14.8: the names of the servers whose resources are missing (not connected); default none. */
  resourcesUnavailable?: readonly string[]
}>(), {
  errorMessage: null,
  resources: () => [],
  resourcesState: 'idle',
  files: true,
  resourcesTruncated: false,
  resourcesUnavailable: () => [],
})

const emit = defineEmits<{
  'select': [entry: ProjectFileEntry]
  'close': []
  /** + Phase 14: an MCP resource was picked (the composer inserts its mention and attaches it). */
  'select-resource': [entry: McpResourceEntry]
}>()

/** "Searching files…" / "Searching resources…" show only when a search takes longer than this. */
const SEARCHING_DELAY_MS = 150
/** The polite count waits for the rows to settle. */
const ANNOUNCE_DELAY_MS = 500
const DEFAULT_ERROR = 'Couldn\'t search files.'
const RESOURCES_ERROR = 'Couldn\'t list MCP resources.'
const RESOURCES_LABEL = 'MCP resources'

const RESOURCE_ICONS: Record<ResourceIconKind, typeof FileIcon> = {
  text: FileTextIcon,
  image: ImageIcon,
  pdf: FileTypeIcon,
  file: FileIcon,
}

const listId = `mention-menu-${useId()}`
const filesHeadingId = `${listId}-files`
const resourcesHeadingId = `${listId}-resources`
const active = ref(0)

const showFiles = computed(() => props.files)
const showResources = computed(() => props.resourcesState !== 'idle')
const filesLabel = computed(() => (props.projectName ? `Files in ${props.projectName}` : 'Files'))
const label = computed(() => {
  if (showFiles.value && showResources.value)
    return 'Files and MCP resources'
  return showFiles.value ? filesLabel.value : RESOURCES_LABEL
})

const fileRows = computed(() => (showFiles.value
  ? props.items.map((entry, index) => ({ entry, index, label: mentionRowLabel(entry, props.query) }))
  : []))
const resourceRows = computed(() => {
  if (!showResources.value)
    return []
  const offset = fileRows.value.length
  return props.resources.map((entry, index) => ({
    entry,
    index: offset + index,
    title: resourceTitle(entry),
    icon: RESOURCE_ICONS[resourceIconKind(entry.mimeType)],
    name: resourceOptionLabel(entry),
    server: entry.serverName.trim() || entry.serverId,
    mime: entry.mimeType?.trim() ?? '',
  }))
})
/** Every option of the listbox, files first. */
const count = computed(() => fileRows.value.length + resourceRows.value.length)
const unavailableLine = computed(() => resourcesUnavailableText(props.resourcesUnavailable))

/** The root's `data-state`: the files' state, or the resources' state in a chat without files. */
const rootState = computed(() => {
  if (showFiles.value)
    return props.state
  return props.resourcesState === 'idle' ? 'ready' : props.resourcesState
})
const busy = computed(() => (showFiles.value && props.state === 'loading') || props.resourcesState === 'loading')

// New results (or a reopened menu) start at the best match.
watch([() => props.items, () => props.resources, () => props.open], () => {
  active.value = 0
})

function optionId(index: number): string {
  return `${listId}-option-${index}`
}

/** Id of the highlighted row (for `aria-activedescendant`), or undefined when the menu is closed. */
const activeId = computed<string | undefined>(() => (props.open && active.value < count.value ? optionId(active.value) : undefined))

function move(delta: number) {
  const total = count.value
  active.value = (active.value + delta + total) % total
  void nextTick(() => {
    const element = typeof document === 'undefined' ? null : document.getElementById(optionId(active.value))
    element?.scrollIntoView?.({ block: 'nearest' })
  })
}

function pick(index: number) {
  const file = fileRows.value[index]
  if (file) {
    emit('select', file.entry)
    return
  }
  const resource = resourceRows.value[index - fileRows.value.length]
  if (resource) {
    // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.10 (frozen in P14-0b)
    emit('select-resource', resource.entry)
  }
}

/** Handles a keydown of the textarea; true when the menu consumed it. */
function handleKeydown(event: KeyboardEvent): boolean {
  if (!props.open || event.isComposing)
    return false
  const modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      if (modified || count.value === 0)
        return false
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
      return true
    case 'Enter':
    case 'Tab':
      // Without rows, Enter sends and Tab moves the focus as usual.
      if (modified || count.value === 0)
        return false
      event.preventDefault()
      pick(active.value)
      return true
    case 'Escape':
      event.preventDefault()
      emit('close')
      return true
    default:
      return false
  }
}

// ---------- "Searching files…" / "Searching resources…" and the polite count ----------

function useSearchingDelay(loading: () => boolean) {
  const searching = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(loading, (value) => {
    clearTimeout(timer)
    searching.value = false
    if (value) {
      timer = setTimeout(() => {
        searching.value = true
      }, SEARCHING_DELAY_MS)
    }
  }, { immediate: true })
  onBeforeUnmount(() => clearTimeout(timer))
  return searching
}

const searching = useSearchingDelay(() => props.open && showFiles.value && props.state === 'loading')
const searchingResources = useSearchingDelay(() => props.open && props.resourcesState === 'loading')

/** What the polite region says once nothing loads: the files' count, then the resources' count. */
const settledAnnouncement = computed<string | null>(() => {
  if (busy.value)
    return null
  const parts: string[] = []
  if (showFiles.value)
    parts.push(props.state === 'error' ? props.errorMessage ?? DEFAULT_ERROR : mentionCountLabel(props.items.length))
  if (showResources.value)
    parts.push(props.resourcesState === 'error' ? RESOURCES_ERROR : resourceCountLabel(props.resources.length))
  return parts.join(', ')
})

const announcement = ref('')
let announceTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => [props.open, settledAnnouncement.value] as const,
  ([open, text]) => {
    clearTimeout(announceTimer)
    if (!open) {
      announcement.value = ''
      return
    }
    if (text === null)
      return
    announceTimer = setTimeout(() => {
      announcement.value = text
    }, ANNOUNCE_DELAY_MS)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  clearTimeout(announceTimer)
})

defineExpose({ handleKeydown, activeId, listId })

const HEADING_CLASS = 'sticky top-0 z-10 truncate bg-popover px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground'
const STATUS_CLASS = 'flex min-h-(--row-height) items-center gap-2 px-2 text-sm text-muted-foreground'
const ROW_CLASS = [
  'flex min-h-(--row-height) cursor-default items-center gap-2.5 rounded-md px-2 py-1 text-sm select-none pointer-coarse:min-h-10',
  'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
].join(' ')
</script>

<template>
  <div
    v-if="open"
    :id="listId"
    role="listbox"
    :aria-label="label"
    :aria-busy="busy || undefined"
    :data-testid="testIds.mentionMenu"
    :data-state="rootState"
    :data-count="count"
    class="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 slide-in-from-bottom-1 duration-(--duration-fast)"
  >
    <div class="max-h-[40dvh] overflow-y-auto overscroll-contain px-1 pb-1">
      <div
        v-if="showFiles"
        role="group"
        :aria-labelledby="filesHeadingId"
        :data-testid="testIds.mentionMenuSection"
        data-value="files"
      >
        <div :id="filesHeadingId" aria-hidden="true" :class="HEADING_CLASS">
          {{ filesLabel }}
        </div>
        <div
          v-for="row in fileRows"
          :id="optionId(row.index)"
          :key="`${row.entry.kind}:${row.entry.path}`"
          role="option"
          :aria-selected="row.index === active"
          :data-testid="testIds.mentionMenuItem"
          :data-path="row.entry.path"
          :data-kind="row.entry.kind"
          :data-highlighted="row.index === active ? '' : undefined"
          :class="ROW_CLASS"
          @mousedown.prevent
          @pointermove="active = row.index"
          @click="pick(row.index)"
        >
          <FolderIcon v-if="row.entry.kind === 'dir'" aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
          <FileTextIcon v-else aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
          <span class="flex min-w-0 flex-1 items-baseline gap-3 max-sm:flex-col max-sm:items-start max-sm:gap-0">
            <span class="max-w-full min-w-0 shrink-0 truncate">
              <template v-for="(run, runIndex) in row.label.name" :key="runIndex">
                <mark v-if="run.match" data-slot="mention-highlight" class="rounded-[2px] bg-primary/20 text-inherit">{{ run.text }}</mark>
                <template v-else>{{ run.text }}</template>
              </template>
            </span>
            <template v-if="row.label.folder.length > 0">
              <!-- A blank between the name and the folder for the option's accessible name (ignored by the flex layout). -->
              {{ ' ' }}<span class="max-w-full min-w-0 truncate text-xs text-muted-foreground">
                <template v-for="(run, runIndex) in row.label.folder" :key="runIndex">
                  <mark v-if="run.match" data-slot="mention-highlight" class="rounded-[2px] bg-primary/20 text-inherit">{{ run.text }}</mark>
                  <template v-else>{{ run.text }}</template>
                </template>
              </span>
            </template>
          </span>
        </div>
        <div
          v-if="items.length === 0 && (state !== 'loading' || searching)"
          aria-hidden="true"
          data-slot="mention-status"
          :class="cn(STATUS_CLASS, state === 'error' && 'text-destructive')"
        >
          <template v-if="state === 'loading'">
            <Loader2Icon aria-hidden="true" class="size-4 animate-spin" />
            Searching files…
          </template>
          <template v-else-if="state === 'error'">
            {{ errorMessage ?? DEFAULT_ERROR }}
          </template>
          <template v-else>
            No matching files
          </template>
        </div>
        <div v-if="truncated" aria-hidden="true" data-slot="mention-truncated" class="px-2 py-1.5 text-xs text-muted-foreground">
          Showing the first 50 matches. Type more to narrow it down.
        </div>
      </div>

      <div
        v-if="showResources"
        role="group"
        :aria-labelledby="resourcesHeadingId"
        :data-testid="testIds.mentionMenuSection"
        data-value="resources"
        :class="cn(showFiles && 'mt-1 border-t pt-1')"
      >
        <div :id="resourcesHeadingId" aria-hidden="true" :class="HEADING_CLASS">
          {{ RESOURCES_LABEL }}
        </div>
        <div
          v-for="row in resourceRows"
          :id="optionId(row.index)"
          :key="`resource:${row.entry.serverId}:${row.entry.uri}`"
          role="option"
          :aria-selected="row.index === active"
          :aria-label="row.name"
          :data-testid="testIds.mentionMenuResource"
          :data-server-id="row.entry.serverId"
          :data-uri="row.entry.uri"
          :data-highlighted="row.index === active ? '' : undefined"
          :class="ROW_CLASS"
          @mousedown.prevent
          @pointermove="active = row.index"
          @click="pick(row.index)"
        >
          <component :is="row.icon" aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
          <span class="flex min-w-0 flex-1 items-baseline gap-3 max-sm:flex-col max-sm:items-start max-sm:gap-0">
            <span class="max-w-full min-w-0 shrink-0 truncate" data-slot="mention-resource-title">{{ row.title }}</span>
            <span v-if="row.mime" class="max-w-full min-w-0 truncate text-xs text-muted-foreground" data-slot="mention-resource-mime">{{ row.mime }}</span>
          </span>
          <Badge variant="outline" class="max-w-[40%] font-normal" data-slot="mention-resource-server">
            <span class="truncate">{{ row.server }}</span>
          </Badge>
        </div>
        <div
          v-if="resources.length === 0 && (resourcesState !== 'loading' || searchingResources)"
          aria-hidden="true"
          data-slot="mention-resources-status"
          :class="cn(STATUS_CLASS, resourcesState === 'error' && 'text-destructive')"
        >
          <template v-if="resourcesState === 'loading'">
            <Loader2Icon aria-hidden="true" class="size-4 animate-spin" />
            Searching resources…
          </template>
          <template v-else-if="resourcesState === 'error'">
            {{ RESOURCES_ERROR }}
          </template>
          <template v-else>
            No matching resources
          </template>
        </div>
        <div v-if="resourcesTruncated" aria-hidden="true" data-slot="mention-resources-truncated" class="px-2 py-1.5 text-xs text-muted-foreground">
          Showing the first 50 resources. Type more to narrow it down.
        </div>
        <div v-if="unavailableLine" aria-hidden="true" data-slot="mention-resources-unavailable" class="px-2 py-1.5 text-xs text-muted-foreground">
          {{ unavailableLine }}
        </div>
      </div>
    </div>
  </div>
  <p class="sr-only" aria-live="polite" aria-atomic="true" data-slot="mention-announcer">
    {{ announcement }}
  </p>
</template>
