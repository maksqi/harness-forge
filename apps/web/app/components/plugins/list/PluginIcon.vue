<script setup lang="ts">
// Icon of a plugin (docs/UI.md 8.1, 8.7): the plugin's own icon through ProviderIcon (color variant, monogram
// fallback); builtins without an icon get a lucide glyph on the same muted tile instead of a monogram.
import type { IconRef } from '@harness-forge/shared'
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { BUILTIN_PLUGIN_GLYPHS } from './plugin-display'

const props = withDefaults(defineProps<{
  plugin: { id: string, name: string, icon: IconRef, builtin: boolean }
  size?: 'sm' | 'md' | 'lg'
}>(), {
  size: 'md',
})

const glyph = computed(() => (props.plugin.builtin && !props.plugin.icon ? BUILTIN_PLUGIN_GLYPHS[props.plugin.id] ?? null : null))

const BOX = { sm: 'size-4 rounded-[4px]', md: 'size-7 rounded-md', lg: 'size-9 rounded-lg' } as const
const GLYPH = { sm: 'size-3', md: 'size-4', lg: 'size-[18px]' } as const
</script>

<template>
  <span
    v-if="glyph"
    role="img"
    :aria-label="plugin.name"
    data-slot="plugin-icon"
    data-kind="builtin"
    :data-size="size"
    :class="cn('inline-flex shrink-0 items-center justify-center bg-muted text-muted-foreground', BOX[size], size === 'sm' && 'bg-transparent')"
  >
    <component :is="glyph" aria-hidden="true" :class="cn(GLYPH[size], size === 'sm' && 'size-4')" />
  </span>
  <ProviderIcon
    v-else
    :id="plugin.id"
    :icon="plugin.icon"
    :name="plugin.name"
    :size="size"
    :variant="size === 'sm' ? 'auto' : 'color'"
  />
</template>
