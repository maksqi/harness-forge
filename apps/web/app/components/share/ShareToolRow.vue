<script setup lang="ts">
// One tool call of a shared chat (docs/UI.md 7.2, 7.15): the one-line row of the transcript without approvals —
// Wrench (Server and a server badge for `mcp__<server>__<tool>`), the tool name, the first argument when the share
// includes tool details (the prompt for generate_image), and the outcome (done, error, denied, stopped). With tool
// details the row is a button that expands Input / Output (ToolValueBlock) and the error text; without them it is
// static. Store-free.
// Contract (docs/UI.md 10.4): `part` is the snapshot's tool part (toolName, status, input?, output?, errorText?).
import type { ShareToolPart } from './share-view'
import { BanIcon, CheckIcon, ChevronRightIcon, CircleSlashIcon, ServerIcon, WrenchIcon, XIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { formatToolValue, isServerTruncated, splitMcpToolName } from '~/components/chat/chat-format'
import { toolRowArgument } from '~/components/chat/parts/tool-row'
import ToolValueBlock from '~/components/chat/parts/ToolValueBlock.vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{ part: ShareToolPart }>()

const open = ref(false)

const mcp = computed(() => splitMcpToolName(props.part.toolName))
const displayName = computed(() => mcp.value?.tool ?? props.part.toolName)
const hasInput = computed(() => props.part.input !== undefined)
const hasOutput = computed(() => props.part.output !== undefined)
/** Tool details are shared: the server sends inputs, outputs and errors only with `options.toolDetails`. */
const expandable = computed(() => hasInput.value || hasOutput.value || !!props.part.errorText)
const firstArg = computed(() => (hasInput.value ? toolRowArgument(props.part.toolName, props.part.input) : null))
const inputText = computed(() => formatToolValue(props.part.input))
const outputText = computed(() => formatToolValue(props.part.output))
// A value over the share limit arrives as its JSON text, cut and marked "[truncated]" (ADR-025).
const inputTruncated = computed(() => hasInput.value && isServerTruncated(props.part.input))
const outputTruncated = computed(() => hasOutput.value && isServerTruncated(props.part.output))
const statusLabel = computed(() => ({ done: 'Done', error: 'Failed', denied: 'Denied', stopped: 'Stopped' })[props.part.status])

const ROW_CLASS = '-mx-1.5 flex h-(--row-height) w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm pointer-coarse:h-10'
</script>

<template>
  <Collapsible
    v-model:open="open"
    :data-testid="testIds.shareToolRow"
    :data-tool-name="part.toolName"
    :data-status="part.status"
    class="flex min-w-0 flex-col"
  >
    <component
      :is="expandable ? CollapsibleTrigger : 'div'"
      :class="cn(
        ROW_CLASS,
        expandable && 'group/tool-row outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
      )"
    >
      <ChevronRightIcon
        v-if="expandable"
        aria-hidden="true"
        class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) group-data-[state=open]/tool-row:rotate-90"
      />
      <ServerIcon v-if="mcp" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
      <WrenchIcon v-else aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="shrink-0 font-mono text-[13px] font-medium">{{ displayName }}</span>
      <span v-if="firstArg" class="min-w-0 truncate font-mono text-xs text-muted-foreground">"{{ firstArg }}"</span>
      <Badge v-if="mcp" variant="outline" class="h-4 shrink-0 px-1.5 text-[10px] font-normal text-muted-foreground">
        {{ mcp.serverId }}
      </Badge>
      <span class="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
        <CheckIcon v-if="part.status === 'done'" aria-hidden="true" class="size-3.5 text-success" />
        <XIcon v-else-if="part.status === 'error'" aria-hidden="true" class="size-3.5 text-destructive" />
        <template v-else-if="part.status === 'denied'">
          <BanIcon aria-hidden="true" class="size-3.5" />
          <span>Denied</span>
        </template>
        <template v-else>
          <CircleSlashIcon aria-hidden="true" class="size-3.5" />
          <span>Stopped</span>
        </template>
        <span v-if="part.status === 'done' || part.status === 'error'" class="sr-only">{{ statusLabel }}</span>
      </span>
    </component>
    <CollapsibleContent
      v-if="expandable"
      :data-testid="testIds.shareToolRowOutput"
      class="overflow-hidden pt-1 pl-6 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0"
    >
      <div class="flex flex-col gap-3 rounded-md bg-muted/50 p-3">
        <ToolValueBlock v-if="hasInput" label="Input" :value="inputText || '{}'" :server-truncated="inputTruncated" />
        <ToolValueBlock v-if="hasOutput" label="Output" :value="outputText" :server-truncated="outputTruncated" />
        <ToolValueBlock v-if="part.errorText" label="Error" :value="part.errorText" tone="error" />
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
