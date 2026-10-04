<script setup lang="ts">
// The body of a `skill` call (docs/UI.md 7.28, 10.7; ADR-045): the skill's description, the base folder of a project
// skill (`baseDir`, mono) and its supporting files (`data-slot="skill-files"`, a mono list; the agent reads them with
// `read_file`), then the content as Markdown (`max-h-[50dvh]`, scrolls) with the caption "The agent read these
// instructions." and, when the body was cut, "Cut at 64 KB.". Store-free: ToolPart (inside AgentToolBody, which adds
// "Raw input and output") and ShareToolRow render it. The output is parsed with the shared skill schema; one that does
// not parse renders nothing. Props are frozen from Gate P10-0b (C33). No root test id (`data-slot="skill-body"`).
import { skillOutputSchema } from '@harness-forge/shared'
import { computed } from 'vue'
import Markdown from '~/components/common/Markdown.vue'

const props = defineProps<{ input: unknown, output: unknown }>()

const skill = computed(() => {
  const parsed = skillOutputSchema.safeParse(props.output)
  return parsed.success ? parsed.data : null
})
const content = computed(() => skill.value?.content.trim() ?? '')
const files = computed(() => skill.value?.files ?? [])
</script>

<template>
  <div v-if="skill" data-slot="skill-body" class="flex min-w-0 flex-col gap-3 text-sm">
    <p v-if="skill.description" data-slot="skill-description" class="break-words text-muted-foreground">
      {{ skill.description }}
    </p>
    <div v-if="skill.baseDir" data-slot="skill-base-dir" class="min-w-0">
      <h4 class="mb-1 flex h-6 items-center font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Folder
      </h4>
      <p class="truncate font-mono text-xs" :title="skill.baseDir">
        {{ skill.baseDir }}
      </p>
    </div>
    <div v-if="files.length > 0" class="min-w-0">
      <h4 class="mb-1 flex h-6 items-center font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Files
      </h4>
      <ul data-slot="skill-files" role="list" class="flex min-w-0 flex-col gap-0.5 font-mono text-xs">
        <li v-for="file in files" :key="file" class="truncate" :title="file">
          {{ file }}
        </li>
      </ul>
    </div>
    <section v-if="content" class="min-w-0">
      <h4 class="mb-1 flex h-6 items-center font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Instructions
      </h4>
      <div data-slot="skill-content" class="max-h-[50dvh] min-w-0 overflow-y-auto">
        <Markdown :content="content" :final="true" />
      </div>
      <p data-slot="skill-caption" class="mt-1.5 text-xs text-muted-foreground">
        The agent read these instructions.<template v-if="skill.truncated">
          Cut at 64 KB.
        </template>
      </p>
    </section>
  </div>
</template>
