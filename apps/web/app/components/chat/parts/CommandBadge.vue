<script setup lang="ts">
// Slash command marker above a user bubble (docs/UI.md 7.1): the text of the message stays as typed.
import { SquareTerminalIcon } from '@lucide/vue'

defineProps<{ name: string }>()
</script>

<template>
  <span
    data-slot="command-badge"
    class="inline-flex h-6 items-center gap-1.5 rounded-md border bg-card px-2 font-mono text-xs text-muted-foreground"
  >
    <SquareTerminalIcon aria-hidden="true" class="size-3.5" />
    <span class="sr-only">Command</span>/{{ name }}
  </span>
</template>
