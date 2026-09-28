<script setup lang="ts">
// STUB (C5). W2.5 replaces this page: display name, send key, defaults, Alt shortcuts, instructions and the password
// section (docs/UI.md 9.4).
// Never renders its own <main> (the layout's SidebarInset is).
import { SlidersHorizontalIcon } from '@lucide/vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import PageHeader from '~/components/common/PageHeader.vue'
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 md:px-6">
    <PageHeader title="General" description="Names, defaults and how messages are sent." />
    <Empty class="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SlidersHorizontalIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>General settings</EmptyTitle>
        <EmptyDescription>Display name, send key, default permission mode and effort, max steps, Alt shortcuts, instructions and password appear here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
</template>
