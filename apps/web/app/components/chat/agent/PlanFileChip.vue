<script setup lang="ts">
// The plan file of an approved `exit_plan_mode` call (docs/UI.md 7.25, 10.7; ADR-047): "Saved to" + the path chip,
// Copy path and Show changes (project chats) when the plan was written (`planPath`), else "Couldn't save the plan
// file: {error}" (`planError`); nothing without either. ToolPart renders it first in the body of the row. Props and the
// root test id are frozen from Gate P10-0b (C33 stub); W10.11 implements the chip in P10-A. The stub shows the line.
import { testIds } from '~/utils/testids'

defineProps<{ planPath: string | null, planError: string | null, projectChat: boolean }>()
</script>

<template>
  <p
    v-if="planPath"
    :data-testid="testIds.planFile"
    data-state="saved"
    :data-path="planPath"
    class="min-w-0 truncate text-sm text-muted-foreground"
  >
    Saved to <span class="font-mono text-foreground">{{ planPath }}</span>
  </p>
  <p
    v-else-if="planError"
    :data-testid="testIds.planFile"
    data-state="failed"
    class="min-w-0 text-sm text-warning"
  >
    Couldn't save the plan file: {{ planError }}
  </p>
</template>
