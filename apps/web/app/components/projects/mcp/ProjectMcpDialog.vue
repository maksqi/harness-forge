<script setup lang="ts">
// The MCP servers of a project's `.mcp.json` (Phase 11, ADR-050; docs/UI.md 2.18, 7.33, 10.8): a form dialog "MCP
// servers in {project}" with the intro, one ProjectMcpServerRow per server (status, transport, the exact command or URL,
// "Replaces your server {id} in this project's chats.", Reconnect, Review… while pending), the per-project variables
// panel (`project-mcp-variables`: write-only inputs, "Save variables" with fresh auth), the empty state and the errors.
// Data from `useProjectMcpStore()` (and the trust items from `useProjectTrustStore()`). Mounted like
// ProjectTrustDialog; `focusServerId` = the server to open on. Props, emits and the root test id are frozen from Gate
// P11-0b (C39 stub); W11.9 implements the dialog in P11-A. The stub shows the title and the intro, and closes.
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'

const props = defineProps<{ open: boolean, projectId: string | null, focusServerId?: string | null }>()

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const projects = useProjectsStore()
const projectName = computed(() => (props.projectId ? projects.byId(props.projectId)?.name ?? null : null))
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent :data-testid="testIds.projectMcpDialog" class="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>MCP servers in {{ projectName ?? 'this project' }}</DialogTitle>
        <DialogDescription>
          From .mcp.json in the project folder. They run only in this project's chats, after you approve them.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" @click="emit('update:open', false)">
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
