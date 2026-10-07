<script setup lang="ts">
// The body of a `skill` call (docs/UI.md 7.28, 10.7; ADR-045): the skill's description, the base folder of a project
// skill (`baseDir`, mono) and its supporting files (`data-slot="skill-files"`, a mono list; the agent reads them with
// `read_file`), then the content as Markdown (`max-h-[50dvh]`, scrolls) with the caption "The agent read these
// instructions." and, when the body was cut, "Cut at 64 KB.". Store-free: ToolPart (inside AgentToolBody, which adds
// "Raw input and output") and ShareToolRow render it. The output is parsed with the shared skill schema; one that does
// not parse renders nothing. Props are frozen from Gate P10-0b (C33). No root test id (`data-slot="skill-body"`).
// Phase 12 (ADR-053, ADR-058; W12.13): `data-mode` says what the call returned. `file`: a supporting file the agent
// read with `skill { name, file }` (`fileAccess: 'skill'`, `output.file`): the heading "File" with its path (mono,
// `skill-file-path`) and its text in a `pre` (`skill-file-content`, `max-h-[50dvh]`, scrolls; never Markdown, it may be
// a script), the caption "The agent read this file of the skill." (+ "Cut at 64 KB."). `report`: a `context: fork`
// skill ran as a sub-agent (SKILL_FORK_CHECK, provided by ToolPart from the catalog): the heading "Report" and the
// caption "The skill ran as a sub-agent. This is its report.". Else `instructions` (the v1.7 body).
import { skillOutputSchema } from '@harness-forge/shared'
import { computed, inject } from 'vue'
import Markdown from '~/components/common/Markdown.vue'
import { SKILL_FORK_CHECK } from './agent-tools'

const props = defineProps<{ input: unknown, output: unknown }>()

const isFork = inject(SKILL_FORK_CHECK, null)

const skill = computed(() => {
  const parsed = skillOutputSchema.safeParse(props.output)
  return parsed.success ? parsed.data : null
})
const content = computed(() => skill.value?.content.trim() ?? '')
const files = computed(() => skill.value?.files ?? [])
/** + Phase 12: the supporting file a `file` call read. */
const file = computed(() => skill.value?.file ?? null)
const mode = computed<'file' | 'report' | 'instructions'>(() => {
  if (file.value)
    return 'file'
  return skill.value && isFork?.(skill.value.name) ? 'report' : 'instructions'
})
</script>

<template>
  <div v-if="skill" data-slot="skill-body" :data-mode="mode" class="flex min-w-0 flex-col gap-3 text-sm">
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
    <div v-if="files.length > 0 && !file" class="min-w-0">
      <h4 class="mb-1 flex h-6 items-center font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Files
      </h4>
      <ul data-slot="skill-files" role="list" class="flex min-w-0 flex-col gap-0.5 font-mono text-xs">
        <li v-for="item in files" :key="item" class="truncate" :title="item">
          {{ item }}
        </li>
      </ul>
    </div>
    <section v-if="file" class="min-w-0">
      <h4 class="mb-1 flex h-6 items-center font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        File
      </h4>
      <p data-slot="skill-file-path" class="mb-1.5 truncate font-mono text-xs" :title="file.path">
        {{ file.path }}
      </p>
      <pre
        data-slot="skill-file-content"
        tabindex="0"
        aria-label="File content"
        class="max-h-[50dvh] min-w-0 overflow-auto rounded-md bg-muted/60 p-2.5 font-mono text-xs break-words whitespace-pre-wrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >{{ file.content }}</pre>
      <p data-slot="skill-caption" class="mt-1.5 text-xs text-muted-foreground">
        The agent read this file of the skill.<template v-if="file.truncated">
          Cut at 64 KB.
        </template>
      </p>
    </section>
    <section v-else-if="content" class="min-w-0">
      <h4 class="mb-1 flex h-6 items-center font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {{ mode === 'report' ? 'Report' : 'Instructions' }}
      </h4>
      <div data-slot="skill-content" class="max-h-[50dvh] min-w-0 overflow-y-auto">
        <Markdown :content="content" :final="true" />
      </div>
      <p data-slot="skill-caption" class="mt-1.5 text-xs text-muted-foreground">
        <template v-if="mode === 'report'">
          The skill ran as a sub-agent. This is its report.
        </template>
        <template v-else>
          The agent read these instructions.
        </template><template v-if="skill.truncated">
          Cut at 64 KB.
        </template>
      </p>
    </section>
  </div>
</template>
