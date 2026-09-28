<script setup lang="ts">
// Sources row (docs/UI.md 7.1): consecutive `source-url` / `source-document` parts as one collapsed row "3 sources";
// expanded, each source shows its title and host. Only http(s) URLs become links (new tab, no opener, no referrer).
import type { SourcePart } from '../chat-format'
import { ChevronRightIcon, FileTextIcon, Link2Icon } from '@lucide/vue'
import { computed, inject, ref, watch } from 'vue'
import {
  Source as AiSource,
  Sources as AiSources,
  SourcesContent as AiSourcesContent,
  SourcesTrigger as AiSourcesTrigger,
} from '@/components/ai-elements/sources'
import { testIds } from '~/utils/testids'
import { TRANSCRIPT_SCROLL } from '../chat-context'
import { hostnameOf, safeExternalUrl } from '../chat-format'

const props = defineProps<{ parts: SourcePart[] }>()

const open = ref(false)
const scroll = inject(TRANSCRIPT_SCROLL, null)
watch(open, (isOpen) => {
  if (isOpen)
    scroll?.holdPosition()
})

interface SourceItem {
  key: string
  title: string
  href: string | null
  detail: string
}

const items = computed<SourceItem[]>(() => props.parts.map((part, index) => {
  if (part.type === 'source-url') {
    const href = safeExternalUrl(part.url)
    return { key: `${part.sourceId}-${index}`, title: part.title || hostnameOf(part.url), href, detail: href ? hostnameOf(href) : part.url }
  }
  return { key: `${part.sourceId}-${index}`, title: part.title, href: null, detail: part.filename ?? part.mediaType }
}))
const label = computed(() => (items.value.length === 1 ? '1 source' : `${items.value.length} sources`))
</script>

<template>
  <AiSources v-model:open="open" data-slot="sources-part" class="mb-0 text-sm text-muted-foreground">
    <AiSourcesTrigger
      :count="items.length"
      :data-testid="testIds.sourcesRow"
      class="group/sources -mx-1.5 h-(--row-height) rounded-md px-1.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ChevronRightIcon
        aria-hidden="true"
        class="size-3.5 transition-transform duration-(--duration-base) group-data-[state=open]/sources:rotate-90"
      />
      <Link2Icon aria-hidden="true" class="size-3.5" />
      <span>{{ label }}</span>
    </AiSourcesTrigger>
    <AiSourcesContent class="mt-1 mb-1 w-full gap-1 pl-5">
      <template v-for="item in items" :key="item.key">
        <AiSource
          v-if="item.href"
          :href="item.href"
          :title="item.title"
          rel="noopener noreferrer"
          class="group/source min-w-0 rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Link2Icon aria-hidden="true" class="size-3.5 shrink-0" />
          <span class="min-w-0 truncate text-foreground underline decoration-primary/40 underline-offset-2 group-hover/source:decoration-primary">{{ item.title }}</span>
          <span class="shrink-0 text-xs">{{ item.detail }}</span>
        </AiSource>
        <span v-else class="flex min-w-0 items-center gap-2 text-sm">
          <FileTextIcon aria-hidden="true" class="size-3.5 shrink-0" />
          <span class="min-w-0 truncate text-foreground">{{ item.title }}</span>
          <span class="shrink-0 text-xs">{{ item.detail }}</span>
        </span>
      </template>
    </AiSourcesContent>
  </AiSources>
</template>
