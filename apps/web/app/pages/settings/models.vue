<script setup lang="ts">
// STUB (C5). W2.5 replaces this page: default and title model pickers, per-provider model tables and custom models
// (docs/UI.md 9.3).
// Never renders its own <main> (the layout's SidebarInset is).
import { BoxesIcon } from '@lucide/vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import PageHeader from '~/components/common/PageHeader.vue'
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 md:px-6">
    <PageHeader title="Models" description="Default and title models, favorites and visibility." />
    <Empty class="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BoxesIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Model catalog</EmptyTitle>
        <EmptyDescription>The default and title model pickers and the models of every connected provider appear here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
</template>
