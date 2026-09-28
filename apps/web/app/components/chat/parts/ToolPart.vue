<script setup lang="ts">
// Tool call row (docs/UI.md 7.2): `▸ icon name "first argument" [server] … status`, the whole row toggles the body
// (input / output / error, 4 KB previews) and never opens by itself. MCP tools (`mcp__<server>__<tool>`) show the tool
// name plus a server badge (the server's name; the MCP list loads on first need). While approval is requested,
// ToolApprovalCard renders below the row.
import type { ToolPartLike } from '../chat-format'
import {
  BanIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  ServerIcon,
  WrenchIcon,
  XIcon,
} from '@lucide/vue'
import { computed, inject, ref, watch } from 'vue'
import { Tool as AiTool, ToolContent as AiToolContent } from '@/components/ai-elements/tool'
import { Badge } from '@/components/ui/badge'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { TRANSCRIPT_SCROLL } from '../chat-context'
import {
  firstStringArg,
  formatToolValue,
  isServerTruncated,
  isSupersededDenial,
  splitMcpToolName,
  toolNameOf,
} from '../chat-format'
import ToolApprovalCard from './ToolApprovalCard.vue'
import ToolValueBlock from './ToolValueBlock.vue'

const props = withDefaults(defineProps<{
  part: ToolPartLike
  /** The message is streaming (spinners only spin while it does). */
  streaming: boolean
  /**
   * A later message exists: an approval still requested here was superseded (the server resolves it as denied when
   * the user sends a new message), so no card is offered.
   */
  superseded?: boolean
}>(), {
  superseded: false,
})

const emit = defineEmits<{
  approval: [response: { id: string, approved: boolean, toolName: string, alwaysAllow: boolean }]
}>()

const plugins = usePluginsStore()
const open = ref(false)
const scroll = inject(TRANSCRIPT_SCROLL, null)
watch(open, (isOpen) => {
  if (isOpen)
    scroll?.holdPosition()
})

const name = computed(() => toolNameOf(props.part))
const tool = computed(() => plugins.tools.find(item => item.name === name.value))
const mcp = computed(() => splitMcpToolName(name.value))
const serverId = computed(() => tool.value?.mcpServerId ?? mcp.value?.serverId ?? null)
const serverName = computed(() => {
  if (!serverId.value)
    return null
  return plugins.mcp.find(server => server.id === serverId.value)?.name ?? serverId.value
})
const displayName = computed(() => mcp.value?.tool ?? name.value)
// The badge names the server; a transcript opened after a reload may be the first place that needs the MCP list.
watch(serverId, (id) => {
  if (id && !plugins.mcpLoaded)
    plugins.fetchMcp().catch(() => {})
}, { immediate: true })
const firstArg = computed(() => firstStringArg(props.part.input))

type RowStatus = 'running' | 'approval' | 'done' | 'error' | 'denied' | 'stopped'

const approved = computed(() => {
  const approval = props.part.approval
  return approval && 'approved' in approval ? approval.approved : undefined
})

const status = computed<RowStatus>(() => {
  switch (props.part.state) {
    case 'input-streaming':
    case 'input-available':
      return props.streaming ? 'running' : 'stopped'
    case 'approval-requested':
      return props.superseded ? 'denied' : 'approval'
    case 'approval-responded':
      if (approved.value === false)
        return 'denied'
      return props.streaming ? 'running' : 'stopped'
    case 'output-available':
      return 'done'
    case 'output-error':
      return 'error'
    case 'output-denied':
      return 'denied'
    default:
      return 'running'
  }
})

const awaitingDecision = computed(() => props.part.state === 'approval-requested' && !props.superseded)
const supersededDenial = computed(() => status.value === 'denied'
  && (isSupersededDenial(props.part) || props.part.state === 'approval-requested'))
