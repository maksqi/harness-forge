<script setup lang="ts">
// `data-notice` part (docs/API.md 6.4): one muted line, e.g. "Older messages were left out to fit the context window".
// The icon names what happened (trimmed context, superseded approvals, a model without tools or without support for
// the attached files, a generated file that was not kept, a project folder that could not be opened); the level colors
// it. Unknown codes fall back to the level icon.
// Phase 11 (W11.12; docs/UI.md 7.31 – 7.33): `output-style-unavailable` (`Feather`), `hook-continuation-limit` (`Webhook`)
// and `project-mcp-unavailable` (`ServerOff`; the texts come from the server). The last one adds "MCP servers…", which
// opens the project MCP dialog through CHAT_VIEW_ACTIONS (only inside a chat view).
import type { NoticeCode, NoticeData } from '@harness-forge/shared'
import type { Component } from 'vue'
import { BanIcon, CpuIcon, FeatherIcon, FolderXIcon, FoldVerticalIcon, ImageOffIcon, InfoIcon, PaperclipIcon, ServerOffIcon, TriangleAlertIcon, WebhookIcon, WrenchIcon } from '@lucide/vue'
import { computed, inject } from 'vue'
import { cn } from '@/lib/utils'
import { CHAT_VIEW_ACTIONS } from '../chat-context'

const props = defineProps<{ notice: NoticeData }>()

const CODE_ICONS: Record<NoticeCode, Component> = {
  'context-trimmed': FoldVerticalIcon,
  'approvals-superseded': BanIcon,
  'tools-unsupported': WrenchIcon,
  'attachments-unsupported': PaperclipIcon,
  'generated-file-dropped': ImageOffIcon,
  'workspace-unavailable': FolderXIcon,
  // Phase 9 (ADR-040): the summary failed, so the oldest turns were trimmed instead.
  'compaction-failed': FoldVerticalIcon,
  // Phase 10 (ADR-045): the model of a command file cannot run, so the chat model answered.
  'command-model-unavailable': CpuIcon,
  // Phase 11: the output style is unknown (ADR-051), Stop hooks hit their cap (ADR-048), a project MCP server was not
  // ready (ADR-050).
  'output-style-unavailable': FeatherIcon,
  'hook-continuation-limit': WebhookIcon,
  'project-mcp-unavailable': ServerOffIcon,
}

const icon = computed<Component>(() => (CODE_ICONS as Partial<Record<string, Component>>)[props.notice.code]
  ?? (props.notice.level === 'warning' ? TriangleAlertIcon : InfoIcon))

const actions = inject(CHAT_VIEW_ACTIONS, null)
/** + Phase 11: a project MCP server was not ready: "MCP servers…" opens the project's servers (inside a chat view). */
const offersMcp = computed(() => props.notice.code === 'project-mcp-unavailable' && actions !== null)
</script>

<template>
  <p
    data-slot="notice-part"
    :data-level="notice.level"
    :data-code="notice.code"
    class="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
  >
    <component
      :is="icon"
      aria-hidden="true"
      :class="cn('mt-[3px] size-3.5 shrink-0', notice.level === 'warning' && 'text-warning')"
    />
    <span class="min-w-0 break-words"><span v-if="notice.level === 'warning'" class="sr-only">Warning: </span>{{ notice.message }}</span>
    <button
      v-if="offersMcp"
      type="button"
      data-slot="notice-action"
      data-action="project-mcp"
      class="-my-0.5 shrink-0 rounded-sm px-1 font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10"
      @click="actions?.openProjectMcp()"
    >
      MCP servers…
    </button>
  </p>
</template>
