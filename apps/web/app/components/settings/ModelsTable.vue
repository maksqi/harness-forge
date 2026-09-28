<script setup lang="ts">
// Models of one provider (docs/UI.md 9.3): name + mono id ("Custom" badge), capabilities, context, price per 1M
// tokens, favorite star, visibility switch (hidden models never appear in the model picker) and a menu with
// Rename (display-name alias), Reset name and, for custom models, Remove. Changes save at once; failures toast.
import type { CatalogModel } from '@harness-forge/shared'
import { EllipsisIcon, PencilIcon, StarIcon, Trash2Icon, Undo2Icon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { formatTokenCount } from '~/components/common/format'
import InlineRename from '~/components/common/InlineRename.vue'
import ModelCaps from '~/components/providers/ModelCaps.vue'
import { useModelsStore } from '~/stores/models'
import { testIds } from '~/utils/testids'
import { formatPrice } from './models'
import { toastError } from './notify'

defineProps<{ models: CatalogModel[], providerName: string }>()

const store = useModelsStore()

/** The model whose name is being edited inline. */
const editingRef = ref<string | null>(null)
/** "Rename" was picked: start editing once the menu has closed (it returns focus to its trigger first). */
let renameAfterClose: string | null = null

async function run(task: Promise<unknown>) {
  try {
    await task
  }
  catch (error) {
    toastError(error)
  }
}

function toggleFavorite(model: CatalogModel) {
  return run(store.setPref(model.ref, { favorite: !model.favorite }))
}

function setVisible(model: CatalogModel, visible: boolean) {
  return run(store.setPref(model.ref, { hidden: !visible }))
}

function rename(model: CatalogModel, name: string) {
  return run(store.setPref(model.ref, { alias: name }))
}

function resetName(model: CatalogModel) {
  return run(store.setPref(model.ref, { alias: null }))
}

async function remove(model: CatalogModel) {
  try {
    await store.removeCustom(model.providerId, model.id)
    toast.success(`Removed ${model.name}`)
  }
  catch (error) {
    toastError(error)
  }
}

/** ModelCaps shows vision, tools, reasoning and PDF input. */
function hasShownCaps(model: CatalogModel): boolean {
  const { vision, tools, reasoning, pdf } = model.capabilities
  return vision || tools || reasoning || pdf
}

function requestRename(model: CatalogModel) {
  renameAfterClose = model.ref
}

function onMenuClosed(event: Event) {
  if (renameAfterClose === null)
    return
  event.preventDefault()
  editingRef.value = renameAfterClose
  renameAfterClose = null
}

function stopEditing(value: boolean) {
  if (!value)
    editingRef.value = null
}
</script>

<template>
  <Table class="table-fixed">
    <TableCaption class="sr-only">
      {{ providerName }} models
    </TableCaption>
    <TableHeader>
      <TableRow class="hover:bg-transparent">
        <TableHead class="w-auto pl-4">
          Model
        </TableHead>
        <TableHead class="hidden w-28 sm:table-cell">
          Capabilities
        </TableHead>
        <TableHead class="hidden w-20 text-right md:table-cell">
          Context
        </TableHead>
        <TableHead class="hidden w-28 text-right lg:table-cell">
          Price / 1M
        </TableHead>
        <TableHead class="w-10 px-0 text-center">
          <span class="sr-only">Favorite</span>
        </TableHead>
        <TableHead class="w-14 text-center">
          Visible
        </TableHead>
        <TableHead class="w-12 pr-3">
          <span class="sr-only">Actions</span>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow
        v-for="model in models"
        :key="model.ref"
        :data-testid="testIds.modelRow"
        :data-model-ref="model.ref"
        :data-hidden="model.hidden"
        class="group/model"
      >
        <TableCell class="max-w-0 py-2 pl-4 whitespace-normal">
          <div :class="cn('flex min-w-0 items-center gap-2 text-sm', model.hidden && 'text-muted-foreground')">
            <InlineRename
              :model-value="model.name"
              :editing="editingRef === model.ref"
              :max-length="100"
              :aria-label="`Name of ${model.id}`"
              @update:model-value="value => rename(model, value)"
              @update:editing="stopEditing"
              @cancel="editingRef = null"
            />
            <Badge v-if="model.custom" variant="outline" class="h-4.5 shrink-0 px-1.5 text-[11px] text-muted-foreground">
              Custom
            </Badge>
          </div>
          <p class="truncate font-mono text-xs text-muted-foreground" :title="model.id">
            {{ model.id }}
          </p>
        </TableCell>
        <TableCell class="hidden sm:table-cell">
          <ModelCaps :capabilities="model.capabilities" />
          <span v-if="!hasShownCaps(model)" class="text-muted-foreground">—</span>
        </TableCell>
        <TableCell class="hidden text-right text-xs tabular-nums md:table-cell">
          <span v-if="model.contextWindow">{{ formatTokenCount(model.contextWindow) }}</span>
          <span v-else class="text-muted-foreground">—</span>
        </TableCell>
        <TableCell class="hidden text-right text-xs tabular-nums lg:table-cell">
          <span v-if="formatPrice(model.cost)">{{ formatPrice(model.cost) }}</span>
          <span v-else class="text-muted-foreground">—</span>
        </TableCell>
        <TableCell class="px-0 text-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            :aria-label="`Favorite ${model.name}`"
            :aria-pressed="model.favorite"
            :title="model.favorite ? 'Remove from favorites' : 'Add to favorites'"
            :data-testid="testIds.modelFavorite"
            :data-state="model.favorite ? 'on' : 'off'"
            class="text-muted-foreground hover:text-foreground"
            @click="toggleFavorite(model)"
          >
            <StarIcon aria-hidden="true" :class="cn('size-4', model.favorite && 'fill-primary text-primary')" />
          </Button>
        </TableCell>
        <TableCell class="text-center">
          <Switch
            size="sm"
            :model-value="!model.hidden"
            :aria-label="`Show ${model.name} in the model picker`"
            :data-testid="testIds.modelVisible"
            @update:model-value="value => setVisible(model, value)"
          />
        </TableCell>
        <TableCell class="pr-3">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                :aria-label="`Actions for ${model.name}`"
                class="text-muted-foreground hover:text-foreground"
              >
                <EllipsisIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-44" @close-auto-focus="onMenuClosed">
              <DropdownMenuItem @select="requestRename(model)">
                <PencilIcon aria-hidden="true" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem v-if="model.alias" @select="resetName(model)">
                <Undo2Icon aria-hidden="true" />
                Reset name
              </DropdownMenuItem>
              <template v-if="model.custom">
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" :data-testid="testIds.modelRemove" @select="remove(model)">
                  <Trash2Icon aria-hidden="true" />
                  Remove
                </DropdownMenuItem>
              </template>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
