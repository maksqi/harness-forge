<script setup lang="ts">
// Step 4 of the provider wizard (docs/UI.md 8.5): the runtime listing switch (+ id filters), "Fetch models" through
// `POST /api/plugins/drafts/test` (list mode) with a checkbox list of what the API offers, and the models written to
// the manifest: id, name, capabilities, reasoning efforts, limits and prices per 1M tokens.
import type { HarnessErrorInit, ModelInfo } from '@harness-forge/shared'
import type { WizardModel } from './wizard'
import { BrainIcon, ChevronDownIcon, EyeIcon, FileTextIcon, ListRestartIcon, PlusIcon, Trash2Icon, WrenchIcon } from '@lucide/vue'
import { computed, nextTick, reactive, ref, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import { useApi } from '~/composables/useApi'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { buildTestRequest, emptyModel, MODEL_EFFORTS, parseTokenCount, wizardModelFromInfo } from './wizard'
import { useWizardContext } from './wizard-context'
import WizardErrorAlert from './WizardErrorAlert.vue'

const { form, values, issues, errorOf, touch, fetched } = useWizardContext()
const api = useApi()
const ids = { listing: useId(), models: useId(), small: useId(), include: useId(), exclude: useId() }

/** Fetched rows rendered at once; the filter narrows longer lists. */
const SHOWN_LIMIT = 300
const NO_SMALL_MODEL = '__none__'

const CAPABILITIES = [
  { key: 'tools', label: 'Tools', icon: WrenchIcon },
  { key: 'vision', label: 'Vision', icon: EyeIcon },
  { key: 'reasoning', label: 'Reasoning', icon: BrainIcon },
  { key: 'pdf', label: 'PDF input', icon: FileTextIcon },
] as const

const fetching = ref(false)
const fetchInfo = ref<{ latencyMs: number, count: number } | null>(null)
const fetchError = ref<HarnessErrorInit | null>(null)
const filter = ref('')
const expanded = reactive(new Set<number>())
const modelList = ref<HTMLElement | null>(null)

const selectedIds = computed(() => new Set(values.value.models.map(model => model.id.trim())))
const matching = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  const all = fetched.value ?? []
  return needle === '' ? all : all.filter(model => model.id.toLowerCase().includes(needle) || (model.name ?? '').toLowerCase().includes(needle))
})
const shown = computed(() => matching.value.slice(0, SHOWN_LIMIT))
/** Blocking issues of the earlier steps: the draft test needs a valid provider. */
const providerReady = computed(() => !['baseURL', 'authHeader', 'credentials'].some(path => path in issues.value)
  && !Object.keys(issues.value).some(path => path.startsWith('credentials.') || path.startsWith('headers.')))
const smallOptions = computed(() => [...new Set(values.value.models.map(model => model.id.trim()).filter(id => id !== ''))])

async function fetchModels() {
  fetching.value = true
  fetchError.value = null
  try {
    const result = await api.pluginDrafts.test({ body: buildTestRequest(values.value, 'list-models') })
    if (result.ok) {
      fetched.value = result.models ?? []
      fetchInfo.value = { latencyMs: result.latencyMs, count: fetched.value.length }
    }
    else {
      fetchError.value = result.error ?? { code: 'provider_error', message: 'The model list could not be fetched.' }
    }
  }
  catch (error) {
    fetchError.value = toHarnessError(error).toJSON().error
  }
  finally {
    fetching.value = false
  }
}

function toggleFetched(info: ModelInfo, checked: boolean) {
  const index = values.value.models.findIndex(model => model.id.trim() === info.id)
  if (checked && index < 0)
    form.pushFieldValue('models', wizardModelFromInfo(info))
  else if (!checked && index >= 0)
    void form.removeFieldValue('models', index)
}

function selectShown() {
  const added = shown.value.filter(model => !selectedIds.value.has(model.id)).map(wizardModelFromInfo)
  form.setFieldValue('models', [...values.value.models, ...added])
}

function clearFetched() {
  const fetchedIds = new Set((fetched.value ?? []).map(model => model.id))
  form.setFieldValue('models', values.value.models.filter(model => !fetchedIds.has(model.id.trim())))
  expanded.clear()
}

async function addModel() {
  form.pushFieldValue('models', emptyModel())
  expanded.add(values.value.models.length - 1)
  await nextTick()
  modelList.value?.querySelector<HTMLElement>('[data-slot="model-row"]:last-child input')?.focus()
}

function removeModel(index: number) {
  void form.removeFieldValue('models', index)
  expanded.clear()
}

