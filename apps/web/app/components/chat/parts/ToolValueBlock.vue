<script setup lang="ts">
// One labelled block of a tool row body (docs/UI.md 7.2): pre-wrapped text capped at 4 KB with "Show all" (up to
// 64 KB), a "Truncated by server" note when the server capped the output, and a copy button for the full value.
import { computed, ref } from 'vue'
import { cn } from '@/lib/utils'
import CopyButton from '~/components/common/CopyButton.vue'
import { capText, TOOL_BODY_MAX_CHARS, TOOL_BODY_PREVIEW_CHARS } from '../chat-format'

const props = withDefaults(defineProps<{
  label: string
  value: string
  serverTruncated?: boolean
  tone?: 'default' | 'error'
}>(), {
  serverTruncated: false,
  tone: 'default',
})

const expanded = ref(false)
const shown = computed(() => capText(props.value, expanded.value ? TOOL_BODY_MAX_CHARS : TOOL_BODY_PREVIEW_CHARS))
const canExpand = computed(() => !expanded.value && props.value.length > TOOL_BODY_PREVIEW_CHARS)
const copyLabel = computed(() => `Copy ${props.label.toLowerCase()}`)
</script>

<template>
  <section data-slot="tool-value" :data-label="label.toLowerCase()" class="min-w-0">
    <div class="mb-1 flex h-6 items-center justify-between gap-2">
      <h4 class="font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {{ label }}
      </h4>
      <CopyButton :text="() => value" :label="copyLabel" />
    </div>
    <pre
      :class="cn(
        'max-h-80 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words',
        tone === 'error' ? 'text-destructive' : 'text-foreground',
      )"
    >{{ shown.text }}</pre>
    <p
      v-if="shown.truncated || serverTruncated"
      class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[11px] text-muted-foreground"
    >
      <span v-if="shown.truncated">Showing the first {{ Math.round(shown.text.length / 1024) }} KB</span>
      <button
        v-if="canExpand"
        type="button"
        data-action="show-all"
        class="rounded-sm font-medium text-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50"
        @click="expanded = true"
      >
        Show all
      </button>
      <span v-if="serverTruncated" data-slot="server-truncated">Truncated by server</span>
    </p>
  </section>
</template>
