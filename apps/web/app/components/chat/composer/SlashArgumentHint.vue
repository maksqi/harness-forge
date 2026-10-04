<script setup lang="ts">
// The argument hint of a typed command (docs/UI.md 7.28, 10.7, 14.2; ADR-045): an `aria-hidden` mirror over the
// composer's textarea holding an invisible copy of the text (`/name ` and its blanks) followed by the muted hint, so the
// hint starts right where the caret is. It shows only while `hint` is set and the text is exactly `/name` plus one or
// more blanks on one line (the composer also passes null while the caret is not at the end or the textarea scrolled);
// the first argument character hides it. The sr-only element with id `describedById` (linked from the textarea's
// `aria-describedby`) reads "Arguments: {hint}". It never takes keys or pointer events.
// ChatComposer mounts it next to the textarea inside a `relative` box of the textarea's size; the mirror's padding,
// font size, line height and wrapping repeat the textarea's (ChatComposer TEXTAREA_CLASS: px-4 pt-3 pb-1, text-base
// leading-6 md:text-[15px]; keep them in sync). Props and the root test id are frozen from Gate P10-0b (C33).
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{ text: string, hint: string | null, describedById: string }>()

const TYPED_COMMAND = /^\/[a-z][\da-z-]{0,31}[ \t]+$/i

const visible = computed(() => props.hint !== null && props.hint !== '' && TYPED_COMMAND.test(props.text))
</script>

<template>
  <template v-if="visible">
    <div
      :data-testid="testIds.slashArgumentHint"
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 overflow-hidden px-4 pt-3 pb-1 text-base leading-6 break-words whitespace-pre-wrap select-none md:text-[15px]"
    >
      <span class="invisible">{{ text }}</span><span class="font-mono text-muted-foreground">{{ hint }}</span>
    </div>
    <span :id="describedById" class="sr-only">Arguments: {{ hint }}</span>
  </template>
</template>