function setModel<K extends keyof WizardModel>(index: number, key: K, value: WizardModel[K]) {
  form.setFieldValue('models', values.value.models.map((model, position) => {
    if (position !== index)
      return model
    const next = { ...model, [key]: value }
    // Efforts only apply to reasoning models.
    if (key === 'reasoning' && value === false)
      next.efforts = []
    return next
  }))
}

function toggleEffort(index: number, effort: WizardModel['efforts'][number], on: boolean) {
  const current = values.value.models[index]?.efforts ?? []
  setModel(index, 'efforts', on ? [...current, effort] : current.filter(item => item !== effort))
}

function toggleExpanded(index: number) {
  if (expanded.has(index))
    expanded.delete(index)
  else
    expanded.add(index)
}

function isExpanded(index: number): boolean {
  return expanded.has(index) || ['contextWindow', 'maxOutputTokens', 'inputCost', 'outputCost'].some(key => Boolean(errorOf(`models.${index}.${key}`)))
}

function setSmallModel(value: unknown) {
  form.setFieldValue('smallModelId', typeof value === 'string' && value !== NO_SMALL_MODEL ? value : '')
}

function contextLabel(model: ModelInfo): string {
  const tokens = model.contextWindow
  if (!tokens)
    return ''
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}K`
}

function limitHint(text: string): string {
  const tokens = parseTokenCount(text)
  return tokens === null ? '' : `${tokens.toLocaleString('en-US')} tokens`
}
</script>

<template>
  <div class="grid gap-7">
    <section class="grid gap-3 rounded-lg border bg-card p-4" :aria-labelledby="ids.listing">
      <div class="flex items-start justify-between gap-4">
        <div class="grid gap-1">
          <Label :id="ids.listing" for="wizard-list-models" class="text-sm font-medium">Fetch the model list at runtime</Label>
          <p class="text-xs text-muted-foreground">
            <span class="font-mono">GET {{ values.baseURL.trim().replace(/\/+$/, '') || '…' }}/models</span> with the stored key, cached for 24 hours.
            Models you add below get your capabilities and prices on top.
          </p>
        </div>
        <Switch
          id="wizard-list-models"
          :model-value="values.listModels"
          @update:model-value="value => form.setFieldValue('listModels', value === true)"
        />
      </div>
      <Collapsible v-if="values.listModels">
        <CollapsibleTrigger class="group/filters inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
          <ChevronDownIcon aria-hidden="true" class="size-3.5 transition-transform group-data-[state=open]/filters:rotate-180" />
          Filter the list
          <span v-if="values.listInclude || values.listExclude" class="font-mono">({{ [values.listInclude && `include ${values.listInclude}`, values.listExclude && `exclude ${values.listExclude}`].filter(Boolean).join(', ') }})</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <div class="grid content-start gap-1">
              <Label :for="ids.include" class="text-xs text-muted-foreground">Include ids matching</Label>
              <Input
                :id="ids.include"
                :model-value="values.listInclude"
                placeholder="llama|qwen"
                class="h-8 font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                :aria-invalid="errorOf('listInclude') ? true : undefined"
                @update:model-value="value => form.setFieldValue('listInclude', String(value))"
                @blur="touch('listInclude')"
              />
              <FieldError :errors="[errorOf('listInclude')]" class="text-xs" />
            </div>
            <div class="grid content-start gap-1">
              <Label :for="ids.exclude" class="text-xs text-muted-foreground">Exclude ids matching</Label>
              <Input
                :id="ids.exclude"
                :model-value="values.listExclude"
                placeholder="embed|rerank|tts"
                class="h-8 font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                :aria-invalid="errorOf('listExclude') ? true : undefined"
                @update:model-value="value => form.setFieldValue('listExclude', String(value))"
                @blur="touch('listExclude')"
              />
              <FieldError :errors="[errorOf('listExclude')]" class="text-xs" />
            </div>
            <p class="text-xs text-muted-foreground sm:col-span-2">
              Regular expressions, not case-sensitive. Exclude wins.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>

    <section class="grid gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          :disabled="fetching || !providerReady"
          :aria-busy="fetching || undefined"
          :data-testid="testIds.wizardFetchModels"
          data-wizard-autofocus
          @click="fetchModels"
        >
          <Spinner v-if="fetching" data-icon="inline-start" />
          <ListRestartIcon v-else data-icon="inline-start" aria-hidden="true" />
          {{ fetched ? 'Fetch again' : 'Fetch models' }}
        </Button>
        <p v-if="fetchInfo && !fetchError" role="status" class="text-sm text-muted-foreground">
          {{ fetchInfo.count }} {{ fetchInfo.count === 1 ? 'model' : 'models' }} · {{ fetchInfo.latencyMs }} ms
        </p>
        <p v-else-if="!providerReady" class="text-xs text-muted-foreground">
          Complete the API and credentials steps to fetch models.
        </p>
      </div>
      <WizardErrorAlert v-if="fetchError" :error="{ error: fetchError }" :provider-name="values.name || undefined" />

      <div v-if="fetched" class="grid gap-2 rounded-lg border">
        <div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Input v-model="filter" type="search" placeholder="Filter models…" aria-label="Filter fetched models" class="h-8 max-w-60" />
          <span class="text-xs text-muted-foreground">
            {{ matching.length }} of {{ fetched.length }}<template v-if="matching.length > SHOWN_LIMIT"> · first {{ SHOWN_LIMIT }} shown</template>
          </span>
          <div class="ml-auto flex gap-1">
            <Button type="button" size="sm" variant="ghost" :disabled="shown.length === 0" @click="selectShown">
              Select shown
            </Button>
            <Button type="button" size="sm" variant="ghost" :disabled="!fetched.some(model => selectedIds.has(model.id))" @click="clearFetched">
              Clear
            </Button>
          </div>
        </div>
        <p v-if="fetched.length === 0" class="px-3 pb-3 text-sm text-muted-foreground">
          The API answered with an empty list. Add the models by hand.
        </p>
        <ul v-else class="hf-scroll-stable grid max-h-64 overflow-y-auto px-1 pb-1" aria-label="Fetched models">
          <li v-for="model in shown" :key="model.id">
            <Label class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 font-normal hover:bg-muted/60">
              <Checkbox :model-value="selectedIds.has(model.id)" @update:model-value="value => toggleFetched(model, value === true)" />
              <span class="min-w-0 flex-1 truncate font-mono text-[13px]">{{ model.id }}</span>
              <span v-if="model.name" class="hidden max-w-48 truncate text-xs text-muted-foreground sm:inline">{{ model.name }}</span>
              <span v-if="contextLabel(model)" class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ contextLabel(model) }}</span>
            </Label>
          </li>
        </ul>
      </div>
    </section>

    <section class="grid gap-3" :aria-labelledby="ids.models">
      <div class="flex items-end justify-between gap-3">
        <div>
          <h3 :id="ids.models" class="text-sm font-medium">
            Models in the manifest <span class="font-normal text-muted-foreground">({{ values.models.length }})</span>
          </h3>
          <p class="text-xs text-muted-foreground">
            Always listed, with the capabilities you set. Without runtime fetching they are the only models.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" :data-testid="testIds.wizardAddModel" @click="addModel">
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Add model
        </Button>
      </div>

      <p v-if="values.models.length === 0" class="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
        <template v-if="values.listModels">
          No models pinned. The list is fetched from the API when the provider loads.
        </template>
        <template v-else>
          Add at least one model, or turn on fetching the model list at runtime.
        </template>
      </p>
      <div v-else ref="modelList" class="grid gap-2">
        <div
          v-for="(model, index) in values.models"
          :key="index"
          data-slot="model-row"
          :data-testid="testIds.wizardModelRow"
          :data-value="model.id"
          class="rounded-lg border bg-card"
        >
          <div class="grid gap-2 p-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto_auto] sm:items-start">
            <div class="grid gap-1">
              <Input
                :model-value="model.id"
                placeholder="model-id"
                aria-label="Model id"
                autocomplete="off"
                spellcheck="false"
                class="h-8 font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                :aria-invalid="errorOf(`models.${index}.id`) ? true : undefined"
                @update:model-value="value => setModel(index, 'id', String(value))"
                @blur="touch(`models.${index}.id`)"
              />
              <FieldError :errors="[errorOf(`models.${index}.id`)]" class="text-xs" />
            </div>
            <div class="grid gap-1">
              <Input
                :model-value="model.name"
                placeholder="Display name"
                aria-label="Display name"
                autocomplete="off"
                class="h-8"
                :aria-invalid="errorOf(`models.${index}.name`) ? true : undefined"
                @update:model-value="value => setModel(index, 'name', String(value))"
                @blur="touch(`models.${index}.name`)"
              />
              <FieldError :errors="[errorOf(`models.${index}.name`)]" class="text-xs" />
            </div>
            <div class="flex items-center justify-between gap-1 sm:contents">
              <div class="flex items-center gap-0.5" role="group" :aria-label="`Capabilities of ${model.id || 'this model'}`">
                <Toggle
                  v-for="capability in CAPABILITIES"
                  :key="capability.key"
                  size="sm"
                  class="size-8 min-w-8 px-0 text-muted-foreground aria-pressed:text-foreground"
                  :model-value="model[capability.key]"
                  :aria-label="capability.label"
                  :title="capability.label"
                  @update:model-value="value => setModel(index, capability.key, value === true)"
                >
                  <component :is="capability.icon" aria-hidden="true" />
                </Toggle>
              </div>
              <div class="flex items-center gap-0.5">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  :aria-label="isExpanded(index) ? 'Hide details' : 'Show details'"
                  :aria-expanded="isExpanded(index)"
                  :title="isExpanded(index) ? 'Hide details' : 'Limits, efforts and prices'"
                  @click="toggleExpanded(index)"
                >
                  <ChevronDownIcon aria-hidden="true" class="transition-transform" :class="isExpanded(index) && 'rotate-180'" />
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" :aria-label="`Remove ${model.id || 'model'}`" title="Remove model" @click="removeModel(index)">
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
            </div>
          </div>
          <div v-if="isExpanded(index)" class="grid gap-3 border-t p-3 sm:grid-cols-4">
            <div v-for="limit in (['contextWindow', 'maxOutputTokens'] as const)" :key="limit" class="grid content-start gap-1">
              <Label :for="`${ids.models}-${limit}-${index}`" class="text-xs text-muted-foreground">
                {{ limit === 'contextWindow' ? 'Context window' : 'Max output' }}
              </Label>
              <Input
                :id="`${ids.models}-${limit}-${index}`"
                :model-value="model[limit]"
                inputmode="numeric"
                :placeholder="limit === 'contextWindow' ? '128K' : '8K'"
                class="h-8 tabular-nums"
                :aria-invalid="errorOf(`models.${index}.${limit}`) ? true : undefined"
                @update:model-value="value => setModel(index, limit, String(value))"
                @blur="touch(`models.${index}.${limit}`)"
              />
              <FieldError v-if="errorOf(`models.${index}.${limit}`)" :errors="[errorOf(`models.${index}.${limit}`)]" class="text-xs" />
              <p v-else class="text-[11px] text-muted-foreground tabular-nums">
                {{ limitHint(model[limit]) }}
              </p>
            </div>
            <div v-for="price in (['inputCost', 'outputCost'] as const)" :key="price" class="grid content-start gap-1">
              <Label :for="`${ids.models}-${price}-${index}`" class="text-xs text-muted-foreground">
                {{ price === 'inputCost' ? 'Input' : 'Output' }} $ / 1M tokens
              </Label>
              <Input
                :id="`${ids.models}-${price}-${index}`"
                :model-value="model[price]"
                inputmode="decimal"
                placeholder="0.00"
                class="h-8 tabular-nums"
                :aria-invalid="errorOf(`models.${index}.${price}`) ? true : undefined"
                @update:model-value="value => setModel(index, price, String(value))"
                @blur="touch(`models.${index}.${price}`)"
              />
              <FieldError :errors="[errorOf(`models.${index}.${price}`)]" class="text-xs" />
            </div>
            <div v-if="model.reasoning" class="grid gap-1 sm:col-span-4">
              <span class="text-xs text-muted-foreground">Reasoning efforts offered (Auto is always offered)</span>
              <div class="flex flex-wrap gap-1" role="group" aria-label="Reasoning efforts">
                <Toggle
                  v-for="effort in MODEL_EFFORTS"
                  :key="effort"
                  size="sm"
                  variant="outline"
                  class="h-7 capitalize"
                  :model-value="model.efforts.includes(effort)"
                  @update:model-value="value => toggleEffort(index, effort, value === true)"
                >
                  {{ effort }}
                </Toggle>
              </div>
              <p class="text-[11px] text-muted-foreground">
                None selected: off, low, medium and high. Max is offered only when selected.
              </p>
            </div>
          </div>
        </div>
      </div>
      <FieldError :errors="[errorOf('models')]" class="text-xs" />
    </section>

    <div v-if="smallOptions.length > 0" class="grid max-w-md gap-2">
      <Label :for="ids.small">Model for chat titles and tests <span class="font-normal text-muted-foreground">(optional)</span></Label>
      <Select :model-value="values.smallModelId || NO_SMALL_MODEL" @update:model-value="setSmallModel">
        <SelectTrigger :id="ids.small" class="w-full" :class="values.smallModelId && 'font-mono text-[13px]'">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem :value="NO_SMALL_MODEL" class="font-sans">
            None (the first model)
          </SelectItem>
          <SelectItem v-for="id in smallOptions" :key="id" :value="id" class="font-mono text-[13px]">
            {{ id }}
          </SelectItem>
        </SelectContent>
      </Select>
      <p class="text-xs text-muted-foreground">
        A small, cheap model. Titles new chats and answers the connection test.
      </p>
    </div>
  </div>
</template>
