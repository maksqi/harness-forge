<script setup lang="ts">
// Configuration tab (docs/UI.md 8.9): the plugin's settings from `GET /api/plugins/:id/settings` in SchemaForm; Save
// sends only what changed with `PUT /api/plugins/:id/settings` (secrets only when replaced or cleared) and starts the
// form over from the values the server returns. Stored secrets show their masked hint, never the value.
import type { PluginSettingsView } from '@harness-forge/shared'
import type { SettingsValues } from '../forms/schema-form'
import { CircleAlertIcon, SlidersHorizontalIcon } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { usePluginsStore } from '~/stores/plugins'
import { isAbortError, toHarnessError } from '~/utils/errors'
import { settingsFormValues, settingsPatch, storedSecretHints, storedSecretKeys } from '../forms/schema-form'
import SchemaForm from '../forms/SchemaForm.vue'

const props = defineProps<{ pluginId: string }>()

const plugins = usePluginsStore()

const view = ref<PluginSettingsView | null>(null)
const values = ref<SettingsValues>({})
const loading = ref(false)
const loadError = ref<unknown>(null)
const saving = ref(false)
const saveError = ref<string | null>(null)

const schema = computed(() => view.value?.schema ?? null)
const secretsSet = computed(() => (view.value ? storedSecretKeys(view.value) : []))
const secretHints = computed(() => (view.value ? storedSecretHints(view.value) : {}))
const loadMessage = computed(() => (loadError.value ? toHarnessError(loadError.value).message : ''))
const note = computed(() => {
  const hasSecrets = Object.values(schema.value?.properties ?? {}).some(property => property.type === 'string' && property.format === 'secret')
  return hasSecrets
    ? 'Changes apply when you save. Secret values are encrypted on this server and never shown again.'
    : 'Changes apply when you save.'
})

function show(next: PluginSettingsView) {
  view.value = next
  values.value = settingsFormValues(next)
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    show(await plugins.fetchSettings(props.pluginId))
  }
  catch (error) {
    if (!isAbortError(error))
      loadError.value = error
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.pluginId, () => {
  view.value = null
  void load()
})

async function save(submitted: SettingsValues) {
  const current = view.value
  if (!current?.schema || saving.value)
    return
  const patch = settingsPatch(current.schema, submitted, settingsFormValues(current))
  if (Object.keys(patch).length === 0)
    return
  saving.value = true
  saveError.value = null
  try {
    show(await plugins.saveSettings(props.pluginId, patch))
    toast.success('Settings saved')
  }
  catch (error) {
    saveError.value = toHarnessError(error).message
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex max-w-3xl flex-col gap-4">
    <div v-if="loading && !view" aria-busy="true" aria-label="Loading settings" class="divide-y divide-border overflow-hidden rounded-xl border bg-card">
      <div v-for="index in 3" :key="index" class="flex flex-col gap-2 px-4 py-4">
        <Skeleton class="h-3.5 w-32" />
        <Skeleton class="h-3 w-64" />
        <Skeleton class="mt-1 h-9 w-full" />
      </div>
    </div>

    <Alert v-else-if="loadError && !view" class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10">
      <CircleAlertIcon aria-hidden="true" class="text-destructive" />
      <AlertTitle>Could not load the settings</AlertTitle>
      <AlertDescription class="text-foreground/80">
        {{ loadMessage }}
      </AlertDescription>
      <div class="col-start-2 mt-2">
        <Button type="button" size="sm" variant="outline" :disabled="loading" @click="load">
          Retry
        </Button>
      </div>
    </Alert>

    <div v-else-if="view && !schema" class="flex items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
      <SlidersHorizontalIcon aria-hidden="true" class="size-4 shrink-0" />
      This plugin has no settings.
    </div>

    <template v-else-if="schema">
      <p class="text-sm text-muted-foreground">
        {{ note }}
      </p>
      <Alert v-if="saveError" class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10">
        <CircleAlertIcon aria-hidden="true" class="text-destructive" />
        <AlertTitle>Settings were not saved</AlertTitle>
        <AlertDescription class="text-foreground/80">
          {{ saveError }}
        </AlertDescription>
      </Alert>
      <SchemaForm
        v-model="values"
        :schema="schema"
        :secrets-set="secretsSet"
        :secret-hints="secretHints"
        :saving="saving"
        @submit="save"
      />
    </template>
  </div>
</template>
