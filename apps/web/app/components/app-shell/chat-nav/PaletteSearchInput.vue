<script setup lang="ts">
// Search field of the command palette. Must render inside <Command> (a reka ListboxRoot): it drives the list's
// keyboard navigation (arrows, Home/End, Enter) while focus stays in the field. The palette filters its items
// itself, so this input is not bound to the shadcn Command filter. `highlightKey` changes when the items change
// asynchronously (search results arrive): the first item is highlighted again so Enter never targets a removed one.
// Attributes (data-testid, aria-label, placeholder) go to the input.
import { SearchIcon } from '@lucide/vue'
import { injectListboxRootContext, ListboxFilter } from 'reka-ui'
import { watch } from 'vue'
import { Spinner } from '@/components/ui/spinner'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  highlightKey?: string | number
  loading?: boolean
}>()

const query = defineModel<string>({ required: true })

const listbox = injectListboxRootContext()

watch(() => props.highlightKey, () => listbox.highlightFirstItem())
</script>

<template>
  <div data-slot="palette-search" class="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-3.5">
    <SearchIcon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
    <ListboxFilter
      v-model="query"
      auto-focus
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      v-bind="$attrs"
      class="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
    />
    <Spinner v-if="loading" class="size-4 shrink-0 text-muted-foreground" />
  </div>
</template>
