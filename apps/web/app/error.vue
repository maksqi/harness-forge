<script setup lang="ts">
// Error page (docs/UI.md 6): unknown routes show "Page not found" + "Back to chats"; other errors a short
// "Something went wrong" (raw details never show, docs/UI.md 15). Rendered in the bare `auth` layout: the sidebar
// would record the broken URL as the last route of its mode.
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
const title = computed(() => (notFound.value ? 'Page not found' : 'Something went wrong'))
const description = computed(() => (notFound.value
  ? 'The page you are looking for does not exist.'
  : 'An unexpected error occurred. Go back to your chats and try again.'))

function backToChats() {
  void clearError({ redirect: '/' })
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
      <p class="text-sm text-muted-foreground">
        {{ description }}
      </p>
      <Button type="button" variant="outline" :data-testid="testIds.errorBack" @click="backToChats">
        Back to chats
      </Button>
    </div>
  </NuxtLayout>
</template>
