<script setup lang="ts">
// Step 3 of the provider wizard (docs/UI.md 8.5, docs/PLUGINS.md 4 "auth" and "headers"): the auth style (Bearer /
// custom header / none), the credential fields of the key dialog, extra headers with `{{credentials.<key>}}`
// placeholders, and the values used to test the draft (stored as encrypted provider credentials on create, never in
// plugin.json). Declarative providers cannot read environment variables, so fields have no env var.
import type { CredentialField } from '@harness-forge/shared'
import type { AuthStyle, WizardCredentialField } from './wizard'
import { ChevronDownIcon, EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { computed, nextTick, reactive, ref, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { testIds } from '~/utils/testids'
import { changeAuthStyle, emptyCredentialField, splitOptions } from './wizard'
import { useWizardContext } from './wizard-context'

const { form, values, editing, errorOf, touch, patch } = useWizardContext()
const ids = { auth: useId(), header: useId(), fields: useId(), headers: useId(), testing: useId() }

const AUTH_STYLES = [
  { value: 'bearer', label: 'Bearer token' },
  { value: 'header', label: 'Custom header' },
  { value: 'none', label: 'None' },
] as const

const FIELD_TYPES: ReadonlyArray<{ value: CredentialField['type'], label: string }> = [
  { value: 'secret', label: 'Secret' },
  { value: 'text', label: 'Text' },
  { value: 'url', label: 'URL' },
  { value: 'select', label: 'Choice' },
]

/** Rendered as text: a literal would be read as a template interpolation. */
const PLACEHOLDER_EXAMPLE = '{{credentials.<key>}}'

const expanded = reactive(new Set<number>())
const revealed = reactive(new Set<string>())
const fieldList = ref<HTMLElement | null>(null)
const headerList = ref<HTMLElement | null>(null)

const authExplanation = computed(() => {
  const current = values.value
  if (current.authStyle === 'bearer')
    return 'Sends Authorization: Bearer followed by the API key.'
  if (current.authStyle === 'header')
    return `Sends the API key as the ${current.authHeader.trim() || '…'} header.`
  return 'Sends no key. For other schemes (Authorization: Token …), add an extra header with a placeholder.'
})

const placeholders = computed(() => values.value.credentials.map(field => field.key.trim()).filter(key => key !== '').map(key => `{{credentials.${key}}}`))

function setAuthStyle(value: unknown) {
  if (value === 'bearer' || value === 'header' || value === 'none')
    patch(changeAuthStyle(values.value, value as AuthStyle))
}

function setCredential<K extends keyof WizardCredentialField>(index: number, key: K, value: WizardCredentialField[K]) {
  const list = values.value.credentials.map((field, position) => (position === index ? { ...field, [key]: value } : field))
  form.setFieldValue('credentials', list)
}

function renameCredential(index: number, next: string) {
  const previous = values.value.credentials[index]?.key.trim() ?? ''
  setCredential(index, 'key', next)
  // The value typed for testing follows the field.
  const entered = values.value.credentialValues[previous]
  if (previous !== '' && entered !== undefined && next.trim() !== '' && !(next.trim() in values.value.credentialValues)) {
    const { [previous]: _moved, ...rest } = values.value.credentialValues
    form.setFieldValue('credentialValues', { ...rest, [next.trim()]: entered })
  }
}

function setType(index: number, type: unknown) {
  if (type !== 'secret' && type !== 'text' && type !== 'url' && type !== 'select')
    return
  setCredential(index, 'type', type)
  if (type === 'secret')
    setCredential(index, 'default', '')
  if (type === 'select')
    expanded.add(index)
}

async function addField() {
  form.pushFieldValue('credentials', emptyCredentialField())
  await nextTick()
  fieldList.value?.querySelector<HTMLElement>('[data-slot="credential-row"]:last-child input')?.focus()
}

function removeField(index: number) {
  void form.removeFieldValue('credentials', index)
  expanded.delete(index)
}

async function addHeader() {
  form.pushFieldValue('headers', { name: '', value: '' })
  await nextTick()
  headerList.value?.querySelector<HTMLElement>('[data-slot="header-row"]:last-child input')?.focus()
}

function setHeader(index: number, key: 'name' | 'value', value: string) {
  form.setFieldValue('headers', values.value.headers.map((header, position) => (position === index ? { ...header, [key]: value } : header)))
}

function setTestValue(key: string, value: string) {
  form.setFieldValue('credentialValues', { ...values.value.credentialValues, [key]: value })
}

function isExpanded(index: number, field: WizardCredentialField): boolean {
  return expanded.has(index) || field.type === 'select'
    || ['helpUrl', 'default', 'options'].some(key => Boolean(errorOf(`credentials.${index}.${key}`)))
}

function toggleExpanded(index: number) {
  if (expanded.has(index))
    expanded.delete(index)
  else
    expanded.add(index)
}
</script>

<template>
  <div class="grid gap-7">
    <section class="grid gap-3">
      <h3 :id="ids.auth" class="text-sm font-medium">
        Authentication
      </h3>
      <ToggleGroup
        type="single"
        variant="outline"
        :model-value="values.authStyle"
        :aria-labelledby="ids.auth"
        :data-testid="testIds.wizardAuthStyle"
        :data-value="values.authStyle"
        class="w-full sm:w-fit"
        @update:model-value="setAuthStyle"
      >
        <ToggleGroupItem
          v-for="(style, index) in AUTH_STYLES"
          :key="style.value"
          :value="style.value"
          :data-value="style.value"
          :data-wizard-autofocus="index === 0 ? '' : undefined"
          class="flex-1 px-3 text-muted-foreground data-[state=on]:bg-primary/15 data-[state=on]:text-foreground sm:flex-none"
        >
          {{ style.label }}
        </ToggleGroupItem>
      </ToggleGroup>
      <div v-if="values.authStyle === 'header'" class="grid max-w-sm gap-2">
        <Label :for="ids.header">Header name</Label>
        <Input
          :id="ids.header"
          :model-value="values.authHeader"
          placeholder="x-api-key"
          autocomplete="off"
          spellcheck="false"
          class="font-mono text-[13px]"
          :aria-invalid="errorOf('authHeader') ? true : undefined"
          @update:model-value="value => form.setFieldValue('authHeader', String(value))"
          @blur="touch('authHeader')"
        />
        <FieldError :errors="[errorOf('authHeader')]" class="text-xs" />
      </div>
      <p class="text-xs text-muted-foreground">
        {{ authExplanation }}
      </p>
    </section>

    <section class="grid gap-3" :aria-labelledby="ids.fields">
      <div class="flex items-end justify-between gap-3">
        <div>
          <h3 :id="ids.fields" class="text-sm font-medium">
            Credential fields
          </h3>
          <p class="text-xs text-muted-foreground">
            What the key dialog in Settings asks for. The field with the key <span class="font-mono">apiKey</span> is the key the authentication sends.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" @click="addField">
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Add field
        </Button>
      </div>

      <p v-if="values.credentials.length === 0" class="rounded-lg border border-dashed px-4 py-4 text-center text-sm text-muted-foreground">
        No credential fields. The provider is shown as local, with no key.
      </p>
      <div v-else ref="fieldList" class="grid gap-2">
        <div
          v-for="(field, index) in values.credentials"
          :key="index"
          data-slot="credential-row"
          :data-testid="testIds.wizardCredentialRow"
          :data-value="field.key"
          class="grid gap-3 rounded-lg border bg-card p-3"
        >
          <div class="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_8rem_auto_auto]">
            <div class="grid gap-1">
              <Label :for="`${ids.fields}-key-${index}`" class="text-xs text-muted-foreground">Key</Label>
              <Input
                :id="`${ids.fields}-key-${index}`"
                :model-value="field.key"
                placeholder="apiKey"
                autocomplete="off"
                spellcheck="false"
                class="h-8 font-mono text-[13px]"
                :aria-invalid="errorOf(`credentials.${index}.key`) ? true : undefined"
                @update:model-value="value => renameCredential(index, String(value))"
                @blur="touch(`credentials.${index}.key`)"
              />
              <FieldError :errors="[errorOf(`credentials.${index}.key`)]" class="text-xs" />
            </div>
            <div class="grid gap-1">
              <Label :for="`${ids.fields}-label-${index}`" class="text-xs text-muted-foreground">Label</Label>
              <Input
                :id="`${ids.fields}-label-${index}`"
                :model-value="field.label"
                placeholder="API key"
                autocomplete="off"
                class="h-8"
                :aria-invalid="errorOf(`credentials.${index}.label`) ? true : undefined"
                @update:model-value="value => setCredential(index, 'label', String(value))"
                @blur="touch(`credentials.${index}.label`)"
              />
              <FieldError :errors="[errorOf(`credentials.${index}.label`)]" class="text-xs" />
            </div>
            <div class="grid gap-1">
              <Label :for="`${ids.fields}-type-${index}`" class="text-xs text-muted-foreground">Type</Label>
              <Select :model-value="field.type" @update:model-value="value => setType(index, value)">
                <SelectTrigger :id="`${ids.fields}-type-${index}`" size="sm" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem v-for="type in FIELD_TYPES" :key="type.value" :value="type.value">
                    {{ type.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Label class="mt-0 flex h-8 items-center gap-2 font-normal sm:mt-5">
              <Checkbox :model-value="field.required" @update:model-value="value => setCredential(index, 'required', value === true)" />
              Required
            </Label>
            <div class="flex items-center gap-1 sm:mt-5">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                :aria-label="isExpanded(index, field) ? 'Fewer options' : 'More options'"
                :aria-expanded="isExpanded(index, field)"
                :title="isExpanded(index, field) ? 'Fewer options' : 'More options'"
                @click="toggleExpanded(index)"
              >
                <ChevronDownIcon aria-hidden="true" class="transition-transform" :class="isExpanded(index, field) && 'rotate-180'" />
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" :aria-label="`Remove ${field.label || field.key || 'field'}`" title="Remove field" @click="removeField(index)">
                <Trash2Icon aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div v-if="isExpanded(index, field)" class="grid gap-3 border-t pt-3 sm:grid-cols-2">
            <div v-if="field.type === 'select'" class="grid gap-1 sm:col-span-2">
              <Label :for="`${ids.fields}-options-${index}`" class="text-xs text-muted-foreground">Options (comma-separated)</Label>
              <Input
                :id="`${ids.fields}-options-${index}`"
                :model-value="field.options"
                placeholder="us, eu"
                class="h-8"
                :aria-invalid="errorOf(`credentials.${index}.options`) ? true : undefined"
                @update:model-value="value => setCredential(index, 'options', String(value))"
                @blur="touch(`credentials.${index}.options`)"
              />
              <FieldError :errors="[errorOf(`credentials.${index}.options`)]" class="text-xs" />
            </div>
            <div class="grid gap-1">
              <Label :for="`${ids.fields}-help-${index}`" class="text-xs text-muted-foreground">"Get a key" link</Label>
              <Input
                :id="`${ids.fields}-help-${index}`"
                :model-value="field.helpUrl"
                type="url"
                placeholder="https://example.com/keys"
                class="h-8 font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                :aria-invalid="errorOf(`credentials.${index}.helpUrl`) ? true : undefined"
                @update:model-value="value => setCredential(index, 'helpUrl', String(value))"
                @blur="touch(`credentials.${index}.helpUrl`)"
              />
              <FieldError :errors="[errorOf(`credentials.${index}.helpUrl`)]" class="text-xs" />
            </div>
            <div v-if="field.type !== 'secret'" class="grid gap-1">
              <Label :for="`${ids.fields}-default-${index}`" class="text-xs text-muted-foreground">Default</Label>
              <Input
                :id="`${ids.fields}-default-${index}`"
                :model-value="field.default"
                :placeholder="field.type === 'select' ? splitOptions(field.options)[0] ?? '' : ''"
                class="h-8"
                :aria-invalid="errorOf(`credentials.${index}.default`) ? true : undefined"
                @update:model-value="value => setCredential(index, 'default', String(value))"
                @blur="touch(`credentials.${index}.default`)"
              />
              <FieldError :errors="[errorOf(`credentials.${index}.default`)]" class="text-xs" />
            </div>
            <Label class="flex items-center gap-2 font-normal sm:col-span-2">
              <Checkbox :model-value="field.advanced" @update:model-value="value => setCredential(index, 'advanced', value === true)" />
              Show under "Advanced" in the key dialog
            </Label>
          </div>
        </div>
      </div>
      <FieldError :errors="[errorOf('credentials')]" class="text-xs" />
    </section>

    <section class="grid gap-3" :aria-labelledby="ids.headers">
      <div class="flex items-end justify-between gap-3">
        <div>
          <h3 :id="ids.headers" class="text-sm font-medium">
            Extra headers <span class="font-normal text-muted-foreground">(optional)</span>
          </h3>
          <p class="text-xs text-muted-foreground">
            Sent with every request. Values may use
            <template v-if="placeholders.length === 0">
              <span class="font-mono">{{ PLACEHOLDER_EXAMPLE }}</span>
            </template>
            <template v-for="(placeholder, index) in placeholders" v-else :key="placeholder">
              <span class="font-mono text-foreground/80 select-all">{{ placeholder }}</span><template v-if="index < placeholders.length - 1">
                ,
              </template>
            </template>.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" @click="addHeader">
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Add header
        </Button>
      </div>
      <div v-if="values.headers.length > 0" ref="headerList" class="grid gap-2">
        <div
          v-for="(header, index) in values.headers"
          :key="index"
          data-slot="header-row"
          :data-testid="testIds.wizardHeaderRow"
          :data-value="header.name"
          class="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto]"
        >
          <div class="grid gap-1">
            <Input
              :model-value="header.name"
              placeholder="X-Team"
              aria-label="Header name"
              autocomplete="off"
              spellcheck="false"
              class="h-8 font-mono text-[13px]"
              :aria-invalid="errorOf(`headers.${index}.name`) ? true : undefined"
              @update:model-value="value => setHeader(index, 'name', String(value))"
              @blur="touch(`headers.${index}.name`)"
            />
            <FieldError :errors="[errorOf(`headers.${index}.name`)]" class="text-xs" />
          </div>
          <div class="grid gap-1">
            <Input
              :model-value="header.value"
              :placeholder="placeholders[0] ?? 'value'"
              aria-label="Header value"
              autocomplete="off"
              spellcheck="false"
              class="h-8 font-mono text-[13px]"
              :aria-invalid="errorOf(`headers.${index}.value`) ? true : undefined"
              @update:model-value="value => setHeader(index, 'value', String(value))"
              @blur="touch(`headers.${index}.value`)"
            />
            <FieldError :errors="[errorOf(`headers.${index}.value`)]" class="text-xs" />
          </div>
          <Button type="button" size="icon-sm" variant="ghost" :aria-label="`Remove header ${header.name}`" title="Remove header" @click="form.removeFieldValue('headers', index)">
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>

    <section v-if="values.credentials.length > 0" class="grid gap-3" :aria-labelledby="ids.testing">
      <div>
        <h3 :id="ids.testing" class="text-sm font-medium">
          Values for testing
        </h3>
        <p class="text-xs text-muted-foreground">
          <template v-if="editing">
            Used by Fetch models and Test connection. Values you enter are saved to the provider's credentials when you save.
          </template>
          <template v-else>
            Used by Fetch models and Test connection, then stored encrypted as the provider's credentials when you create it. Never written to plugin.json or kept in the draft.
          </template>
        </p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div v-for="field in values.credentials.filter(item => item.key.trim() !== '')" :key="field.key" class="grid content-start gap-2">
          <Label :for="`${ids.testing}-${field.key}`">
            {{ field.label || field.key }}
            <span v-if="!field.required" class="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <InputGroup v-if="field.type === 'secret'">
            <InputGroupInput
              :id="`${ids.testing}-${field.key}`"
              :model-value="values.credentialValues[field.key.trim()] ?? ''"
              :type="revealed.has(field.key) ? 'text' : 'password'"
              :data-testid="testIds.wizardCredentialValue"
              :data-value="field.key"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              data-1p-ignore
              data-lpignore="true"
              class="font-mono text-[13px]"
              :aria-invalid="errorOf(`credentialValues.${field.key.trim()}`) ? true : undefined"
              @update:model-value="(value: string | number) => setTestValue(field.key.trim(), String(value))"
              @blur="touch(`credentialValues.${field.key.trim()}`)"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                :aria-label="revealed.has(field.key) ? 'Hide value' : 'Show value'"
                :aria-pressed="revealed.has(field.key)"
                :disabled="!values.credentialValues[field.key.trim()]"
                @click="revealed.has(field.key) ? revealed.delete(field.key) : revealed.add(field.key)"
              >
                <EyeOffIcon v-if="revealed.has(field.key)" aria-hidden="true" />
                <EyeIcon v-else aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <Select
            v-else-if="field.type === 'select'"
            :model-value="values.credentialValues[field.key.trim()] ?? ''"
            @update:model-value="value => setTestValue(field.key.trim(), String(value ?? ''))"
          >
            <SelectTrigger :id="`${ids.testing}-${field.key}`" class="w-full" :data-testid="testIds.wizardCredentialValue" :data-value="field.key">
              <SelectValue :placeholder="field.default || 'Choose…'" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem v-for="option in splitOptions(field.options)" :key="option" :value="option">
                {{ option }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            v-else
            :id="`${ids.testing}-${field.key}`"
            :model-value="values.credentialValues[field.key.trim()] ?? ''"
            :type="field.type === 'url' ? 'url' : 'text'"
            :placeholder="field.default"
            :data-testid="testIds.wizardCredentialValue"
            :data-value="field.key"
            autocomplete="off"
            spellcheck="false"
            :class="field.type === 'url' ? 'font-mono text-[13px]' : undefined"
            :aria-invalid="errorOf(`credentialValues.${field.key.trim()}`) ? true : undefined"
            @update:model-value="value => setTestValue(field.key.trim(), String(value))"
            @blur="touch(`credentialValues.${field.key.trim()}`)"
          />
          <FieldError :errors="[errorOf(`credentialValues.${field.key.trim()}`)]" class="text-xs" />
        </div>
      </div>
    </section>
  </div>
</template>
