<script setup lang="ts">
// STUB (C5). W2.5 replaces this page: versions from GET /api/health, license and "Copy diagnostics" (docs/UI.md 9.6).
// Never renders its own <main> (the layout's SidebarInset is).
import { InfoIcon } from '@lucide/vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import PageHeader from '~/components/common/PageHeader.vue'
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 md:px-6">
    <PageHeader title="About" description="Versions, license and diagnostics." />
    <Empty class="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <InfoIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>About harness-forge</EmptyTitle>
        <EmptyDescription>App and library versions, the license and "Copy diagnostics" appear here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
</template>
