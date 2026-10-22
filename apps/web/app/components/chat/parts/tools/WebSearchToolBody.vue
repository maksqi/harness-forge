<script setup lang="ts">
// The body of a web search row (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 7.35, 10.10): the builtin `search_web` of
// `core-search` (`native: false`) and the provider-executed search tools of native search (`native: true`; never an
// approval card, never `encryptedContent`). Store-free: ToolPart and ShareToolRow render it with the part's input and
// output, parsed here (`webSearchView`; unparsable → nothing): the query (`data-slot="web-search-query"`), "{n} results ·
// {search API}" or "The model's provider ran this search.", and the results (`web-search-result`, `data-domain`): a letter
// avatar, the title as a link (http(s) only, `safeExternalUrl`), the domain, the snippet as plain text.
// Props and the root test id are frozen from Gate P14-0b (C54 stub); W14.9 implements the body in P14-A.
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  input: unknown
  output: unknown
  /** A provider-executed search (native), else the builtin `search_web`. */
  native: boolean
  /** The search still runs. */
  running: boolean
}>()

const state = computed(() => (props.running ? 'running' : props.output === undefined || props.output === null ? 'error' : 'done'))
</script>

<template>
  <div
    :data-testid="testIds.webSearchTool"
    :data-mode="native ? 'native' : 'builtin'"
    :data-state="state"
    class="flex min-w-0 flex-col gap-2"
  />
</template>
