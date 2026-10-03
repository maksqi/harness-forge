<script setup lang="ts">
// Folder browser of the Add project dialog (docs/UI.md 2.13, 9.10, 14.1, 14.2; ADR-031): with no folder open it lists
// the roots from projects.browse() (a missing root is disabled with "Not found"); then a breadcrumb inside nav "Folder
// path" (folder-browser-crumb, data-path; the current one aria-current="page"), Parent folder (folder-browser-up; at a
// root's top it returns to the roots) and the subfolders as buttons (folder-browser-entry, data-path; a click or Enter
// opens one); folders that already are projects show a "Project" badge and are disabled. Past 500 folders the list
// ends with "Showing the first 500 folders.". Each browse request aborts the previous one; after a folder opens, a
// polite live region announces "Opened {folder}, {n} folders" and focus moves to the first entry (else Parent folder)
// when focus was in the browser (or nowhere). Errors inline (folder-browser-error, data-code = the HarnessError code):
// 404 "This folder no longer exists." (with Parent folder and back to the roots), 400 "Choose a folder inside the
// workspace folders.", anything else the server message with Retry.
// Contract (docs/UI.md 10.4): props / emits below (frozen from Gate P7-0b; v-model: the open folder, null = the roots);
// root folder-browser (data-path = the open folder, '' for the roots; data-state = loading | ready | empty | error).
// Exposes `focus()` and the last known `roots` / `state` for the dialog (the "No workspace folders" alert, the submit).
import type { HarnessError, ProjectBrowse, ProjectBrowseRoot } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'
import { CircleAlertIcon, FolderIcon, FolderUpIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useProjectsStore } from '~/stores/projects'
import { isAbortError, toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { baseName, folderCrumbs } from './folder-path'

type FolderBrowserState = 'loading' | 'ready' | 'empty' | 'error'

const props = withDefaults(defineProps<{
  /** v-model: the open (= selected) folder; null = the roots. */
  modelValue: string | null
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{ 'update:modelValue': [path: string | null] }>()

const projects = useProjectsStore()
const root = useTemplateRef<HTMLElement>('root')

const state = ref<FolderBrowserState>('loading')
/** The answer for the open folder (null while it loads or after it failed). */
const result = shallowRef<ProjectBrowse | null>(null)
/** The roots of the last answer (every answer carries them); null before the first one. */
const roots = shallowRef<ProjectBrowseRoot[] | null>(null)
const failure = shallowRef<HarnessError | null>(null)
const announcement = ref('')

let controller: AbortController | null = null

const ENTRY_CLASS = cn(
  'flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none pointer-coarse:h-10',
  'hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
  'disabled:pointer-events-none disabled:opacity-60',
)

const crumbs = computed(() => (props.modelValue ? folderCrumbs(props.modelValue, (roots.value ?? []).map(item => item.path)) : []))
/** Where Parent folder goes: the folder above, or the roots (null) at a root's top. */
const parentPath = computed(() => crumbs.value.at(-2)?.path ?? null)

const errorText = computed(() => {
  const error = failure.value
  if (!error)
    return ''
  if (error.code === 'not_found')
    return 'This folder no longer exists.'
  if (error.code === 'validation_error' || error.code === 'forbidden')
    return 'Choose a folder inside the workspace folders.'
  return error.message
})

/** Focus belongs to the browser: it was inside it, on a removed entry (now body) or on the dialog itself. */
function ownsFocus(): boolean {
  const active = document.activeElement
  if (!active || active === document.body)
    return true
  return root.value?.contains(active) === true || active.getAttribute('role') === 'dialog'
}

/** Focuses the first enabled entry, else Parent folder, else the browser itself. */
function focus(): void {
  const element = root.value
  if (!element)
    return
  const target = element.querySelector<HTMLElement>(`[data-testid="${testIds.folderBrowserEntry}"]:not(:disabled)`)
    ?? element.querySelector<HTMLElement>(`[data-testid="${testIds.folderBrowserUp}"]:not(:disabled)`)
    ?? element
  target.focus()
}

async function load(path: string | null): Promise<void> {
  controller?.abort()
  const current = new AbortController()
  controller = current
  state.value = 'loading'
  result.value = null
  failure.value = null
  try {
    const answer = await projects.browse(path, { signal: current.signal })
    if (current.signal.aborted)
      return
    result.value = answer
    roots.value = answer.roots
    const count = path ? answer.entries.length : answer.roots.length
    state.value = count === 0 ? 'empty' : 'ready'
    if (path)
      announcement.value = `Opened ${baseName(path)}, ${answer.entries.length} ${answer.entries.length === 1 ? 'folder' : 'folders'}`
  }
  catch (error) {
    if (current.signal.aborted || isAbortError(error))
      return
    failure.value = toHarnessError(error)
    state.value = 'error'
  }
  finally {
    if (controller === current)
      controller = null
  }
  await nextTick()
  if (ownsFocus())
    focus()
}

watch(() => props.modelValue, path => void load(path), { immediate: true })

onBeforeUnmount(() => {
  controller?.abort()
  controller = null
})

function open(path: string | null): void {
  if (props.disabled)
    return
  if (path === props.modelValue)
    void load(path)
  else
    emit('update:modelValue', path)
}

defineExpose({ focus, roots, state })
</script>

<template>
  <div
    ref="root"
    :data-testid="testIds.folderBrowser"
    :data-path="modelValue ?? ''"
    :data-state="state"
    :aria-disabled="disabled || undefined"
    :aria-busy="state === 'loading' || undefined"
    tabindex="-1"
    class="flex min-h-40 min-w-0 flex-col rounded-md border outline-none"
  >
    <div v-if="modelValue" class="flex min-w-0 items-center gap-1 border-b px-1.5 py-1">
      <nav aria-label="Folder path" class="min-w-0 flex-1 overflow-x-auto">
        <ol class="flex min-w-max items-center gap-0.5 text-sm">
          <li v-for="(crumb, index) in crumbs" :key="crumb.path" class="flex items-center gap-0.5">
            <span v-if="index > 0" aria-hidden="true" class="px-0.5 text-muted-foreground">›</span>
            <button
              type="button"
              :data-testid="testIds.folderBrowserCrumb"
              :data-path="crumb.path"
              :aria-current="index === crumbs.length - 1 ? 'page' : undefined"
              :disabled="disabled"
              :class="cn(
                'rounded px-1.5 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:py-2.5',
                index === crumbs.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground',
              )"
              @click="open(crumb.path)"
            >
              {{ crumb.label }}
            </button>
          </li>
        </ol>
      </nav>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        :data-testid="testIds.folderBrowserUp"
        aria-label="Parent folder"
        title="Parent folder"
        :disabled="disabled"
        class="shrink-0 pointer-coarse:size-10"
        @click="open(parentPath)"
      >
        <FolderUpIcon aria-hidden="true" />
      </Button>
    </div>

    <div class="max-h-[min(18rem,40dvh)] min-h-0 flex-1 overflow-y-auto p-1">
      <div v-if="state === 'loading'" class="flex flex-col gap-1 p-1">
        <span class="sr-only">Loading folders…</span>
        <Skeleton v-for="n in 4" :key="n" class="h-7 rounded-md" />
      </div>

      <div
        v-else-if="state === 'error' && failure"
        :data-testid="testIds.folderBrowserError"
        :data-code="failure.code"
        role="alert"
        class="flex flex-col items-start gap-2 p-2.5 text-sm"
      >
        <p class="flex items-start gap-2">
          <CircleAlertIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{{ errorText }}</span>
        </p>
        <div class="flex flex-wrap gap-2">
          <Button
            v-if="failure.code === 'not_found' && modelValue"
            type="button"
            size="sm"
            variant="outline"
            :disabled="disabled"
            @click="open(parentPath)"
          >
            Parent folder
          </Button>
          <Button
            v-if="modelValue"
            type="button"
            size="sm"
            variant="outline"
            :disabled="disabled"
            @click="open(null)"
          >
            Back to workspace folders
          </Button>
          <Button
            v-if="failure.code !== 'not_found' && failure.code !== 'validation_error' && failure.code !== 'forbidden'"
            type="button"
            size="sm"
            variant="outline"
            :disabled="disabled"
            @click="load(modelValue)"
          >
            Retry
          </Button>
        </div>
      </div>

      <template v-else-if="result">
        <ul v-if="!modelValue" class="flex flex-col gap-px" aria-label="Workspace folders">
          <li v-for="item in result.roots" :key="item.path">
            <button
              type="button"
              :data-testid="testIds.folderBrowserEntry"
              :data-path="item.path"
              :disabled="disabled || !item.available"
              :aria-label="item.available ? undefined : `${item.path}, not found`"
              :class="ENTRY_CLASS"
              @click="open(item.path)"
            >
              <FolderIcon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="item.path">{{ item.path }}</span>
              <Badge v-if="!item.available" variant="outline" class="shrink-0">
                Not found
              </Badge>
            </button>
          </li>
        </ul>

        <template v-else>
          <p v-if="result.entries.length === 0" class="px-2.5 py-2 text-sm text-muted-foreground">
            No folders here.
          </p>
          <ul v-else class="flex flex-col gap-px" aria-label="Folders">
            <li v-for="entry in result.entries" :key="entry.path">
              <button
                type="button"
                :data-testid="testIds.folderBrowserEntry"
                :data-path="entry.path"
                :disabled="disabled || entry.projectId !== null"
                :aria-label="entry.projectId !== null ? `${entry.name}, already a project` : undefined"
                :class="ENTRY_CLASS"
                @click="open(entry.path)"
              >
                <FolderIcon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
                <Badge v-if="entry.projectId !== null" variant="secondary" class="shrink-0">
                  Project
                </Badge>
              </button>
            </li>
          </ul>
          <p v-if="result.truncated" class="px-2.5 py-2 text-xs text-muted-foreground">
            Showing the first {{ LIMITS.browseEntriesMax }} folders.
          </p>
        </template>
      </template>
    </div>

    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </p>
  </div>
</template>