const statusLabel = computed(() => ({
  running: 'Running',
  approval: 'Needs approval',
  done: 'Done',
  error: 'Failed',
  denied: 'Denied',
  stopped: 'Stopped',
})[status.value])

const inputText = computed(() => formatToolValue(props.part.input))
const hasOutput = computed(() => props.part.state === 'output-available')
const outputText = computed(() => (hasOutput.value ? formatToolValue(props.part.output) : ''))
const outputTruncated = computed(() => hasOutput.value && isServerTruncated(props.part.output))
const errorText = computed(() => (props.part.state === 'output-error' ? props.part.errorText : ''))

function onDecide(decision: { approved: boolean, alwaysAllow: boolean }) {
  const approval = props.part.approval
  if (!approval)
    return
  emit('approval', { id: approval.id, approved: decision.approved, toolName: name.value, alwaysAllow: decision.alwaysAllow })
}
</script>

<template>
  <div data-slot="tool-part" class="flex flex-col gap-1.5">
    <AiTool v-model:open="open" class="mb-0 rounded-md border-0">
      <div
        :data-testid="testIds.toolRow"
        :data-tool-name="name"
        :data-state="part.state"
        :data-status="status"
      >
        <CollapsibleTrigger
          class="group/tool-row -mx-1.5 flex h-(--row-height) pointer-coarse:h-10 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRightIcon
            aria-hidden="true"
            class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) group-data-[state=open]/tool-row:rotate-90"
          />
          <ServerIcon v-if="serverId" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <WrenchIcon v-else aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="shrink-0 font-mono text-[13px] font-medium">{{ displayName }}</span>
          <span v-if="firstArg" class="min-w-0 truncate font-mono text-xs text-muted-foreground">"{{ firstArg }}"</span>
          <Badge v-if="serverName" variant="outline" class="h-4 shrink-0 px-1.5 text-[10px] font-normal text-muted-foreground">
            {{ serverName }}
          </Badge>
          <span class="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
            <Spinner v-if="status === 'running'" class="size-3" />
            <template v-else-if="status === 'approval'">
              <span aria-hidden="true" class="size-2 rounded-full bg-warning" />
              <span>Needs approval</span>
            </template>
            <CheckIcon v-else-if="status === 'done'" aria-hidden="true" class="size-3.5 text-success" />
            <XIcon v-else-if="status === 'error'" aria-hidden="true" class="size-3.5 text-destructive" />
            <template v-else-if="status === 'denied'">
              <Tooltip v-if="supersededDenial">
                <TooltipTrigger as-child>
                  <span class="inline-flex items-center gap-1.5">
                    <BanIcon aria-hidden="true" class="size-3.5" />
                    <span>Denied</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Skipped because you sent a new message</TooltipContent>
              </Tooltip>
              <template v-else>
                <BanIcon aria-hidden="true" class="size-3.5" />
                <span>Denied</span>
              </template>
            </template>
            <template v-else-if="status === 'stopped'">
              <CircleSlashIcon aria-hidden="true" class="size-3.5" />
              <span>Stopped</span>
            </template>
            <span v-if="status === 'running' || status === 'done' || status === 'error'" class="sr-only">{{ statusLabel }}</span>
          </span>
        </CollapsibleTrigger>
      </div>
      <AiToolContent :data-testid="testIds.toolRowOutput" class="pt-1 pl-6">
        <div class="flex flex-col gap-3 rounded-md bg-muted/50 p-3">
          <ToolValueBlock label="Input" :value="inputText || '{}'" />
          <ToolValueBlock v-if="hasOutput" label="Output" :value="outputText" :server-truncated="outputTruncated" />
          <ToolValueBlock v-if="errorText" label="Error" :value="errorText" tone="error" />
        </div>
      </AiToolContent>
    </AiTool>
    <ToolApprovalCard
      v-if="awaitingDecision"
      :part="part"
      :tool-name="name"
      :source="tool?.pluginId ?? null"
      @decide="onDecide"
    />
  </div>
</template>
