<script setup lang="ts">
// One executable item of the project trust review (Phase 11, ADR-049; docs/UI.md 7.33, 10.8): an `<article>` named
// "{kind} {label}, {state}" with a checkbox (`project-trust-select`, pending items) or Revoke (`project-trust-revoke`,
// approved items), the title, the path, the state badge (New / Changed / Approved), the exact text in a `pre` named
// "Command" (`data-slot="project-trust-command"`) with Copy, the referenced files, the environment / header names, the
// variables (from the project's MCP list, `variables`) and the warnings. Store-free. Props, emits and the root test id
// are frozen from Gate P11-0b (C39 stub); W11.9 implements the item in P11-A. The stub shows the title and the state.
import type { ProjectMcpList, TrustItem } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { trustItemState, trustItemTitle, trustStateText } from './project-trust'

const props = defineProps<{
  item: TrustItem
  selected: boolean
  busy: boolean
  /** The variables of the project's MCP servers (an MCP item lists the ones it uses and whether they are set). */
  variables?: ProjectMcpList['variables']
}>()

defineEmits<{ toggle: [], revoke: [] }>()

const title = computed(() => trustItemTitle(props.item))
const stateText = computed(() => trustStateText(props.item))
</script>

<template>
  <article
    :data-testid="testIds.projectTrustItem"
    :data-kind="item.kind"
    :data-state="trustItemState(item)"
    :data-key="item.sha256"
    :aria-label="`${item.kind} ${item.label}, ${stateText}`"
    :aria-busy="busy ? 'true' : undefined"
    class="flex min-w-0 flex-col gap-1 py-2 text-sm"
  >
    <p class="flex min-w-0 items-baseline gap-2">
      <span class="min-w-0 truncate font-medium">{{ title }}</span>
      <span class="shrink-0 truncate font-mono text-xs text-muted-foreground">{{ item.path }}</span>
      <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{ stateText }}</span>
    </p>
  </article>
</template>
