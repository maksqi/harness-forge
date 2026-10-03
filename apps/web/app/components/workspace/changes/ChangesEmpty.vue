<script setup lang="ts">
// The empty and unavailable states of the changes panel (docs/UI.md 7.21, the states table): "No file changes in this
// chat yet." (none), "No changes since the last commit." (clean), "This project isn't a Git repository."
// (not-a-repo), "Git isn't installed on the server." (git-missing), the refused / timeout / failed texts, and FolderX +
// "The project folder wasn't found." (folder-unavailable).
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props below, no emits; root changes-empty (data-reason).
// Stub (C20, P8-0b): the texts without the icon and the styling of W8.8.
import type { ChangesEmptyReason } from './changes-rows'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{ reason: ChangesEmptyReason }>()

const TEXT: Record<ChangesEmptyReason, string> = {
  'none': 'No file changes in this chat yet.',
  'clean': 'No changes since the last commit.',
  'no-project': 'This chat has no project.',
  'folder-unavailable': 'The project folder wasn\'t found.',
  'git-missing': 'Git isn\'t installed on the server.',
  'not-a-repo': 'This project isn\'t a Git repository.',
  'refused': 'Git refused to read this repository. It may belong to another user (see the projects guide).',
  'timeout': 'Git took too long to answer.',
  'failed': 'Git couldn\'t read this repository.',
}

const text = computed(() => TEXT[props.reason])
</script>

<template>
  <p :data-testid="testIds.changesEmpty" :data-reason="reason" class="px-4 py-6 text-center text-sm text-muted-foreground">
    {{ text }}
  </p>
</template>
