<script setup lang="ts">
// STUB (C5). W2.5 replaces this page: InsecureBanner, ProviderList and ProviderKeyDialog (`?configure=<providerId>` opens it)
// (docs/UI.md 2.5, 9.1, 9.2).
// Never renders its own <main> (the layout's SidebarInset is).
import { KeyRoundIcon } from '@lucide/vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import PageHeader from '~/components/common/PageHeader.vue'
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 md:px-6">
    <PageHeader title="Providers" description="Bring your own API keys. Keys are encrypted on this server." />
    <Empty class="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRoundIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Provider keys</EmptyTitle>
        <EmptyDescription>Each provider with its status, an enable switch and a key dialog appears here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
</template>
