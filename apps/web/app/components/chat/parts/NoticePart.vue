<script setup lang="ts">
// `data-notice` part (docs/API.md 6.4): one muted line, e.g. "Older messages were left out to fit the context window".
// The icon names what happened (trimmed context, superseded approvals, a model without tools or without support for
// the attached files); the level colors it. Unknown codes fall back to the level icon.
import type { NoticeCode, NoticeData } from '@harness-forge/shared'
import type { Component } from 'vue'
import { BanIcon, FoldVerticalIcon, InfoIcon, PaperclipIcon, TriangleAlertIcon, WrenchIcon } from '@lucide/vue'
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{ notice: NoticeData }>()

const CODE_ICONS: Record<NoticeCode, Component> = {
  'context-trimmed': FoldVerticalIcon,
  'approvals-superseded': BanIcon,
  'tools-unsupported': WrenchIcon,
  'attachments-unsupported': PaperclipIcon,
}

const icon = computed<Component>(() => (CODE_ICONS as Partial<Record<string, Component>>)[props.notice.code]
  ?? (props.notice.level === 'warning' ? TriangleAlertIcon : InfoIcon))
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
  </p>
</template>
