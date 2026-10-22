<script setup lang="ts">
// The body of a web search row (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 7.35, 10.10): the builtin `search_web` of
// `core-search` (`native: false`) and the provider-executed search tools of native search (`native: true`; never an
// approval card, never `encryptedContent`). Store-free: ToolPart and ShareToolRow render it with the part's input and
// output, parsed here (`webSearchView`; unparsable → nothing): the query (`data-slot="web-search-query"`), "{n} results ·
// {search API}" or "The model's provider ran this search.", and the results (`web-search-result`, `data-domain`): a letter
// avatar, the title as a link (http(s) only, `safeExternalUrl`), the domain, the snippet as plain text.
// Props and the root test id are frozen from Gate P14-0b (C54 stub); W14.9 implements the body in P14-A.
// W14.9: the results are a list named "Search results"; each title link opens a new tab (no opener, no referrer) and is
// described by its domain; the snippet is clamped to two lines, the published date (when the backend gave one) follows
// it. A running builtin call shows its query only.
import { computed, useId } from 'vue'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { NATIVE_WEB_SEARCH_NOTE, SOURCE_AVATAR_CLASSES, sourceAvatar, webSearchResultsText, webSearchView } from '../web-search'

const props = defineProps<{
  input: unknown
  output: unknown
  /** A provider-executed search (native), else the builtin `search_web`. */
  native: boolean
  /** The search still runs. */
  running: boolean
}>()

const baseId = useId()

const state = computed(() => (props.running ? 'running' : props.output === undefined || props.output === null ? 'error' : 'done'))
const view = computed(() => webSearchView(props.input, props.output, props.native))
/** "{n} results · {search API}" (builtin, once answered) or the native note. */
const summary = computed(() => {
  const current = view.value
  if (!current)
    return null
  if (current.native)
    return NATIVE_WEB_SEARCH_NOTE
  return current.backend ? `${webSearchResultsText(current.results.length)} · ${current.backend}` : null
})
const results = computed(() => (view.value?.results ?? []).map((result, index) => ({
  ...result,
  key: `${index}-${result.url}`,
  domainId: `${baseId}-domain-${index}`,
  avatar: sourceAvatar(result.domain),
})))
</script>

<template>
  <div
    :data-testid="testIds.webSearchTool"
    :data-mode="native ? 'native' : 'builtin'"
    :data-state="state"
    class="flex min-w-0 flex-col gap-2"
  >
    <template v-if="view">
      <div class="flex min-w-0 flex-col gap-0.5">
        <p v-if="view.query" data-slot="web-search-query" class="text-sm break-words text-foreground">
          {{ view.query }}
        </p>
        <p v-if="summary" data-slot="web-search-summary" class="text-xs text-muted-foreground">
          {{ summary }}
        </p>
      </div>
      <ul v-if="results.length > 0" aria-label="Search results" class="flex min-w-0 flex-col gap-2.5">
        <li
          v-for="result in results"
          :key="result.key"
          :data-testid="testIds.webSearchResult"
          :data-domain="result.domain"
          class="flex min-w-0 items-start gap-2"
        >
          <Avatar aria-hidden="true" class="mt-0.5 size-5 after:border-transparent">
            <AvatarFallback :class="cn('text-[10px] font-semibold', SOURCE_AVATAR_CLASSES[result.avatar.token])">
              {{ result.avatar.letter }}
            </AvatarFallback>
          </Avatar>
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <a
                :href="result.url"
                target="_blank"
                rel="noopener noreferrer"
                :aria-describedby="result.domainId"
                class="min-w-0 rounded-sm text-sm break-words text-foreground underline decoration-primary/40 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50"
              >{{ result.title }}</a>
              <span :id="result.domainId" class="max-w-full truncate text-xs text-muted-foreground">{{ result.domain }}</span>
            </div>
            <p v-if="result.snippet" class="line-clamp-2 text-xs break-words text-muted-foreground">
              {{ result.snippet }}
            </p>
            <p v-if="result.published" class="text-[11px] text-muted-foreground">
              {{ result.published }}
            </p>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
