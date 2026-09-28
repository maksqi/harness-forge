<script setup lang="ts">
// Content of the model picker (docs/UI.md 7.9): a search field ("Search models…") over a command list with
// Favorites, Recent, one group per connected provider (`ProviderIcon` headers, chat models only) and "Image models"
// (Phase 6: the visible image models of connected providers, `data-value="images"`). Items show the provider icon, the
// name, capability icons (image output included), the context size and a star toggling the favorite. Enabled
// providers without credentials follow as "Not connected" rows that open their key dialog. Footer: "Manage models",
// "Connect providers".
// Keyboard: the search field keeps focus, ↑/↓ move, Enter picks; the selected model is highlighted on open.
import type { CatalogModel } from '@harness-forge/shared'
import type { ListboxItemSelectEvent } from 'reka-ui'
import { ClockIcon, ImageIcon, PlugZapIcon, SearchIcon, Settings2Icon, StarIcon } from '@lucide/vue'
import { ListboxFilter, ListboxGroupLabel } from 'reka-ui'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { formatTokenCount } from '~/components/common/format'
import ModelCaps from '~/components/providers/ModelCaps.vue'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { imagePickerModels, modelItemLabel, modelPickerGroups, unconnectedProviders } from './model-picker'

const props = withDefaults(defineProps<{
  modelValue: string | null
  allowNone?: boolean
  noneLabel?: string
  /** Classes of the scrolling list (height). */
  listClass?: string
}>(), {
  allowNone: false,
  noneLabel: 'None',
  listClass: '',
})

const emit = defineEmits<{
  select: [value: string | null]
  /** A "Connect" row was picked: the picker closes and navigates to the provider's key dialog. */
  navigate: [path: string]
  /** A footer link was followed (it navigates itself): the picker closes. */
  close: []
}>()

const NONE_VALUE = '__none__'

const models = useModelsStore()
const providers = useProvidersStore()
const query = ref('')

const imageModels = computed(() => imagePickerModels(models.visible, providers.connected))
const groups = computed(() => modelPickerGroups({
  favorites: models.favorites,
  recent: models.recent,
  byProvider: models.groupedByProvider,
  images: imageModels.value,
  providerName: providerId => providers.byId(providerId)?.name ?? providerId,
}, query.value))
const unconnected = computed(() => unconnectedProviders(providers.items, query.value))
const showNone = computed(() => props.allowNone && !query.value.trim())
const empty = computed(() => groups.value.length === 0 && unconnected.value.length === 0 && !showNone.value)
const selectedValue = computed(() => props.modelValue ?? (props.allowNone ? NONE_VALUE : ''))

function providerName(model: CatalogModel): string {
  return providers.byId(model.providerId)?.name ?? model.providerId
}

function contextLabel(model: CatalogModel): string {
  return model.contextWindow ? formatTokenCount(model.contextWindow) : ''
}

function onSelect(event: ListboxItemSelectEvent<unknown>, value: string | null) {
  // The picker is controlled by `modelValue`; the listbox must not toggle its own selection.
  event.preventDefault()
  emit('select', value)
}

function onConnect(event: ListboxItemSelectEvent<unknown>, providerId: string) {
  event.preventDefault()
  emit('navigate', `/settings/providers?configure=${encodeURIComponent(providerId)}`)
}

async function toggleFavorite(model: CatalogModel) {
  try {
    await models.setPref(model.ref, { favorite: !model.favorite })
  }
  catch (error) {
    toast.error('Could not update favorites', { description: toHarnessError(error).message })
  }
}
</script>

