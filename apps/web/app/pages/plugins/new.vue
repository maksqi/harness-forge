<script setup lang="ts">
// STUB (C5). W3.3 replaces this page: `?type=provider` renders ProviderWizard (`?edit=<id>` edits a declarative
// plugin), `?type=code` renders CodePluginForm (W3.4), no type shows a chooser (docs/UI.md 6, 8.5, 8.6).
// Never renders its own <main>.
import { CodeIcon, PlugZapIcon } from '@lucide/vue'
import { computed } from 'vue'
import { useRoute } from '#imports'
import PageHeader from '~/components/common/PageHeader.vue'
import { testIds } from '~/utils/testids'

const route = useRoute()
const type = computed(() => {
  const value = route.query.type
  return value === 'provider' || value === 'code' ? value : null
})
const title = computed(() => (type.value === 'provider' ? 'New provider' : type.value === 'code' ? 'New code plugin' : 'New plugin'))
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 md:px-6">
    <PageHeader :title="title" />

    <div
      v-if="type === 'provider'"
      :data-testid="testIds.wizard"
      data-step="basics"
      class="mt-4 rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
    >
      The provider wizard goes here: basics, API, credentials, models and review.
    </div>

    <div
      v-else-if="type === 'code'"
      :data-testid="testIds.codePluginForm"
      class="mt-4 rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
    >
      The code plugin form goes here: name, id and a template.
    </div>

    <div v-else class="mt-4 grid gap-3 sm:grid-cols-2">
      <NuxtLink
        :to="{ path: '/plugins/new', query: { type: 'provider' } }"
        :data-testid="testIds.pluginsNewProvider"
        class="flex flex-col gap-2 rounded-lg border bg-card p-4 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <PlugZapIcon aria-hidden="true" class="size-5 text-muted-foreground" />
        <span class="font-medium">Provider</span>
        <span class="text-sm text-muted-foreground">Connect an OpenAI-, Anthropic- or Google-compatible API.</span>
      </NuxtLink>
      <NuxtLink
        :to="{ path: '/plugins/new', query: { type: 'code' } }"
        :data-testid="testIds.pluginsNewCode"
        class="flex flex-col gap-2 rounded-lg border bg-card p-4 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <CodeIcon aria-hidden="true" class="size-5 text-muted-foreground" />
        <span class="font-medium">Code plugin</span>
        <span class="text-sm text-muted-foreground">Write tools, providers or commands in JavaScript.</span>
      </NuxtLink>
    </div>
  </div>
</template>
