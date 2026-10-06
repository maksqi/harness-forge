<script setup lang="ts">
// The Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 2.18, 9.13, 10.8): the "Run hooks" switch (`hooks-enabled`, the
// setting `hooksEnabled`), the server-switch alert (`hooks-disabled`, `data-reason` safe-mode | shell-off), a HookSection
// per source (Personal · In {project} with "Review {n}…" -> ProjectTrustDialog · From plugins) from
// `useHooksStore().fetch(projectId)`, the row actions, the HookEditor and the HookImportDialog. CustomizeSettings
// renders it for `?tab=hooks`; the page header's New hook / Import… reach it through the exposed `create()` /
// `import()`. Props, exposes and the root test id are frozen from Gate P11-0b (C39 stub); W11.8 implements the tab in
// P11-A. The stub renders the sections of a cached listing (it fetches nothing) and opens the editor and the import.
import { HOOK_SOURCES } from '@harness-forge/shared'
import { computed, ref } from 'vue'
import { useHooksStore } from '~/stores/hooks'
import { testIds } from '~/utils/testids'
import HookEditor from './HookEditor.vue'
import HookImportDialog from './HookImportDialog.vue'
import HookSection from './HookSection.vue'

const props = defineProps<{ projectId: string | null, projectName: string | null }>()

const hooks = useHooksStore()

const list = computed(() => hooks.list(props.projectId))
const sections = computed(() => HOOK_SOURCES
  .filter(source => source !== 'project' || props.projectId !== null)
  .map(source => ({ source, entries: (list.value?.items ?? []).filter(entry => entry.source === source) }))
  .filter(section => section.source !== 'plugin' || section.entries.length > 0))

const editorOpen = ref(false)
const importOpen = ref(false)

function create(): void {
  editorOpen.value = true
}

function importHooks(): void {
  importOpen.value = true
}

defineExpose<{ create: () => void, import: () => void }>({ create, import: importHooks })
</script>

<template>
  <div :data-testid="testIds.hooksPanel" class="flex min-w-0 flex-col">
    <HookSection
      v-for="section in sections"
      :key="section.source"
      :source="section.source"
      :entries="section.entries"
      :project-name="projectName"
      :files="section.source === 'project' ? list?.project?.files : undefined"
      :pending="section.source === 'project' ? list?.project?.pending ?? null : null"
      :issue="section.source === 'project' ? list?.project?.issue ?? null : null"
    />
    <HookEditor v-model:open="editorOpen" mode="new" :hook="null" />
    <HookImportDialog v-model:open="importOpen" />
  </div>
</template>
