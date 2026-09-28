<script setup lang="ts">
// Assistant text part (docs/UI.md 7.1): markdown through the safe `Markdown` wrapper; `final` once the part is done.
import type { TextUIPart } from 'ai'
import Markdown from '~/components/common/Markdown.vue'

defineProps<{ part: TextUIPart, final: boolean }>()
</script>

<template>
  <Markdown :content="part.text" :final="final" />
</template>
