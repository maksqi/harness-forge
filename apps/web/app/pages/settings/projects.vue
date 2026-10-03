<script setup lang="ts">
// Settings -> Projects (docs/UI.md 2.13, 9.10; ADR-031): folders on the server that chats can belong to. Nav label
// "Projects" (5.5). The header action Add project (project-add, FolderPlus) sets `?add=1`, which ProjectsSettings turns
// into its Add project dialog (the command palette's "Add project…" links to the same URL).
import { FolderPlusIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useRoute, useRouter } from '~/components/settings/nuxt-imports'
import ProjectsSettings from '~/components/settings/projects/ProjectsSettings.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
import { testIds } from '~/utils/testids'

const route = useRoute()
const router = useRouter()

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
  </SettingsPage>
</template>
