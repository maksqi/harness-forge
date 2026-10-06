<script setup lang="ts">
// One source section of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 9.13, 10.8): the heading "{title} · {n}"
// ("Personal", "In {project}" with the settings files read and "Review {n}…" (`customize-trust-review`, `review`) while
// project hooks wait for approval, "From plugins"), the rows (HookRow, sorted in event order), the empty state of a
// personal or project section (`hooks-empty`) or an Alert for an unavailable project folder (`issue`). Props, emits and
// the root test id are frozen from Gate P11-0b (C39 stub); W11.8 implements the section in P11-A.
import type { HookEntry, HookSource } from '@harness-forge/shared'
import type { HookAction } from './hooks'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import HookRow from './HookRow.vue'
import { HOOK_COPY } from './hooks'

const props = defineProps<{
  source: HookSource
  entries: readonly HookEntry[]
  /** "In {project}" (source project). */
  projectName?: string | null
  /** The settings files of the project rows, shown in the heading. */
  files?: readonly string[]
  /** The project's pending trust items ("Review {n}…"). */
  pending?: number | null
  /** An unavailable project folder: an Alert instead of the rows. */
  issue?: string | null
  /** Personal rows with a toggle / delete in flight. */
  busyIds?: readonly string[]
}>()

const emit = defineEmits<{ action: [action: HookAction, entry: HookEntry], review: [] }>()

const TITLES: Readonly<Record<HookSource, string>> = { personal: 'Personal', project: 'Project', plugin: 'From plugins' }

const title = computed(() => (props.source === 'project' && props.projectName ? `In ${props.projectName}` : TITLES[props.source]))
const emptyText = computed(() => {
  if (props.entries.length > 0 || props.issue)
    return null
  if (props.source === 'personal')
    return HOOK_COPY.personalEmpty!
  if (props.source === 'project')
    return `No hooks in ${props.projectName ?? 'this project'}. Add a "hooks" object to .harness/settings.json (or .claude/settings.json) in the project folder.`
  return null
})
</script>

<template>
  <section :data-testid="testIds.hooksSection" :data-source="source" :data-count="entries.length" class="flex flex-col gap-1 py-3">
    <h3 class="text-sm font-medium">
      {{ title }} · {{ entries.length }}
    </h3>
    <p v-if="issue" role="alert" class="text-sm text-muted-foreground">
      {{ issue }}
    </p>
    <p v-else-if="emptyText" :data-testid="testIds.hooksEmpty" :data-source="source" class="text-sm text-muted-foreground">
      {{ emptyText }}
    </p>
    <HookRow
      v-for="entry in entries"
      :key="entry.key"
      :entry="entry"
      :busy="entry.id !== undefined && (busyIds ?? []).includes(entry.id)"
      @action="action => emit('action', action, entry)"
    />
  </section>
</template>
