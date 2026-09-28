<script setup lang="ts">
// Step 2 of the provider wizard (docs/UI.md 8.5, docs/PROVIDERS.md 9): templates (Together, Fireworks, LM Studio,
// vLLM, LiteLLM) that prefill everything, the API format, the base URL (warning for plain HTTP to another host) and,
// under Advanced, the reasoning control and the models.dev id.
import type { ApiFormat, ReasoningStyle } from '@harness-forge/shared'
import type { ProviderTemplate } from './provider-templates'
import { REASONING_STYLES_BY_API_FORMAT } from '@harness-forge/shared'
import { ChevronRightIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, useId } from 'vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { testIds } from '~/utils/testids'
import { useLobeIcons } from './lobe-icons'
import { PROVIDER_TEMPLATES } from './provider-templates'
import { API_FORMATS, apiFormatOption, applyTemplate, changeApiFormat, isBaseUrl, isPlainHttpRemote, providerIdOf, REASONING_STYLE_LABELS } from './wizard'
import { useWizardContext } from './wizard-context'

const { form, values, errorOf, touch, patch } = useWizardContext()
const lobe = useLobeIcons()
const ids = { templates: useId(), format: useId(), baseURL: useId(), baseHint: useId(), reasoning: useId(), modelsDev: useId() }

const format = computed(() => apiFormatOption(values.value.apiFormat))
const baseURL = computed(() => values.value.baseURL.trim().replace(/\/+$/, ''))
const insecure = computed(() => isBaseUrl(values.value.baseURL.trim()) && isPlainHttpRemote(values.value.baseURL.trim()))
const anthropicWithoutVersion = computed(() => values.value.apiFormat === 'anthropic' && isBaseUrl(baseURL.value) && !/\/v\d+(?:beta\d*)?$/.test(baseURL.value))
const reasoningStyles = computed<readonly ReasoningStyle[]>(() => REASONING_STYLES_BY_API_FORMAT[values.value.apiFormat])

function useTemplate(template: ProviderTemplate) {
  patch(applyTemplate(values.value, template))
}

function selectFormat(value: ApiFormat) {
  if (value !== values.value.apiFormat)
    patch(changeApiFormat(values.value, value))
}

function onFormatKeydown(event: KeyboardEvent) {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
  const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
  if (!forward && !backward)
    return
  event.preventDefault()
  const index = API_FORMATS.findIndex(option => option.value === values.value.apiFormat)
  const next = API_FORMATS[(index + (forward ? 1 : API_FORMATS.length - 1)) % API_FORMATS.length]
  if (!next)
    return
  selectFormat(next.value)
  const group = event.currentTarget as HTMLElement | null
  requestAnimationFrame(() => group?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus())
}

function setReasoningStyle(value: unknown) {
  if (typeof value === 'string' && (reasoningStyles.value as readonly string[]).includes(value))
    form.setFieldValue('reasoningStyle', value as ReasoningStyle)
}
</script>

