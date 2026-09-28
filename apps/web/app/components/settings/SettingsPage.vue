<script setup lang="ts">
// Frame of every settings page (docs/UI.md 3.8, 9): its own scroll area with a stable scrollbar gutter (switching
// between pages of different heights never shifts the layout), then PageHeader and a max-w-3xl column of sections.
// Never renders its own <main> (the layout's SidebarInset is).
import { computed } from 'vue'
import PageHeader from '~/components/common/PageHeader.vue'
import { useHead } from './nuxt-imports'

const props = defineProps<{ title: string, description?: string }>()
defineSlots<{
  /** Page content, usually SettingsSections. */
  default?: () => any
  /** Buttons on the right of the title row. */
  actions?: () => any
}>()

// Tab title and the route announcement: "Providers · harness-forge".
useHead({ title: computed(() => `${props.title} · harness-forge`) })
</script>

<template>
  <div data-slot="settings-page" class="hf-scroll-stable h-dvh min-h-0 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-3xl flex-col px-4 pb-16 md:px-6">
      <PageHeader :title="title" :description="description">
        <template v-if="$slots.actions" #actions>
          <slot name="actions" />
        </template>
      </PageHeader>
      <div class="flex flex-col pt-2">
        <slot />
      </div>
    </div>
  </div>
</template>
