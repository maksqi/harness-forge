<script setup lang="ts">
// The trust chip of the chat header (Phase 11, ADR-049; docs/UI.md 5.6, 7.33, 10.8, 14): right after ChatProjectChip,
// only while `useProjectTrustStore().pending(projectId)` is above 0: a ghost h-8 pill (40px on coarse pointers) with
// `ShieldQuestionMark` and "{n} to review" (icon and count only below `sm`), named "Review {n} items in {project} that
// can run commands"; it opens the trust dialog through CHAT_VIEW_ACTIONS `openProjectTrust()` (the dialog returns focus
// here when it closes). The chip fetches the project's trust list lazily when a chat of the project opens (a cached list
// younger than a minute is reused; a failure keeps the chip hidden, quietly); `project-trust.changed` keeps the count
// current through the store. Props and the root test id are frozen from Gate P11-0b (C39); W11.9.
import { ShieldQuestionMarkIcon } from '@lucide/vue'
import { computed, inject, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { CHAT_VIEW_ACTIONS } from '~/components/chat/chat-context'
import { useProjectTrustStore } from '~/stores/project-trust'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'

const props = defineProps<{ projectId: string | null }>()

/** A trust list fetched this recently (by the chip of another chat, the dialog, Settings) is reused. */
const TRUST_MAX_AGE_MS = 60_000

const trust = useProjectTrustStore()
const projects = useProjectsStore()
const actions = inject(CHAT_VIEW_ACTIONS, null)

const count = computed(() => trust.pending(props.projectId) ?? 0)
const projectName = computed(() => (props.projectId ? projects.byId(props.projectId)?.name ?? 'this project' : 'this project'))
const label = computed(() => `Review ${count.value} ${count.value === 1 ? 'item' : 'items'} in ${projectName.value} that can run commands`)

watch(() => props.projectId, (projectId) => {
  if (projectId)
    void trust.fetch(projectId, { maxAgeMs: TRUST_MAX_AGE_MS }).catch(() => {})
}, { immediate: true })
</script>

<template>
  <Button
    v-if="projectId && count > 0"
    type="button"
    variant="ghost"
    size="sm"
    :data-testid="testIds.projectTrustChip"
    :data-count="count"
    :aria-label="label"
    class="h-8 shrink-0 gap-1.5 px-2 font-normal text-muted-foreground pointer-coarse:h-10 pointer-coarse:min-w-10"
    @click="actions?.openProjectTrust()"
  >
    <ShieldQuestionMarkIcon aria-hidden="true" class="size-4 text-warning" />
    <span class="tabular-nums">{{ count }}<span class="max-sm:sr-only"> to review</span></span>
  </Button>
</template>
