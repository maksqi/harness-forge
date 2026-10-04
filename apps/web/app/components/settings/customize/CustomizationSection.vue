<script setup lang="ts">
// One source section of one kind on the Customize page (docs/UI.md 9.12, 10.7): the heading "{title} · {n}" (the
// scanned folders for a project), the rows, the empty state of a personal or project section, or an Alert for an
// unavailable project folder. Built-in command rows come in as entries with source 'builtin' (no menu). Props, emits
// and the root test id are frozen from Gate P10-0b (C33 stub); W10.8 implements the section in P10-A.
import type { CustomizationEntry, CustomizationKind, CustomizationSource } from '@harness-forge/shared'
import type { CustomizationAction } from './customize'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import CustomizationRow from './CustomizationRow.vue'

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

const TITLES: Readonly<Record<CustomizationSource, string>> = {
  user: 'Personal',
  project: 'Project',
  plugin: 'From plugins',
  builtin: 'Built-in',
}

const PERSONAL_EMPTY: Readonly<Record<CustomizationKind, string>> = {
  agent: 'No personal agents yet. An agent is a sub-agent with its own instructions and tools that the main agent can start.',
  command: 'No personal commands yet. A command is a saved prompt you run with /name.',
  skill: 'No personal skills yet. A skill is a set of instructions the agent loads when a task needs it.',
}

const PROJECT_EMPTY: Readonly<Record<CustomizationKind, (project: string) => string>> = {
  agent: project => `No agents in ${project}. Add Markdown files to .harness/agents/ (or .claude/agents/) in the project folder.`,
  command: project => `No commands in ${project}. Add Markdown files to .harness/commands/ (or .claude/commands/) in the project folder.`,
  skill: project => `No skills in ${project}. Add a folder with a SKILL.md to .harness/skills/ (or .claude/skills/) in the project folder.`,
}

const title = computed(() => (props.source === 'project' && props.projectName ? `In ${props.projectName}` : TITLES[props.source]))
const emptyText = computed(() => {
  if (props.entries.length > 0 || props.issue)
    return null
  if (props.source === 'user')
    return PERSONAL_EMPTY[props.kind]
  if (props.source === 'project')
    return PROJECT_EMPTY[props.kind](props.projectName ?? 'this project')
  return null
})
</script>

<template>
  <section :data-testid="testIds.customizeSection" :data-source="source" :data-count="entries.length" class="flex flex-col gap-1 py-3">
    <h3 class="text-sm font-medium">
      {{ title }} · {{ entries.length }}
    </h3>
    <p v-if="issue" role="alert" class="text-sm text-muted-foreground">
      {{ issue }}
    </p>
    <p v-else-if="emptyText" :data-testid="testIds.customizeEmpty" :data-kind="kind" :data-source="source" class="text-sm text-muted-foreground">
      {{ emptyText }}
    </p>
    <CustomizationRow
      v-for="entry in entries"
      :key="`${entry.source}:${entry.id ?? entry.path ?? entry.pluginId ?? ''}:${entry.name}`"
      :entry="entry"
      :busy="entry.id !== undefined && (busyIds ?? []).includes(entry.id)"
      @action="action => emit('action', action, entry)"
    />
  </section>
</template>
