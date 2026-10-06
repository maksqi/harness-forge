<script setup lang="ts">
// The scope bar of the Customize Output styles tab (Phase 11, ADR-051; docs/UI.md 9.13, 10.8): without a project "Your
// default" with a select of the active styles (writes the setting `outputStyle` through the settings store); with a
// project "Style in {project}" with "Same as your default" and the styles (writes `projects.update(id, { outputStyle })`,
// null for Same as your default) and the line "Your default: {name}". Props and the root test id are frozen from Gate
// P11-0b (C39 stub); W11.8 implements the bar in P11-A. The stub shows the label and the current value.
import type { OutputStyleOption } from '~/components/chat/composer/output-style'
import { computed } from 'vue'
import { useProjectsStore } from '~/stores/projects'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'

const props = defineProps<{ projectId: string | null, projectName: string | null, options: readonly OutputStyleOption[] }>()

const settings = useSettingsStore()
const projects = useProjectsStore()

/** The chosen name: the project's style ('' = Same as your default), else the global setting. */
const value = computed(() => (props.projectId
  ? projects.byId(props.projectId)?.outputStyle ?? ''
  : settings.resolved.outputStyle))
const label = computed(() => (props.projectId ? `Style in ${props.projectName ?? 'this project'}` : 'Your default'))
const shown = computed(() => (value.value === '' ? 'Same as your default' : props.options.find(option => option.name === value.value)?.label ?? value.value))
</script>

<template>
  <div class="flex min-w-0 items-center gap-2 text-sm">
    <span class="shrink-0 text-muted-foreground">{{ label }}</span>
    <span :data-testid="testIds.customizeStyleDefault" :data-value="value" class="min-w-0 truncate">{{ shown }}</span>
  </div>
</template>
