<script setup lang="ts">
// Settings -> Models body (docs/UI.md 9.3): default and title model, then the filter and one collapsible table per
// connected provider (favorite, visibility, rename, refresh, custom models). Large providers start collapsed.
import type { ProviderSummary } from '@harness-forge/shared'
import { BoxesIcon, SearchIcon } from '@lucide/vue'
import { computed, onMounted, ref, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import CustomModelDialog from './CustomModelDialog.vue'
import { LARGE_SECTION, modelSections } from './models'
import { toastError } from './notify'
import ProviderModelsSection from './ProviderModelsSection.vue'
import SettingsLoadError from './SettingsLoadError.vue'
import SettingsModelSelect from './SettingsModelSelect.vue'
import SettingsSection from './SettingsSection.vue'

const providers = useProvidersStore()
const models = useModelsStore()
const settings = useSettingsStore()

const ids = { defaultModel: useId(), titleModel: useId() }
const loading = ref(false)
const loadError = ref<unknown>(null)
const ready = computed(() => providers.loaded && models.loaded)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    await Promise.all([
      providers.fetchAll(),
      models.fetchAll(),
      settings.loaded ? Promise.resolve() : settings.fetch().catch(() => {}),
    ])
  }
  catch (error) {
    loadError.value = error
  }
  finally {
    loading.value = false
  }
}

onMounted(load)

// ---------- defaults ----------

async function update(patch: { defaultModelRef?: string | null, titleModelRef?: string | null }) {
  try {
    await settings.update(patch)
  }
  catch (error) {
    toastError(error)
  }
}

// ---------- provider sections ----------

const query = ref('')
const filtering = computed(() => query.value.trim() !== '')
const sections = computed(() => modelSections(providers.connected, models.items, query.value))
/** Sections the user opened or closed; the others follow their default (collapsed when large). */
const toggled = ref<Record<string, boolean>>({})

function isOpen(providerId: string, total: number): boolean {
  if (filtering.value)
    return true
  return toggled.value[providerId] ?? total <= LARGE_SECTION
}

function setOpen(providerId: string, open: boolean) {
  if (!filtering.value)
    toggled.value = { ...toggled.value, [providerId]: open }
}

const customProvider = ref<ProviderSummary | null>(null)
const customOpen = ref(false)

function addCustom(provider: ProviderSummary) {
  customProvider.value = provider
  customOpen.value = true
}
</script>

<template>
  <SettingsSection title="Defaults">
    <FieldGroup class="gap-5">
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :for="ids.defaultModel">
            Default model
          </FieldLabel>
          <FieldDescription>New chats start with this model.</FieldDescription>
        </FieldContent>
        <SettingsModelSelect
          :id="ids.defaultModel"
          :model-value="settings.resolved.defaultModelRef"
          allow-none
          none-label="Automatic (last used model)"
          label="Default model"
          :data-testid="testIds.modelsDefaultPicker"
          class="@md/field-group:w-96!"
          @update:model-value="value => update({ defaultModelRef: value })"
        />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :for="ids.titleModel">
            Title model
          </FieldLabel>
          <FieldDescription>Writes a short title for every new chat.</FieldDescription>
        </FieldContent>
        <SettingsModelSelect
          :id="ids.titleModel"
          :model-value="settings.resolved.titleModelRef"
          allow-none
          none-label="Automatic (small model of the chat's provider)"
          label="Title model"
          :data-testid="testIds.modelsTitlePicker"
          class="@md/field-group:w-96!"
          @update:model-value="value => update({ titleModelRef: value })"
        />
      </Field>
    </FieldGroup>
  </SettingsSection>

  <SettingsSection
    title="Models by provider"
    description="Favorites come first in the model picker. Hidden models never appear there."
  >
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        v-model="query"
        type="search"
        placeholder="Filter models…"
        aria-label="Filter models"
        autocomplete="off"
        :data-testid="testIds.modelsFilter"
      />
    </InputGroup>

    <SettingsLoadError
      v-if="loadError && !ready"
      title="Could not load models"
      :error="loadError"
      :pending="loading"
      @retry="load"
    />

    <div v-if="!ready && !loadError" aria-busy="true" aria-label="Loading models" class="flex flex-col gap-3">
      <div v-for="index in 3" :key="index" class="flex items-center gap-2.5 rounded-xl border bg-card px-3 py-3">
        <Skeleton class="size-4" />
        <Skeleton class="size-7 rounded-md" />
        <Skeleton class="h-3.5 w-40" />
        <Skeleton class="ml-auto h-7 w-24" />
      </div>
    </div>

    <template v-else-if="ready">
      <div v-if="sections.length" class="flex flex-col gap-3">
        <ProviderModelsSection
          v-for="section in sections"
          :key="section.provider.id"
          :provider="section.provider"
          :models="section.models"
          :total="section.total"
          :filtered="filtering"
          :open="isOpen(section.provider.id, section.total)"
          @update:open="value => setOpen(section.provider.id, value)"
          @add-custom="addCustom(section.provider)"
        />
      </div>
      <p v-else-if="filtering" class="py-6 text-center text-sm text-muted-foreground">
        No models match "{{ query.trim() }}".
      </p>
      <Empty v-else class="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BoxesIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No connected providers</EmptyTitle>
          <EmptyDescription>Add an API key or run models locally with Ollama, then manage the models here.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button as-child size="sm">
            <NuxtLink to="/settings/providers">
              Connect a provider
            </NuxtLink>
          </Button>
        </EmptyContent>
      </Empty>
    </template>
  </SettingsSection>

  <CustomModelDialog
    v-if="customProvider"
    v-model:open="customOpen"
    :provider-id="customProvider.id"
    :provider-name="customProvider.name"
  />
</template>