<template>
  <Command
    :model-value="selectedValue"
    class="rounded-none! bg-transparent p-0"
  >
    <div class="flex items-center gap-2 border-b px-3">
      <SearchIcon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
      <ListboxFilter
        v-model="query"
        auto-focus
        :data-testid="testIds.modelPickerSearch"
        placeholder="Search models…"
        aria-label="Search models"
        autocomplete="off"
        spellcheck="false"
        class="h-10 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>

    <CommandList :class="cn('max-h-[min(24rem,55vh)] p-1', listClass)">
      <div v-if="empty" class="px-3 py-6 text-center text-sm text-muted-foreground">
        <template v-if="query.trim()">
          No models found
        </template>
        <template v-else>
          No models yet. Connect a provider to start.
        </template>
      </div>

      <CommandGroup v-if="showNone" class="p-0 py-1">
        <CommandItem
          :value="NONE_VALUE"
          :data-testid="testIds.modelPickerItem"
          data-model-ref=""
          :data-checked="modelValue === null ? 'true' : undefined"
          class="h-9 rounded-md px-2"
          @select="onSelect($event, null)"
        >
          <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ noneLabel }}</span>
        </CommandItem>
      </CommandGroup>

      <CommandGroup
        v-for="group in groups"
        :key="group.key"
        :data-testid="testIds.modelPickerGroup"
        :data-value="group.value"
        class="p-0 py-1"
      >
        <ListboxGroupLabel class="flex h-8 items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
          <ProviderIcon
            v-if="group.provider"
            :id="group.provider.id"
            :icon="group.provider.icon"
            :name="group.provider.name"
            size="md"
            variant="color"
            class="size-6"
          />
          <StarIcon v-else-if="group.key === 'favorites'" aria-hidden="true" class="size-3.5" />
          <ClockIcon v-else-if="group.key === 'recent'" aria-hidden="true" class="size-3.5" />
          <ImageIcon v-else-if="group.key === 'images'" aria-hidden="true" class="size-3.5" />
          <span class="truncate">{{ group.label }}</span>
        </ListboxGroupLabel>
        <CommandItem
          v-for="model in group.models"
          :key="`${group.key}|${model.ref}`"
          :value="model.ref"
          :data-testid="testIds.modelPickerItem"
          :data-model-ref="model.ref"
          :data-checked="model.ref === modelValue ? 'true' : undefined"
          :aria-label="modelItemLabel(model, providerName(model), contextLabel(model))"
          class="group/model h-9 gap-2 rounded-md px-2"
          @select="onSelect($event, model.ref)"
        >
          <ProviderIcon
            :id="model.providerId"
            :icon="providers.byId(model.providerId)?.icon ?? null"
            :name="providerName(model)"
            size="sm"
            variant="auto"
          />
          <span class="min-w-0 flex-1 truncate">{{ model.name }}</span>
          <ModelCaps :capabilities="{ ...model.capabilities, pdf: false }" />
          <span class="w-9 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{{ contextLabel(model) }}</span>
          <button
            type="button"
            tabindex="-1"
            :data-testid="testIds.modelPickerFavorite"
            :data-model-ref="model.ref"
            aria-label="Favorite"
            :aria-pressed="model.favorite"
            :class="cn(
              'grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground',
              model.favorite ? 'opacity-100' : 'opacity-0 group-hover/model:opacity-100 group-data-highlighted/model:opacity-100 pointer-coarse:opacity-100',
            )"
            @pointerdown.stop
            @click.stop="toggleFavorite(model)"
          >
            <StarIcon :class="cn('size-3.5', model.favorite && 'fill-current text-warning!')" />
          </button>
        </CommandItem>
      </CommandGroup>

      <CommandGroup
        v-if="unconnected.length > 0"
        :data-testid="testIds.modelPickerGroup"
        data-value="not-connected"
        class="p-0 py-1"
      >
        <ListboxGroupLabel class="flex h-8 items-center px-2 text-xs font-medium text-muted-foreground">
          Not connected
        </ListboxGroupLabel>
        <CommandItem
          v-for="provider in unconnected"
          :key="provider.id"
          :value="`connect:${provider.id}`"
          :data-provider-id="provider.id"
          :aria-label="`Connect ${provider.name}`"
          class="h-9 gap-2 rounded-md px-2 text-muted-foreground"
          @select="onConnect($event, provider.id)"
        >
          <ProviderIcon :id="provider.id" :icon="provider.icon" :name="provider.name" size="sm" variant="auto" class="opacity-60" />
          <span class="min-w-0 flex-1 truncate">{{ provider.name }}</span>
          <span class="shrink-0 text-xs font-medium text-primary">Connect</span>
        </CommandItem>
      </CommandGroup>
    </CommandList>

    <div class="flex items-center justify-between gap-1 border-t p-1">
      <Button as-child variant="ghost" size="sm" class="h-8 gap-1.5 font-normal text-muted-foreground hover:text-foreground">
        <NuxtLink to="/settings/models" :data-testid="testIds.modelPickerManage" @click="emit('close')">
          <Settings2Icon aria-hidden="true" />
          Manage models
        </NuxtLink>
      </Button>
      <Button as-child variant="ghost" size="sm" class="h-8 gap-1.5 font-normal text-muted-foreground hover:text-foreground">
        <NuxtLink to="/settings/providers" :data-testid="testIds.modelPickerConnect" @click="emit('close')">
          <PlugZapIcon aria-hidden="true" />
          Connect providers
        </NuxtLink>
      </Button>
    </div>
  </Command>
</template>
