<script setup lang="ts">
// Provider or plugin icon from server URLs (docs/UI.md 10.4, ADR-010). Never inlines SVG markup:
// - mono: a span masked with the SVG over `currentColor` (.hf-icon-mask), so it takes the text color;
// - color: an <img> on a bg-muted tile;
// - monogram fallback: first letter(s) of `name` on a tile whose hue comes from a hash of `id`.
// The root has role="img" with `name` as its accessible name; the drawing inside is aria-hidden.
import type { IconRefLike, ProviderIconSize, ProviderIconVariant } from './provider-icon'
import { computed, watch } from 'vue'
import { cn } from '@/lib/utils'
import {
  cssUrl,
  failedIconUrls,
  hashHue,
  markIconFailed,
  monogramLetters,
  probeIconUrl,
  resolveProviderIcon,
} from './provider-icon'

const props = withDefaults(defineProps<{
  icon?: IconRefLike | null
  name: string
  id?: string
  size?: ProviderIconSize
  variant?: ProviderIconVariant
}>(), {
  icon: null,
  id: undefined,
  size: 'md',
  variant: 'auto',
})

const rendering = computed(() => resolveProviderIcon(props.icon, props.variant, failedIconUrls))
const hue = computed(() => hashHue(props.id || props.name))
const letters = computed(() => monogramLetters(props.name, props.size === 'sm' ? 1 : 2))
// Small mono glyphs sit inline without a tile; everything else is drawn on a tile.
const tiled = computed(() => !(rendering.value.kind === 'mono' && props.size === 'sm'))

watch(rendering, (value) => {
  if (value.kind === 'mono')
    probeIconUrl(value.url)
}, { immediate: true })

const BOX: Record<ProviderIconSize, string> = { sm: 'size-4', md: 'size-7', lg: 'size-9' }
const RADIUS: Record<ProviderIconSize, string> = { sm: 'rounded-[4px]', md: 'rounded-md', lg: 'rounded-lg' }
const MONO_GLYPH: Record<ProviderIconSize, string> = { sm: 'size-4', md: 'size-5', lg: 'size-6' }
const COLOR_GLYPH: Record<ProviderIconSize, string> = { sm: 'size-3', md: 'size-5', lg: 'size-6' }
const LETTER: Record<ProviderIconSize, string> = { sm: 'text-[9px]', md: 'text-[11px]', lg: 'text-[13px]' }
</script>

<template>
  <span
    role="img"
    :aria-label="name"
    data-slot="provider-icon"
    :data-kind="rendering.kind"
    :data-size="size"
    :class="cn(
      'inline-flex shrink-0 items-center justify-center overflow-hidden select-none',
      BOX[size],
      tiled && RADIUS[size],
      tiled && rendering.kind !== 'monogram' && 'bg-muted',
      rendering.kind === 'monogram' && 'hf-monogram',
    )"
    :style="rendering.kind === 'monogram' ? { '--hf-hue': String(hue) } : undefined"
  >
    <span
      v-if="rendering.kind === 'mono'"
      aria-hidden="true"
      :class="cn('hf-icon-mask', MONO_GLYPH[size])"
      :style="{ '--hf-icon': cssUrl(rendering.url) }"
    />
    <img
      v-else-if="rendering.kind === 'color'"
      :src="rendering.url"
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      draggable="false"
      :class="cn('object-contain', COLOR_GLYPH[size])"
      @error="markIconFailed(rendering.url)"
    >
    <span v-else aria-hidden="true" :class="cn('font-semibold leading-none tracking-tight', LETTER[size])">{{ letters }}</span>
  </span>
</template>