<template>
  <div class="grid gap-6">
    <section class="grid gap-2" :aria-labelledby="ids.templates">
      <h3 :id="ids.templates" class="text-sm font-medium">
        Start from a template <span class="font-normal text-muted-foreground">(optional)</span>
      </h3>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <button
          v-for="template in PROVIDER_TEMPLATES"
          :key="template.id"
          type="button"
          :data-testid="testIds.wizardTemplate"
          :data-value="template.id"
          :aria-pressed="values.template === template.id"
          class="flex min-w-0 flex-col items-start gap-2 rounded-lg border bg-card p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:border-primary aria-pressed:bg-primary/5"
          @click="useTemplate(template)"
        >
          <ProviderIcon :id="template.id" :icon="template.icon ? lobe.iconOf(template.icon) : null" :name="template.name" variant="color" size="md" />
          <span class="grid min-w-0 gap-0.5">
            <span class="truncate text-sm font-medium">{{ template.name }}</span>
            <span class="truncate text-xs text-muted-foreground">{{ template.hint }}</span>
          </span>
        </button>
      </div>
    </section>

    <section class="grid gap-2">
      <h3 :id="ids.format" class="text-sm font-medium">
        API format
      </h3>
      <div role="radiogroup" :aria-labelledby="ids.format" class="grid gap-2 sm:grid-cols-2" @keydown="onFormatKeydown">
        <button
          v-for="option in API_FORMATS"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="values.apiFormat === option.value"
          :tabindex="values.apiFormat === option.value ? 0 : -1"
          :data-testid="testIds.wizardApiFormat"
          :data-value="option.value"
          class="group/format flex flex-col items-start gap-1 rounded-lg border bg-card p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-checked:border-primary aria-checked:bg-primary/5"
          @click="selectFormat(option.value)"
        >
          <span class="flex w-full items-center justify-between gap-2 text-sm font-medium">
            {{ option.label }}
            <span aria-hidden="true" class="flex size-4 shrink-0 items-center justify-center rounded-full border border-input group-aria-checked/format:border-primary">
              <span class="size-2 rounded-full bg-primary opacity-0 group-aria-checked/format:opacity-100" />
            </span>
          </span>
          <span class="text-xs text-muted-foreground">{{ option.description }}</span>
          <span class="font-mono text-[11px] text-muted-foreground/80">POST …{{ option.path }}</span>
        </button>
      </div>
    </section>

    <form.Field name="baseURL">
      <template #default="{ field, state }">
        <div class="grid gap-2">
          <Label :for="ids.baseURL">Base URL</Label>
          <Input
            :id="ids.baseURL"
            :model-value="state.value"
            type="url"
            inputmode="url"
            :placeholder="format.placeholder"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            data-wizard-autofocus
            :data-testid="testIds.wizardBaseUrl"
            :data-value="state.value"
            :aria-invalid="errorOf('baseURL') ? true : undefined"
            :aria-describedby="ids.baseHint"
            class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
            @update:model-value="value => field.handleChange(String(value))"
            @blur="touch('baseURL')"
          />
          <FieldError v-if="errorOf('baseURL')" :errors="[errorOf('baseURL')]" class="text-xs" />
          <p v-else :id="ids.baseHint" class="text-xs break-all text-muted-foreground">
            <template v-if="isBaseUrl(baseURL)">
              Chat requests go to <span class="font-mono text-foreground/80">{{ baseURL }}{{ format.path }}</span>
            </template>
            <template v-else>
              The address the API paths are appended to, usually ending in a version such as /v1.
            </template>
          </p>
          <p
            v-if="insecure"
            role="status"
            class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs dark:bg-warning/10"
          >
            <TriangleAlertIcon aria-hidden="true" class="mt-px size-3.5 shrink-0 text-warning" />
            <span>Plain HTTP to another computer sends your key and messages unencrypted. Use https:// unless the server is on your own network.</span>
          </p>
          <p v-if="anthropicWithoutVersion" class="text-xs text-muted-foreground">
            Anthropic-compatible base URLs include the version segment, for example <span class="font-mono">…/v1</span>.
          </p>
        </div>
      </template>
    </form.Field>

    <Collapsible class="rounded-lg border">
      <CollapsibleTrigger class="group/advanced flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRightIcon aria-hidden="true" class="size-4 text-muted-foreground transition-transform duration-(--duration-fast) group-data-[state=open]/advanced:rotate-90" />
        Advanced
        <span class="ml-auto truncate text-xs font-normal text-muted-foreground">
          {{ REASONING_STYLE_LABELS[values.reasoningStyle] }}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div class="grid gap-4 border-t px-3 py-4 sm:grid-cols-2">
          <div class="grid content-start gap-2">
            <Label :for="ids.reasoning">Reasoning control</Label>
            <Select :model-value="values.reasoningStyle" @update:model-value="setReasoningStyle">
              <SelectTrigger :id="ids.reasoning" class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem v-for="style in reasoningStyles" :key="style" :value="style">
                  {{ REASONING_STYLE_LABELS[style] }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              How the effort menu of reasoning models is sent. Mark reasoning models in the Models step.
            </p>
          </div>
          <form.Field name="modelsDevId">
            <template #default="{ field, state }">
              <div class="grid content-start gap-2">
                <Label :for="ids.modelsDev">models.dev id <span class="font-normal text-muted-foreground">(optional)</span></Label>
                <Input
                  :id="ids.modelsDev"
                  :model-value="state.value"
                  :placeholder="providerIdOf(values) || 'togetherai'"
                  autocomplete="off"
                  spellcheck="false"
                  class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                  :aria-invalid="errorOf('modelsDevId') ? true : undefined"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="touch('modelsDevId')"
                />
                <FieldError v-if="errorOf('modelsDevId')" :errors="[errorOf('modelsDevId')]" class="text-xs" />
                <p v-else class="text-xs text-muted-foreground">
                  Fills in context windows, capabilities and prices from models.dev.
                </p>
              </div>
            </template>
          </form.Field>
        </div>
      </CollapsibleContent>
    </Collapsible>
  </div>
</template>
