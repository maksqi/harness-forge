<script setup lang="ts">
// "New plugin" menu (docs/UI.md 5.4, 8.2): Provider (the declarative provider wizard) and Code plugin (a code
// template), each with a one-line hint. The trigger comes from the default slot (a sidebar row or a page button)
// and must be a single element.
import { CodeIcon, PlugZapIcon } from '@lucide/vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
}>(), {
  align: 'start',
  side: 'bottom',
})

defineSlots<{ default: () => any }>()

const ITEM_CLASS = 'items-start gap-2.5 py-2 [&>svg]:mt-0.5 [&>svg]:text-muted-foreground'
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <slot />
    </DropdownMenuTrigger>
    <DropdownMenuContent :align="align" :side="side" class="w-64">
      <DropdownMenuItem as-child :data-testid="testIds.pluginsNewProvider" :class="ITEM_CLASS">
        <NuxtLink :to="{ path: '/plugins/new', query: { type: 'provider' } }">
          <PlugZapIcon aria-hidden="true" />
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="font-medium">Provider</span>
            <span class="text-xs text-muted-foreground">Connect an OpenAI-, Anthropic- or Google-compatible API</span>
          </span>
        </NuxtLink>
      </DropdownMenuItem>
      <DropdownMenuItem as-child :data-testid="testIds.pluginsNewCode" :class="ITEM_CLASS">
        <NuxtLink :to="{ path: '/plugins/new', query: { type: 'code' } }">
          <CodeIcon aria-hidden="true" />
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="font-medium">Code plugin</span>
            <span class="text-xs text-muted-foreground">Write tools, providers or commands in JavaScript</span>
          </span>
        </NuxtLink>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
