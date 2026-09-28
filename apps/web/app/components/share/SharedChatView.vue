<script setup lang="ts">
// Public, read-only transcript of a share snapshot (docs/UI.md 2.9, 7.15, 14.2, ADR-025): the content of
// /share/[token] in the `share` layout. States on the root's data-state: `loading` (title and message skeletons),
// `ready` (h1 title, "Read-only snapshot · {date}", the messages as articles in a plain list; role="list" because
// Safari drops the semantics of an unstyled list), `unavailable` (404, the same answer for a malformed, revoked or
// expired link and a deleted chat) and `error` (anything else, with "Try again"; a rate limit says how long to wait).
// The head carries `robots: noindex, nofollow` and `referrer: no-referrer` (the server also sends X-Robots-Tag and
// Referrer-Policy).
// Contract (docs/UI.md 10.4): `token` is the route param. Store-free: the component calls only shares.view and never
// loads the auth status, settings, models, providers or chats; every child is store-free too.
import type { HarnessError, ShareView } from '@harness-forge/shared'
import { CircleAlertIcon, Link2OffIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { useApi } from '~/composables/useApi'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { useHead } from './nuxt-imports'
import { isShareToken, sharePageErrorMessage } from './share-view'
import SharedMessage from './SharedMessage.vue'

const props = defineProps<{ token: string }>()

type PageState = 'loading' | 'ready' | 'unavailable' | 'error'

const api = useApi()
const state = ref<PageState>('loading')
const view = ref<ShareView | null>(null)
const failure = ref<HarnessError | null>(null)
let seq = 0

async function load() {
  const current = ++seq
  view.value = null
  failure.value = null
  if (!isShareToken(props.token)) {
    state.value = 'unavailable'
    return
  }
  state.value = 'loading'
  try {
    const result = await api.shares.view({ params: { token: props.token } })
    if (current !== seq)
      return
    view.value = result
    state.value = 'ready'
  }
  catch (error) {
    if (current !== seq)
      return
    const harnessError = toHarnessError(error)
    if (harnessError.code === 'not_found') {
      state.value = 'unavailable'
    }
    else {
      failure.value = harnessError
      state.value = 'error'
    }
  }
}

watch(() => props.token, () => void load(), { immediate: true })

const title = computed(() => view.value?.title?.trim() || 'Untitled chat')
const snapshotDate = computed(() => (view.value ? new Date(view.value.snapshotAt) : null))
const snapshotDay = computed(() => snapshotDate.value?.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) ?? '')
const errorMessage = computed(() => (failure.value ? sharePageErrorMessage(failure.value) : ''))

const documentTitle = computed(() => {
  switch (state.value) {
    case 'ready':
      return `${title.value} · harness-forge`
    case 'unavailable':
      return 'Link unavailable · harness-forge'
    default:
      return 'Shared chat · harness-forge'
  }
})

useHead({
  title: documentTitle,
  meta: [
    { name: 'robots', content: 'noindex, nofollow' },
    { name: 'referrer', content: 'no-referrer' },
  ],
})
</script>

<template>
  <div
    :data-testid="testIds.sharePage"
    :data-state="state"
    class="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-8 pb-16 md:px-6"
  >
    <div v-if="state === 'loading'" aria-busy="true" class="flex flex-col gap-(--message-gap)">
      <span class="sr-only">Loading the shared chat…</span>
      <div class="flex flex-col gap-2">
        <Skeleton class="h-8 w-2/3" />
        <Skeleton class="h-4 w-48" />
      </div>
      <Skeleton class="h-10 w-2/5 self-end rounded-2xl" />
      <div class="flex flex-col gap-2.5">
        <Skeleton class="h-4 w-11/12" />
        <Skeleton class="h-4 w-4/5" />
        <Skeleton class="h-4 w-3/5" />
      </div>
    </div>

    <template v-else-if="state === 'ready' && view">
      <header class="mb-8 flex min-w-0 flex-col gap-1">
        <h1 :data-testid="testIds.shareTitle" class="text-2xl font-semibold tracking-tight break-words">
          {{ title }}
        </h1>
        <p :data-testid="testIds.shareMeta" class="text-sm text-muted-foreground">
          Read-only snapshot · <time :datetime="snapshotDate?.toISOString()" :title="snapshotDate?.toLocaleString()">{{ snapshotDay }}</time>
        </p>
      </header>
      <ol
        :data-testid="testIds.shareTranscript"
        role="list"
        aria-label="Messages"
        class="hf-transcript flex min-w-0 list-none flex-col gap-(--message-gap)"
      >
        <li v-for="(message, index) in view.messages" :key="index" class="min-w-0">
          <SharedMessage :message="message" :index="index" />
        </li>
      </ol>
    </template>

    <Empty v-else-if="state === 'unavailable'" :data-testid="testIds.shareUnavailable" class="border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Link2OffIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          <h1>This link is unavailable</h1>
        </EmptyTitle>
        <EmptyDescription>It may have expired or been revoked, or the chat was deleted.</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <Empty
      v-else-if="state === 'error'"
      role="alert"
      :data-testid="testIds.sharePageError"
      :data-code="failure?.code"
      class="border-0"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CircleAlertIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          <h1>Couldn't load this chat</h1>
        </EmptyTitle>
        <EmptyDescription>{{ errorMessage }}</EmptyDescription>
      </EmptyHeader>
      <Button type="button" variant="outline" :data-testid="testIds.sharePageRetry" @click="load">
        Try again
      </Button>
    </Empty>
  </div>
</template>
