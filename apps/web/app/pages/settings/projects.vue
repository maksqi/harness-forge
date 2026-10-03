<script setup lang="ts">
// Settings -> Projects (docs/UI.md 2.13, 2.15, 9.10; ADR-031, ADR-038): folders on the server that chats can belong
// to, then the shell rules of every project (GlobalAllowlistSection, also when no project exists). Nav label "Projects"
// (5.5). The header action Add project (project-add, FolderPlus) sets `?add=1`, which ProjectsSettings turns into its
// Add project dialog (the command palette's "Add project…" links to the same URL). The shell rules load on every visit,
// like the projects (the rows count them; a failed load shows in the rule editors, with Retry).
import { FolderPlusIcon } from '@lucide/vue'
import { onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import { useRoute, useRouter } from '~/components/settings/nuxt-imports'
import ProjectsSettings from '~/components/settings/projects/ProjectsSettings.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
import GlobalAllowlistSection from '~/components/workspace/allowlist/GlobalAllowlistSection.vue'
import { useShellRulesStore } from '~/stores/shell-rules'
import { testIds } from '~/utils/testids'

const route = useRoute()
const router = useRouter()
const shellRules = useShellRulesStore()

// The editors start the first load when they mount (before this hook); this call joins it, or refreshes a list that a
// previous visit loaded.
onMounted(() => {
  shellRules.fetchAll().catch(() => {})
})

function openAdd() {
  router.replace({ query: { ...route.query, add: '1' } }).catch(() => {})
}
</script>

<template>
  <SettingsPage title="Projects" description="Folders on the server that chats can read and edit.">
    <template #actions>
      <Button type="button" size="sm" :data-testid="testIds.projectAdd" class="pointer-coarse:h-10" @click="openAdd">
        <FolderPlusIcon aria-hidden="true" data-icon="inline-start" />
        Add project
      </Button>
    </template>
    <ProjectsSettings />
    <GlobalAllowlistSection class="border-t" />
  </SettingsPage>
</template>
