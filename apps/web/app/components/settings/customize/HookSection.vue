<script setup lang="ts">
// One source section of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 9.13, 10.8, 14.2): the heading "{title}
// · {n}" (an h2: "Personal", "In {project}" with the settings files read in mono and "Review {n}…"
// (`customize-trust-review`, `data-count`, emits `review`) while project hooks wait for approval, "From plugins"), the
// rows (HookRow, in event order, then by matcher), the empty state of a personal or project section (`hooks-empty`; the
// personal one ends with the parent's buttons through the `empty-actions` slot) or an Alert for an unavailable project
// folder (`issue`) instead of the rows. File problems come through the `notices` slot under the heading.
// Props, emits and the root test id are frozen from Gate P11-0b (C39 stub); implementation W11.8.
import type { HookEntry, HookSource } from '@harness-forge/shared'
import type { HookAction } from './hooks'
import { FolderXIcon, ShieldQuestionMarkIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'
import HookRow from './HookRow.vue'
import { HOOK_COPY, sortHookEntries } from './hooks'

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

defineSlots<{
  /** File problems under the heading (project sections). */
  'notices'?: () => any
  /** Buttons after the personal empty state (New hook, Import…). */
  'empty-actions'?: () => any
}>()

const TITLES: Readonly<Record<HookSource, string>> = { personal: 'Personal', project: 'Project', plugin: 'From plugins' }

const title = computed(() => (props.source === 'project' && props.projectName ? `In ${props.projectName}` : TITLES[props.source]))
const count = computed(() => (props.issue ? 0 : props.entries.length))
const rows = computed(() => sortHookEntries(props.entries))
const reviewCount = computed(() => (props.source === 'project' && !props.issue ? props.pending ?? 0 : 0))
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
  <section :data-testid="testIds.hooksSection" :data-source="source" :data-count="count" class="flex flex-col gap-2 py-3">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 class="text-sm font-medium">
        {{ title }} · {{ count }}
      </h2>
      <p v-if="source === 'project' && files && files.length > 0" class="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">
        {{ files.join(' · ') }}
      </p>
      <Button
        v-if="reviewCount > 0"
        type="button"
        size="sm"
        variant="outline"
        :data-testid="testIds.customizeTrustReview"
        :data-count="reviewCount"
        class="ml-auto h-7 gap-1.5 pointer-coarse:h-10"
        @click="emit('review')"
      >
        <ShieldQuestionMarkIcon aria-hidden="true" class="text-warning" />
        Review {{ reviewCount }}…
      </Button>
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
      :data-testid="testIds.hooksEmpty"
      :data-source="source"
      class="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4"
    >
      <p class="text-sm text-muted-foreground">
        {{ emptyText }}
      </p>
      <div v-if="source === 'personal' && $slots['empty-actions']" class="flex flex-wrap gap-2">
        <slot name="empty-actions" />
      </div>
    </div>

    <ul v-else-if="rows.length > 0" class="flex flex-col divide-y rounded-lg border">
      <HookRow
        v-for="entry in rows"
        :key="entry.key"
        :entry="entry"
        :busy="entry.id !== undefined && (busyIds ?? []).includes(entry.id)"
        @action="action => emit('action', action, entry)"
      />
    </ul>
  </section>
</template>
