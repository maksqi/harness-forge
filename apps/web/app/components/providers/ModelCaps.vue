<script setup lang="ts">
// Capability icons of a model (docs/UI.md 7.9): Eye (vision), Wrench (tools), Brain (reasoning), FileText (PDF),
// then the context window ("200K", "1M"). Each icon has a tooltip and visually hidden text.
import type { Component } from 'vue'
import { BrainIcon, EyeIcon, FileTextIcon, WrenchIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatTokenCount } from '../common/format'

/** `ModelCapabilities` of docs/API.md 4.5 (all optional, unknown = false). */
interface ModelCapabilitiesLike {
  tools?: boolean
  vision?: boolean
  pdf?: boolean
  reasoning?: boolean
  structuredOutput?: boolean
}

const props = withDefaults(defineProps<{
  capabilities?: ModelCapabilitiesLike
  contextWindow?: number
  size?: 'sm' | 'md'
}>(), {
  capabilities: undefined,
  contextWindow: undefined,
  size: 'sm',
})

interface CapabilityItem {
  key: string
  label: string
  icon: Component
}

const items = computed<CapabilityItem[]>(() => {
  const caps = props.capabilities ?? {}
  const list: CapabilityItem[] = []
  if (caps.vision)
    list.push({ key: 'vision', label: 'Vision', icon: EyeIcon })
  if (caps.tools)
    list.push({ key: 'tools', label: 'Tools', icon: WrenchIcon })
  if (caps.reasoning)
    list.push({ key: 'reasoning', label: 'Reasoning', icon: BrainIcon })
  if (caps.pdf)
    list.push({ key: 'pdf', label: 'PDF input', icon: FileTextIcon })
  return list
})

const context = computed(() => (props.contextWindow ? formatTokenCount(props.contextWindow) : ''))
const iconClass = computed(() => (props.size === 'md' ? 'size-3.5' : 'size-3'))
</script>

<template>
  <span
    v-if="items.length || context"
    data-slot="model-caps"
    :class="cn('inline-flex items-center text-muted-foreground', size === 'md' ? 'gap-2' : 'gap-1.5')"
  >
    <Tooltip v-for="item in items" :key="item.key">
      <TooltipTrigger as-child>
        <span class="inline-flex items-center" :data-value="item.key">
          <component :is="item.icon" aria-hidden="true" :class="iconClass" />
          <span class="sr-only">{{ item.label }}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{{ item.label }}</TooltipContent>
    </Tooltip>
    <span v-if="context" class="text-xs tabular-nums">
      {{ context }}<span class="sr-only"> context</span>
    </span>
  </span>
</template>
