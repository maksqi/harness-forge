<script setup lang="ts">
// Submitted state (docs/UI.md 7.6): one transcript line with a shimmering "Thinking…" until the reply starts.
import { testIds } from '~/utils/testids'
</script>

<template>
  <p :data-testid="testIds.submittedPlaceholder" class="h-[1lh] text-muted-foreground" aria-hidden="true">
    <span class="hf-shimmer-text">Thinking…</span>
  </p>
</template>
