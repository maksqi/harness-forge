<script setup lang="ts">
// The trust chip of the chat header (Phase 11, ADR-049; docs/UI.md 5.6, 7.33, 10.8): right after ChatProjectChip, only
// while `useProjectTrustStore().pending(projectId)` is above 0: a ghost h-8 pill (40px on coarse pointers) with
// `ShieldQuestionMark` and "{n} to review" (icon and count only below `sm`), named "Review {n} items in {project} that
// can run commands"; it opens the trust dialog through CHAT_VIEW_ACTIONS `openProjectTrust()`. Props and the root test id
// are frozen from Gate P11-0b (C39 stub); W11.9 implements the chip in P11-A (incl. the lazy fetch of the count). The
// stub reads the store's count and opens the dialog.
import { ShieldQuestionMarkIcon } from '@lucide/vue'
import { computed, inject } from 'vue'
import { Button } from '@/components/ui/button'
import { CHAT_VIEW_ACTIONS } from '~/components/chat/chat-context'
import { useProjectTrustStore } from '~/stores/project-trust'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'

const props = defineProps<{ projectId: string | null }>()

const trust = useProjectTrustStore()
const projects = useProjectsStore()
const actions = inject(CHAT_VIEW_ACTIONS, null)

const count = computed(() => trust.pending(props.projectId) ?? 0)
const projectName = computed(() => (props.projectId ? projects.byId(props.projectId)?.name ?? 'this project' : 'this project'))
</script>

<template>
  <Button
    v-if="projectId && count > 0"
    type="button"
    variant="ghost"
    size="sm"
    :data-testid="testIds.projectTrustChip"
    :data-count="count"
    :aria-label="`Review ${count} items in ${projectName} that can run commands`"
    class="h-8 gap-1.5 px-2 font-normal text-muted-foreground pointer-coarse:h-10"
    @click="actions?.openProjectTrust()"
  >
    <ShieldQuestionMarkIcon aria-hidden="true" class="size-4" />
    <span>{{ count }}<span class="max-sm:sr-only"> to review</span></span>
  </Button>
</template>
