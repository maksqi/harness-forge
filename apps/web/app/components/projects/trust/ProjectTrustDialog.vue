<script setup lang="ts">
// The project trust review (Phase 11, ADR-049; docs/UI.md 2.18, 7.33, 10.8): a form dialog "Review {project}" with the
// intro, the warning (`project-trust-warning`), the filter Needs review · {n} / All · {n} (`project-trust-filter`), the
// groups Hooks · MCP servers · Commands with shell lines (`project-trust-group`, "Select all {n}"), one
// ProjectTrustItem per item (the exact command, the referenced files, the environment / header / variable names, the
// warnings, the state), "Approve {n} items" with fresh auth (never the default button; Enter never approves), Revoke,
// the stale alert and the empty state. Data from `useProjectTrustStore()`. Mounted by ChatView, Settings -> Projects
// and the Customize Hooks tab; `focusKey` = the sha256 of the item to open on. Props, emits and the root test id are
// frozen from Gate P11-0b (C39 stub); W11.9 implements the dialog in P11-A. The stub shows the title and the intro, and
// closes.
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'

const props = defineProps<{ open: boolean, projectId: string | null, focusKey?: string | null }>()

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const projects = useProjectsStore()
const projectName = computed(() => (props.projectId ? projects.byId(props.projectId)?.name ?? null : null))
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent :data-testid="testIds.projectTrustDialog" class="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Review {{ projectName ?? 'project' }}</DialogTitle>
        <DialogDescription>
          Files in this project can run commands on your server. Nothing below runs until you approve it. Any change needs
          a new approval.
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
