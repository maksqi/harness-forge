<script setup lang="ts">
// STUB (C5). W3.1 replaces this page: PluginHeader and the ?tab= tabs Overview (McpServersPanel for core-mcp, W3.5)
// · Configuration · Source (PluginSourceTab, W3.4) · Logs (docs/UI.md 2.4, 6, 8.7-8.11). Never renders its own
// <main>.
import { ArrowLeftIcon } from '@lucide/vue'
import { computed } from 'vue'
import { useRoute } from '#imports'
import PageHeader from '~/components/common/PageHeader.vue'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'

const route = useRoute()
const plugins = usePluginsStore()

const pluginId = computed(() => {
  const id = route.params.id
  return typeof id === 'string' ? id : ''
})
const plugin = computed(() => plugins.byId(pluginId.value))
</script>

<template>
  <div
    :data-testid="testIds.pluginDetail"
    :data-plugin-id="pluginId"
    :data-state="plugin?.state"
    class="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 md:px-6"
  >
    <PageHeader :title="plugin?.name ?? pluginId">
      <NuxtLink
        to="/plugins"
        class="-mt-1 mb-2 inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeftIcon aria-hidden="true" class="size-3.5" />
        Plugins
      </NuxtLink>
    </PageHeader>
    <div class="mt-4 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
      Overview, configuration, source and logs of this plugin appear here.
    </div>
  </div>
</template>
