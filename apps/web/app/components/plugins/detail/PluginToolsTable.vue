<script setup lang="ts">
// Tools of a plugin (docs/UI.md 2.4, 8.8): name (mono) and description, the tool's own approval policy (Safe / Ask /
// Always ask, or "Decided per call" for a policy function such as the `shell` tool's), the user's Approval override
// (Default / Allow / Ask / Deny; Default clears it) and the enabled switch. Both write tool preferences with
// `PATCH /api/tools/:name` through the plugins store (optimistic, rolled back with a toast on failure). Tools the tools
// API does not know yet are listed by name with their controls disabled.
// Phase 9 (W9.12): Allow is not offered where the server refuses it (a tool with workspace access `execute`, whose
// commands shell rules allow instead, ADR-038; core-agent's `exit_plan_mode`, whose plan card always shows, ADR-041),
// and the select shows the effective override: an `allow` stored before v1.4 on such a tool reads as Default (the
// approval ignores it; `GET /tools` reports it as null since v1.5).
import type { ToolSummary } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { ToolApproval } from './plugin-detail'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CORE_AGENT_PLUGIN_ID, PLAN_TOOL_NAME } from '~/components/chat/chat-format'
import { errorTitle } from '~/components/common/harness-error'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { isToolApproval, TOOL_APPROVAL_OPTIONS, TOOL_POLICY_HINTS, TOOL_POLICY_LABELS } from './plugin-detail'

const props = withDefaults(defineProps<{
  /** Tools of the plugin from `GET /api/tools`. */
  tools: readonly ToolSummary[]
  /** Tool names the plugin registered that the tools API did not return (shown without controls). */
  missing?: readonly string[]
}>(), {
  missing: () => [],
})

const plugins = usePluginsStore()

interface Row {
  name: string
  tool: ToolSummary | null
}

const rows = computed<Row[]>(() => [
  ...props.tools.map(tool => ({ name: tool.name, tool })),
  ...props.missing.map(name => ({ name, tool: null })),
])

const POLICY_CLASS: Record<string, string> = {
  safe: 'border-transparent bg-success/15 text-foreground dark:text-success',
  ask: 'border-border text-foreground',
  always: 'border-transparent bg-warning/15 text-foreground dark:text-warning',
  dynamic: 'border-dashed border-border text-muted-foreground',
}

/** The label of a policy function (`policy: null`): the tool decides for each call. */
const PER_CALL_LABEL = 'Decided per call'

/** The server refuses (and the approval ignores) an `allow` override for this tool. */
function refusesAllow(tool: ToolSummary): boolean {
  return tool.workspace === 'execute' || (tool.pluginId === CORE_AGENT_PLUGIN_ID && tool.name === PLAN_TOOL_NAME)
}

/** The effective override: an `allow` the approval ignores reads as Default. */
function approvalOf(tool: ToolSummary): ToolApproval {
  if (tool.override === 'allow' && refusesAllow(tool))
    return 'default'
  return tool.override ?? 'default'
}

function approvalOptions(tool: ToolSummary | null) {
  return tool && refusesAllow(tool) ? TOOL_APPROVAL_OPTIONS.filter(option => option.value !== 'allow') : TOOL_APPROVAL_OPTIONS
}

async function update(tool: ToolSummary, patch: { enabled?: boolean, override?: ToolSummary['override'] }) {
  try {
    await plugins.setToolPref(tool.name, patch)
  }
  catch (error) {
    const failure = toHarnessError(error)
    toast.error(errorTitle(failure), { description: failure.message })
  }
}

function onApproval(tool: ToolSummary, value: AcceptableValue) {
  if (!isToolApproval(value) || value === approvalOf(tool) || (value === 'allow' && refusesAllow(tool)))
    return
  void update(tool, { override: value === 'default' ? null : value })
}
</script>

<template>
  <div role="table" aria-label="Tools" class="overflow-hidden rounded-xl border bg-card">
    <div role="rowgroup" class="hidden border-b bg-muted/30 sm:block">
      <div role="row" class="grid grid-cols-[minmax(0,1fr)_8rem_8.5rem_3.5rem] items-center gap-x-4 px-4 py-2 text-xs font-medium text-muted-foreground">
        <span role="columnheader">Tool</span>
        <span role="columnheader">Policy</span>
        <span role="columnheader">Approval</span>
        <span role="columnheader" class="text-right">Enabled</span>
      </div>
    </div>
    <div role="rowgroup" class="divide-y divide-border">
      <div
        v-for="row in rows"
        :key="row.name"
        role="row"
        :data-testid="testIds.pluginToolRow"
        :data-tool-name="row.name"
        :data-enabled="row.tool?.enabled"
        class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_8rem_8.5rem_3.5rem]"
      >
        <div role="cell" :class="cn('col-span-3 min-w-0 sm:col-span-1', row.tool && !row.tool.enabled && 'opacity-60')">
          <div class="flex min-w-0 items-center gap-2">
            <code class="truncate font-mono text-[13px] font-medium">{{ row.name }}</code>
            <span v-if="row.tool?.title" class="truncate text-sm text-muted-foreground">{{ row.tool.title }}</span>
            <Badge
              v-if="row.tool && !row.tool.available"
              variant="outline"
              class="shrink-0 rounded-md px-1.5 text-muted-foreground"
              title="The plugin or its MCP server is not running."
            >
              Unavailable
            </Badge>
          </div>
          <p v-if="row.tool?.description" class="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
            {{ row.tool.description }}
          </p>
          <p v-else-if="!row.tool" class="mt-0.5 text-sm text-muted-foreground/80 italic">
            Tool settings are not available yet.
          </p>
        </div>

        <div role="cell" class="flex items-center">
          <Tooltip v-if="row.tool">
            <TooltipTrigger as-child>
              <Badge
                variant="outline"
                tabindex="0"
                :data-value="row.tool.policy ?? 'dynamic'"
                :class="cn('rounded-md px-1.5 font-medium', POLICY_CLASS[row.tool.policy ?? 'dynamic'])"
              >
                {{ row.tool.policy ? TOOL_POLICY_LABELS[row.tool.policy] : PER_CALL_LABEL }}
              </Badge>
            </TooltipTrigger>
            <TooltipContent class="max-w-xs">
              {{ TOOL_POLICY_HINTS[row.tool.policy ?? 'dynamic'] }}
            </TooltipContent>
          </Tooltip>
          <span v-else class="text-xs text-muted-foreground">—</span>
        </div>

        <div role="cell" class="flex items-center justify-end sm:justify-start">
          <Select
            :model-value="row.tool ? approvalOf(row.tool) : 'default'"
            :disabled="!row.tool"
            @update:model-value="(value: AcceptableValue) => row.tool && onApproval(row.tool, value)"
          >
            <SelectTrigger
              size="sm"
              :aria-label="`Approval for ${row.name}`"
              :data-testid="testIds.pluginToolApproval"
              :data-tool-name="row.name"
              :data-value="row.tool ? approvalOf(row.tool) : 'default'"
              class="w-32"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem v-for="option in approvalOptions(row.tool)" :key="option.value" :value="option.value" :data-value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div role="cell" class="flex items-center justify-end">
          <Switch
            size="sm"
            :model-value="row.tool?.enabled ?? true"
            :disabled="!row.tool"
            :aria-label="`Enable ${row.name}`"
            :data-testid="testIds.pluginToolEnabled"
            :data-tool-name="row.name"
            @update:model-value="(value: boolean) => row.tool && update(row.tool, { enabled: value })"
          />
        </div>
      </div>
    </div>
  </div>
</template>
