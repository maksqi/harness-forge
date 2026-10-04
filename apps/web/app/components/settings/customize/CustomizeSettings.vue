<script setup lang="ts">
// Settings -> Customize (docs/UI.md 2.17, 9.12, 10.7; ADR-044, ADR-045): the agents, commands and skills of every
// source, by kind (tabs synced to `?tab=`) and scope (the project select synced to `?project=`), with the editor, the
// viewer and the hidden import input. The page (`pages/settings/customize.vue`) renders New and Import... in its header
// and reaches this body through `create()` / `import()`. No props, no emits; the exposes and the root test id are
// frozen from Gate P10-0b (C33 stub); W10.8 implements the page in P10-A.
import { testIds } from '~/utils/testids'

/** Opens the editor for a new definition of the current tab's kind (W10.8). */
function create(): void {}

/** Opens the file picker of the import (W10.8). */
function importFile(): void {}

defineExpose<{ create: () => void, import: () => void }>({ create, import: importFile })
</script>

<template>
  <div :data-testid="testIds.customizeSettings" class="flex flex-col gap-2 py-6">
    <p class="text-sm text-muted-foreground">
      Agents, commands and skills will be listed here.
    </p>
  </div>
</template>
