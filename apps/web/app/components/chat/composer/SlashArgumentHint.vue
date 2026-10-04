<script setup lang="ts">
// The argument hint of a typed command (docs/UI.md 7.28, 10.7; ADR-045): an `aria-hidden` mirror over the composer's
// textarea (same padding, font and line height) holding an invisible `/name ` and the muted hint, shown only while the
// text is exactly `/name` plus blanks on one line; the sr-only element with id `describedById` (linked from the
// textarea's `aria-describedby`) reads "Arguments: {hint}". It never takes keys. ChatComposer mounts it. Props and the
// root test id are frozen from Gate P10-0b (C33 stub); W10.9 implements the mirror's layout in P10-A.
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
      class="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words"
    >
      <span class="invisible">{{ text }}</span><span class="font-mono text-muted-foreground">{{ hint }}</span>
    </div>
    <span :id="describedById" class="sr-only">Arguments: {{ hint }}</span>
  </template>
</template>
