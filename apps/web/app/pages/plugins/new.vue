<script setup lang="ts">
// /plugins/new (docs/UI.md 6, 8.5, 8.6). `?type=provider` renders the provider wizard (`?edit=<id>` edits an existing
// declarative plugin), `?type=code` the code plugin form (W3.4), no type a chooser. Thin: the components own their
// logic; this page only maps their events to routes. Never renders its own <main>.
import { CodeIcon, PlugZapIcon } from '@lucide/vue'
import { computed } from 'vue'
import { navigateTo, useHead, useRoute } from '#imports'
import PageHeader from '~/components/common/PageHeader.vue'
import CodePluginForm from '~/components/plugins/code/CodePluginForm.vue'
import ProviderWizard from '~/components/plugins/wizard/ProviderWizard.vue'
import { testIds } from '~/utils/testids'

const route = useRoute()

const type = computed(() => {
  const value = route.query.type
  return value === 'provider' || value === 'code' ? value : null
})
const editId = computed(() => {
  const value = route.query.edit
  return type.value === 'provider' && typeof value === 'string' && value !== '' ? value : undefined
})

const title = computed(() => {
  if (type.value === 'provider')
    return editId.value ? 'Edit provider' : 'New provider'
  return type.value === 'code' ? 'New code plugin' : 'New plugin'
})
const description = computed(() => {
  if (type.value === 'provider')
    return editId.value ? 'Change the provider and save: it reloads right away.' : 'Connect any OpenAI-, Anthropic- or Google-compatible API. No code needed.'
  return undefined
})

useHead({ title: computed(() => `${title.value} · harness-forge`) })

function openPlugin(id: string, tab?: 'source') {
  void navigateTo({ path: `/plugins/${encodeURIComponent(id)}`, query: tab ? { tab } : {} })
}

function cancel() {
  void navigateTo(editId.value ? `/plugins/${encodeURIComponent(editId.value)}` : '/plugins')
}
</script>

<template>
  <div class="hf-scroll-stable h-dvh min-h-0 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-3xl flex-col px-4 pb-16 md:px-6">
      <PageHeader :title="title" :description="description" />

      <ProviderWizard
        v-if="type === 'provider'"
        :key="editId ?? 'new'"
        class="mt-2"
        :edit-id="editId"
        @created="id => openPlugin(id)"
        @cancel="cancel"
      />

      <CodePluginForm
        v-else-if="type === 'code'"
        class="mt-2"
        @created="id => openPlugin(id, 'source')"
        @cancel="cancel"
      />

      <div v-else class="mt-4 grid gap-3 sm:grid-cols-2">
        <NuxtLink
          :to="{ path: '/plugins/new', query: { type: 'provider' } }"
          :data-testid="testIds.pluginsNewProvider"
          class="flex flex-col gap-2 rounded-lg border bg-card p-4 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <PlugZapIcon aria-hidden="true" class="size-5 text-muted-foreground" />
          <span class="font-medium">Provider</span>
          <span class="text-sm text-muted-foreground">Connect an OpenAI-, Anthropic- or Google-compatible API. No code needed.</span>
        </NuxtLink>
        <NuxtLink
          :to="{ path: '/plugins/new', query: { type: 'code' } }"
          :data-testid="testIds.pluginsNewCode"
          class="flex flex-col gap-2 rounded-lg border bg-card p-4 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <CodeIcon aria-hidden="true" class="size-5 text-muted-foreground" />
          <span class="font-medium">Code plugin</span>
          <span class="text-sm text-muted-foreground">Write tools, providers, MCP bridges or commands in JavaScript.</span>
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
