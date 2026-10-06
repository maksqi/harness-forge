<script setup lang="ts">
// One executable item of the project trust review (Phase 11, ADR-049; docs/UI.md 2.18, 7.33, 10.8, 14): an `<article>`
// named "{kind} {label}, {state}" with a checkbox (`project-trust-select`, pending items; its visible label is the
// title) or Revoke (`project-trust-revoke`, approved items), the title (hooks "{event} · {matcher}", MCP servers the
// name and the transport badge, commands "/{name}"), the path (mono, muted), the state badge (New `ShieldQuestionMark` /
// Changed `ShieldAlert` with "Changed since you approved it." / Approved `ShieldCheck`), the exact text in a `pre` named
// "Command" (`data-slot="project-trust-command"`; long lines scroll sideways inside it) with "Copy command", the details
// (timeout, referenced files, environment / header names, the variables with their state from the project's MCP list,
// `variables`) and the warnings. Never shows a value of an environment variable, a header or a variable. Store-free.
// Props, emits and the root test id are frozen from Gate P11-0b (C39); W11.9.
import type { ProjectMcpList, TrustItem } from '@harness-forge/shared'
import { ShieldAlertIcon, ShieldCheckIcon, ShieldQuestionMarkIcon } from '@lucide/vue'
import { computed, useId } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import CopyButton from '~/components/common/CopyButton.vue'
import McpTransportBadge from '~/components/plugins/mcp/McpTransportBadge.vue'
import { testIds } from '~/utils/testids'
import {
  trustCommandText,
  trustItemDetails,
  trustItemName,
  trustItemState,
  trustItemTitle,
  trustStateText,
  trustWarningText,
} from './project-trust'

const props = defineProps<{
  item: TrustItem
  selected: boolean
  busy: boolean
  /** The variables of the project's MCP servers (an MCP item lists the ones it uses and whether they are set). */
  variables?: ProjectMcpList['variables']
}>()

const emit = defineEmits<{ toggle: [], revoke: [] }>()

const ids = { select: useId(), title: useId() }

const state = computed(() => trustItemState(props.item))
const title = computed(() => trustItemTitle(props.item))
const stateText = computed(() => trustStateText(props.item))
const command = computed(() => trustCommandText(props.item))
const details = computed(() => trustItemDetails(props.item, props.variables))
const transport = computed(() => (props.item.kind === 'mcp' ? props.item.detail.transport : null))

function onChecked(value: boolean | 'indeterminate'): void {
  if ((value === true) !== props.selected)
    emit('toggle')
}
</script>

<template>
  <article
    :data-testid="testIds.projectTrustItem"
    :data-kind="item.kind"
    :data-state="state"
    :data-key="item.sha256"
    :aria-label="trustItemName(item)"
    :aria-busy="busy ? 'true' : undefined"
    class="flex min-w-0 gap-3 py-3 text-sm"
  >
    <div class="flex h-5 w-4 shrink-0 items-center">
      <Checkbox
        v-if="state !== 'approved'"
        :id="ids.select"
        :model-value="selected"
        :disabled="busy"
        :data-testid="testIds.projectTrustSelect"
        class="pointer-coarse:after:-inset-[13px]"
        @update:model-value="onChecked"
      />
      <ShieldCheckIcon v-else aria-hidden="true" class="size-4 text-muted-foreground" />
    </div>

    <div class="grid min-w-0 flex-1 gap-1.5">
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <label
          v-if="state !== 'approved'"
          :id="ids.title"
          :for="ids.select"
          class="min-w-0 font-medium break-words select-none"
        >{{ title }}</label>
        <span v-else :id="ids.title" class="min-w-0 font-medium break-words">{{ title }}</span>
        <McpTransportBadge v-if="transport" :type="transport" />
        <span class="min-w-0 truncate font-mono text-xs text-muted-foreground" :title="item.path">{{ item.path }}</span>
        <Badge
          variant="outline"
          data-slot="project-trust-state"
          :data-value="state"
          :class="state === 'changed' ? 'border-warning/40 text-warning' : 'text-muted-foreground'"
          class="font-normal"
        >
          <ShieldQuestionMarkIcon v-if="state === 'new'" aria-hidden="true" />
          <ShieldAlertIcon v-else-if="state === 'changed'" aria-hidden="true" />
          <ShieldCheckIcon v-else aria-hidden="true" />
          {{ stateText }}
        </Badge>
        <Button
          v-if="state === 'approved'"
          type="button"
          variant="outline"
          size="xs"
          :disabled="busy"
          :aria-label="`Revoke ${title}`"
          :data-testid="testIds.projectTrustRevoke"
          class="ml-auto pointer-coarse:h-10 pointer-coarse:px-3"
          @click="emit('revoke')"
        >
          Revoke
        </Button>
      </div>

      <p v-if="state === 'changed'" class="flex items-center gap-1.5 text-xs text-warning">
        <ShieldAlertIcon aria-hidden="true" class="size-3.5 shrink-0" />
        Changed since you approved it.
      </p>

      <div class="min-w-0 overflow-hidden rounded-md border bg-muted/40">
        <div class="flex items-center justify-between gap-2 border-b py-0.5 pr-0.5 pl-2.5 text-xs text-muted-foreground">
          <span aria-hidden="true">Command</span>
          <CopyButton :text="command" label="Copy command" class="pointer-coarse:size-10" />
        </div>
        <pre
          data-slot="project-trust-command"
          role="group"
          aria-label="Command"
          tabindex="0"
          class="overflow-x-auto px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >{{ command }}</pre>
      </div>

      <ul v-if="details.length > 0" class="flex flex-col gap-0.5 text-xs text-muted-foreground" data-slot="project-trust-details">
        <li v-for="line in details" :key="line" class="min-w-0 break-words">
          {{ line }}
        </li>
      </ul>

      <ul v-if="item.warnings.length > 0" class="flex flex-col gap-1" data-slot="project-trust-warnings">
        <li
          v-for="warning in item.warnings"
          :key="warning"
          :data-value="warning"
          class="flex items-start gap-1.5 text-xs text-warning"
        >
          <ShieldAlertIcon aria-hidden="true" class="mt-px size-3.5 shrink-0" />
          <span class="text-foreground">{{ trustWarningText(warning) }}</span>
        </li>
      </ul>
    </div>
  </article>
</template>
