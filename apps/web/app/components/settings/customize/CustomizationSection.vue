<script setup lang="ts">
// One source section of one kind on the Customize page (docs/UI.md 2.17, 9.12, 10.7, 14.2): the heading "{title} · {n}"
// (an h2; the project section also shows the scanned folders of the kind in mono), the rows in a list, the empty state
// of a personal or project section (`customize-empty`; the personal one ends with the parent's New / Import… buttons
// through the `empty-actions` slot), or an Alert for an unavailable project folder instead of the rows. Folder-level
// problems of the project (a linked folder, too many files) come through the `notices` slot under the heading. Built-in
// command rows come in as entries with source 'builtin' (no menu).
// Props, emits and the root test id are frozen from Gate P10-0b (C33).
// Phase 12 (W12.11; docs/UI.md 9.14): the optional `heading-actions` slot puts actions after the heading (the project
// section's New file…, `data-action="new-project-file"`).
import type { CustomizationEntry, CustomizationKind, CustomizationSource } from '@harness-forge/shared'
import type { CustomizationAction } from './customize'
import { FolderXIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { testIds } from '~/utils/testids'
import CustomizationRow from './CustomizationRow.vue'
import { PERSONAL_EMPTY, projectEmpty } from './customize'

const props = defineProps<{
  source: CustomizationSource
  kind: CustomizationKind
  entries: readonly CustomizationEntry[]
  /** "In {project}" (source project). */
  projectName?: string | null
  /** The scanned folders shown in the project heading. */
  folders?: readonly string[]
  /** An unavailable project folder: an Alert instead of the rows. */
  issue?: string | null
  /** Personal rows with a toggle / delete in flight. */
  busyIds?: readonly string[]
}>()

const emit = defineEmits<{ action: [action: CustomizationAction, entry: CustomizationEntry] }>()

defineSlots<{
  /** Folder-level problems under the heading (project sections). */
  'notices'?: () => any
  /** Buttons after the personal empty state (New {kind}, Import…). */
  'empty-actions'?: () => any
  /** + Phase 12: actions at the end of the heading (the project section's New file…). */
  'heading-actions'?: () => any
}>()

const TITLES: Readonly<Record<CustomizationSource, string>> = {
  user: 'Personal',
  project: 'Project',
  plugin: 'From plugins',
  builtin: 'Built-in',
}

const title = computed(() => (props.source === 'project' && props.projectName ? `In ${props.projectName}` : TITLES[props.source]))
const count = computed(() => (props.issue ? 0 : props.entries.length))
const emptyText = computed(() => {
  if (props.entries.length > 0 || props.issue)
    return null
  if (props.source === 'user')
    return PERSONAL_EMPTY[props.kind]
  if (props.source === 'project')
    return projectEmpty(props.kind, props.projectName ?? 'this project')
  return null
})

function rowKey(entry: CustomizationEntry): string {
  return `${entry.source}:${entry.id ?? entry.path ?? entry.pluginId ?? ''}:${entry.name}`
}
</script>

<template>
  <section :data-testid="testIds.customizeSection" :data-source="source" :data-count="count" class="flex flex-col gap-2 py-3">
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h2 class="text-sm font-medium">
        {{ title }} · {{ count }}
      </h2>
      <p v-if="source === 'project' && folders && folders.length > 0" class="min-w-0 font-mono text-xs break-all text-muted-foreground">
        {{ folders.join(' · ') }}
      </p>
      <div v-if="$slots['heading-actions']" class="ml-auto flex shrink-0 items-center gap-2 self-center">
        <slot name="heading-actions" />
      </div>
    </div>
    <slot name="notices" />

    <Alert v-if="issue" role="alert" class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning">
      <FolderXIcon aria-hidden="true" />
      <AlertDescription class="text-foreground">
        {{ issue }}
      </AlertDescription>
    </Alert>

    <div
      v-else-if="emptyText"
      :data-testid="testIds.customizeEmpty"
      :data-kind="kind"
      :data-source="source"
      class="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4"
    >
      <p class="text-sm text-muted-foreground">
        {{ emptyText }}
      </p>
      <div v-if="source === 'user' && $slots['empty-actions']" class="flex flex-wrap gap-2">
        <slot name="empty-actions" />
      </div>
    </div>

    <ul v-else-if="entries.length > 0" class="flex flex-col divide-y rounded-lg border">
      <CustomizationRow
        v-for="entry in entries"
        :key="rowKey(entry)"
        :entry="entry"
        :busy="entry.id !== undefined && (busyIds ?? []).includes(entry.id)"
        @action="action => emit('action', action, entry)"
      />
    </ul>
  </section>
</template>
