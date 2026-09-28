<script setup lang="ts">
// Header rows (HTTP / SSE) or environment rows (stdio) of McpServerDialog. Values are write-only secrets: a stored row
// keeps its name, starts with an empty password input whose placeholder is the masked hint, and an input left empty
// keeps the stored value. Presentational: the dialog owns the rows and applies `update` / `add` / `remove`.
import type { McpFormErrors, SecretRow } from './mcp-form'
import { PlusIcon, XIcon } from '@lucide/vue'
import { computed, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { rowKey, storedPlaceholder } from './mcp-form'

const props = withDefaults(defineProps<{
  kind: 'headers' | 'env'
  rows: readonly SecretRow[]
  errors: McpFormErrors
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  add: []
  remove: [uid: number]
  update: [uid: number, field: 'name' | 'value', value: string]
}>()

const headingId = useId()

const COPY = {
  headers: {
    label: 'Headers',
    add: 'Add header',
    empty: 'No headers.',
    namePlaceholder: 'Authorization',
    noun: 'header',
  },
  env: {
    label: 'Environment variables',
    add: 'Add variable',
    empty: 'No variables.',
    namePlaceholder: 'API_KEY',
    noun: 'variable',
  },
} as const

const copy = computed(() => COPY[props.kind])

function errorOf(row: SecretRow): string | undefined {
  return props.errors[rowKey(row)]
}

function label(row: SecretRow, what: 'name' | 'value' | 'remove'): string {
  const name = row.name.trim()
  if (what === 'name')
    return `${copy.value.noun === 'header' ? 'Header' : 'Variable'} name`
  if (what === 'value')
    return name ? `Value of ${name}` : `Value of the ${copy.value.noun}`
  return name ? `Remove ${name}` : `Remove ${copy.value.noun}`
}
</script>

<template>
  <div role="group" :aria-labelledby="headingId" :data-slot="`mcp-${kind}`" class="grid gap-2">
    <div class="flex min-h-6 items-center justify-between gap-3">
      <span :id="headingId" class="text-sm font-medium">{{ copy.label }}</span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        :disabled="disabled"
        :data-action="`add-${kind}`"
        @click="emit('add')"
      >
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        {{ copy.add }}
      </Button>
    </div>
    <p v-if="rows.length === 0" class="text-xs text-muted-foreground">
      {{ copy.empty }} Values are stored encrypted and never shown again.
    </p>
    <div
      v-for="row in rows"
      :key="row.uid"
      :data-slot="kind === 'env' ? 'mcp-env-row' : 'mcp-header-row'"
      :data-name="row.name"
      :data-stored="row.stored ? 'true' : 'false'"
      class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2"
    >
      <Input
        :model-value="row.name"
        :readonly="row.stored !== null"
        :disabled="disabled"
        :aria-label="label(row, 'name')"
        :aria-invalid="errorOf(row) ? true : undefined"
        data-field="row-name"
        :placeholder="copy.namePlaceholder"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        class="font-mono text-[13px] read-only:bg-muted/50 placeholder:font-sans placeholder:text-sm"
        @update:model-value="value => emit('update', row.uid, 'name', String(value))"
      />
      <Input
        :model-value="row.value"
        type="password"
        :disabled="disabled"
        :aria-label="label(row, 'value')"
        :aria-invalid="errorOf(row) ? true : undefined"
        data-field="row-value"
        :placeholder="row.stored ? storedPlaceholder(row.stored) : 'Value'"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        data-1p-ignore
        data-lpignore="true"
        class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
        @update:model-value="value => emit('update', row.uid, 'value', String(value))"
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        :disabled="disabled"
        :aria-label="label(row, 'remove')"
        data-action="remove-row"
        @click="emit('remove', row.uid)"
      >
        <XIcon aria-hidden="true" />
      </Button>
      <p v-if="errorOf(row)" role="alert" class="col-span-3 -mt-1 text-xs text-destructive">
        {{ errorOf(row) }}
      </p>
    </div>
  </div>
</template>
