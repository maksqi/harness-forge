<script setup lang="ts">
// STUB (C5). W2.5 replaces this page: theme cards, reading font, text size, density and "Expand thinking by default"
// (docs/UI.md 9.5).
// Never renders its own <main> (the layout's SidebarInset is).
import { PaletteIcon } from '@lucide/vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import PageHeader from '~/components/common/PageHeader.vue'
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 md:px-6">
    <PageHeader title="Appearance" description="Theme, reading font, text size and density." />
    <Empty class="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PaletteIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Appearance settings</EmptyTitle>
        <EmptyDescription>Theme cards, reading font, text size, density and thinking expansion appear here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
</template>
