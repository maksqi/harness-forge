<script setup lang="ts">
// Markdown images inside `Markdown` (docs/UI.md 10.4): lazy, `referrerpolicy="no-referrer"`, only same-origin, http(s),
// blob: and data:image/ sources; anything else shows the alt text. markstream passes renderer props this image does
// not use.
import { computed } from 'vue'
import { safeAssetUrl } from '~/components/common/format'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  node: { src?: string, alt?: string, title?: string | null, loading?: boolean }
}>()

const src = computed(() => (props.node.loading ? null : safeAssetUrl(props.node.src)))
</script>

<template>
  <img
    v-if="src"
    data-slot="markdown-image"
    :src="src"
    :alt="node.alt ?? ''"
    :title="node.title || undefined"
    loading="lazy"
    decoding="async"
    referrerpolicy="no-referrer"
    class="my-2 inline-block max-h-96 max-w-full rounded-md border bg-muted align-bottom"
  >
  <span v-else-if="node.alt" data-slot="markdown-image" class="text-muted-foreground">{{ node.alt }}</span>
</template>
