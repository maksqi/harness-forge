<script setup lang="ts">
// The body of a `skill` call (docs/UI.md 7.28, 10.7; ADR-045): the skill's description, the base folder and its
// supporting files of a project skill (`data-slot="skill-files"`), the content as Markdown with "The agent read these
// instructions." Store-free: ToolPart (inside AgentToolBody) and ShareToolRow render it. The values are parsed with the
// shared skill schemas; an output that does not parse renders nothing. Props are frozen from Gate P10-0b (C33 stub);
// W10.11 implements the body in P10-A. No root test id (`data-slot="skill-body"`); the stub shows the description.
import { skillOutputSchema } from '@harness-forge/shared'
import { computed } from 'vue'

const props = defineProps<{ input: unknown, output: unknown }>()

const skill = computed(() => {
  const parsed = skillOutputSchema.safeParse(props.output)
  return parsed.success ? parsed.data : null
})
</script>

<template>
  <div v-if="skill" data-slot="skill-body" class="flex min-w-0 flex-col gap-1.5 text-sm">
    <p class="text-muted-foreground">
      {{ skill.description }}
    </p>
  </div>
</template>
