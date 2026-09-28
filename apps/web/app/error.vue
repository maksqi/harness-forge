<script setup lang="ts">
// Error page (docs/UI.md 6): unknown routes show "Page not found" + "Back to chats"; a server that refuses the app
// (`403`, raised by the auth middleware with the server's own explanation, e.g. its DNS rebinding protection) shows
// that explanation + "Try again"; other errors a short "Something went wrong" (raw details never show, docs/UI.md 15).
// Rendered in the bare `auth` layout: the sidebar would record the broken URL as the last route of its mode.
import type { NuxtError } from '#app'
import { computed } from 'vue'
import { clearError } from '#imports'
import { Button } from '@/components/ui/button'
import BrandMark from '~/components/common/BrandMark.vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{ error: NuxtError }>()

// `status` replaces the deprecated `statusCode` in Nuxt 4.
const status = computed(() => props.error.status ?? props.error.statusCode ?? 500)
const notFound = computed(() => status.value === 404)
/** The server refused every request; its message says why and what to do. */
const blocked = computed(() => status.value === 403 && typeof props.error.message === 'string' && props.error.message !== '')
const title = computed(() => {
  if (notFound.value)
    return 'Page not found'
  return blocked.value ? 'harness-forge can\'t be opened here' : 'Something went wrong'
})
const description = computed(() => {
  if (notFound.value)
    return 'The page you are looking for does not exist.'
  return blocked.value ? props.error.message : 'An unexpected error occurred. Go back to your chats and try again.'
})

function backToChats() {
  void clearError({ redirect: '/' })
}

/** The refusal comes from the server's configuration: only a fresh start of the app can pick up a change. */
function tryAgain() {
  window.location.reload()
}
</script>

<template>
  <NuxtLayout name="auth">
    <div
      :data-testid="testIds.errorPage"
      :data-status="status"
      class="flex flex-col items-center gap-4 text-center"
    >
      <BrandMark :size="28" />
      <h1 class="text-xl font-semibold tracking-tight">
        {{ title }}
      </h1>
      <p class="text-sm text-balance text-muted-foreground">
        {{ description }}
      </p>
      <Button v-if="blocked" type="button" variant="outline" :data-testid="testIds.errorRetry" @click="tryAgain">
        Try again
      </Button>
      <Button v-else type="button" variant="outline" :data-testid="testIds.errorBack" @click="backToChats">
        Back to chats
      </Button>
    </div>
  </NuxtLayout>
</template>
