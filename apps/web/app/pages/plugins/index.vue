<script setup lang="ts">
// STUB (C5). W3.1 replaces this page: PageHeader "Plugins" with search, Install… and New plugin, the ?filter= /
// ?q= list (`plugins.filtered(parsePluginFilter(route.query.filter), q)`) and the PluginCard grid
// (docs/UI.md 2.3, 8.1, 8.2). Never renders its own <main>.
import { BlocksIcon } from '@lucide/vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import PageHeader from '~/components/common/PageHeader.vue'
</script>

<template>
  <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 md:px-6">
    <PageHeader title="Plugins" />
    <Empty class="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BlocksIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Installed plugins</EmptyTitle>
        <EmptyDescription>Plugins and the providers, tools, MCP servers and commands they add are listed here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
</template>
