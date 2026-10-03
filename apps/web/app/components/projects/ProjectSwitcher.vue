<script setup lang="ts">
// Project switcher (docs/UI.md 2.12, 5.3, 7.20; ADR-031): the first row of ChatNav, above New chat. Row: Folders +
// "All chats", Folder + the project name, or FolderX in text-warning when its folder is missing, then ChevronsUpDown.
// Menu: All chats · No project · the projects sorted by name (project-switcher-option, data-value) · Add project…
// (project-add; mounts its own AddProjectDialog, then the filter switches to the new project) · Manage projects
// (project-manage -> /settings/projects). A pick calls chats.setProjectFilter().
// Contract (docs/UI.md 10.4): no props, no emits; reads the projects and chats stores; root project-switcher
// (data-value = all | none | <project id>).
// Stub (C15, P7-0b): implemented by W7.9 in P7-A; the contract is frozen. The stub renders the row without its menu.
import { FoldersIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'

const chats = useChatsStore()
const projects = useProjectsStore()

const label = computed(() => {
  const filter = chats.projectFilter
  if (filter === 'all')
    return 'All chats'
  if (filter === 'none')
    return 'No project'
  return projects.byId(filter)?.name ?? 'All chats'
})
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    size="sm"
    :data-testid="testIds.projectSwitcher"
    :data-value="chats.projectFilter"
    class="w-full justify-start gap-2 font-normal pointer-coarse:h-10"
  >
    <FoldersIcon aria-hidden="true" class="size-4" />
    <span class="truncate">{{ label }}</span>
  </Button>
</template>
