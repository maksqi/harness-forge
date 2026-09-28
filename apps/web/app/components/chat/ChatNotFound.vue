<script setup lang="ts">
// "Chat not found" empty state (docs/UI.md 6, 15): unknown or malformed chat ids.
import { MessageSquareOffIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { testIds } from '~/utils/testids'
</script>

<template>
  <Empty :data-testid="testIds.chatNotFound" class="flex-1">
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <MessageSquareOffIcon aria-hidden="true" />
      </EmptyMedia>
      <EmptyTitle>Chat not found</EmptyTitle>
      <EmptyDescription>It may have been deleted.</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <Button as-child variant="outline" size="sm">
        <NuxtLink to="/">
          New chat
        </NuxtLink>
      </Button>
    </EmptyContent>
  </Empty>
</template>
