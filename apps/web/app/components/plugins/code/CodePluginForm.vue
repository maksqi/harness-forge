<script setup lang="ts">
// Code plugin creation (docs/UI.md 8.6, 10.4): name, id (derived from the name until edited, checked like the server
// checks it) and one template card; Create plugin -> `POST /api/plugins/scaffold` (a fresh-auth route, useFreshAuth with
// `required`: a session that is not fresh gets ConfirmPasswordDialog first, a later `403 forbidden` + `action:
// 'login'` prompts and runs once more) -> toast -> `created(id)`. The page
// (W3.3) then navigates to `/plugins/<id>?tab=source`. Files are JavaScript ESM with JSDoc types (`index.mjs`, the
// default) or TypeScript (`index.ts`, compiled by the server; `language: 'ts'`).
import type { PluginTemplateId } from '@harness-forge/shared'
import type { CodePluginLanguage } from './code-plugin-form'
import { BlocksIcon, CircleCheckIcon, PlugIcon, TerminalSquareIcon, WrenchIcon } from '@lucide/vue'
import { RadioGroupIndicator, RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import { computed, onMounted, ref, useId, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { errorTitle } from '~/components/common/harness-error'
import { useApi } from '~/composables/useApi'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { CODE_LANGUAGES, CODE_TEMPLATES, PLUGIN_ID_MAX, PLUGIN_NAME_MAX, pluginIdProblem, pluginNameProblem, slugifyPluginId } from './code-plugin-form'

const emit = defineEmits<{
  created: [id: string]
  cancel: []
}>()

const api = useApi()
const plugins = usePluginsStore()
const freshAuth = useFreshAuth()

const TEMPLATE_ICONS: Record<PluginTemplateId, typeof WrenchIcon> = {
  'tool': WrenchIcon,
  'provider': PlugIcon,
  'mcp-bridge': BlocksIcon,
  'command-pack': TerminalSquareIcon,
}

const name = ref('')
const id = ref('')
const idEdited = ref(false)
const template = ref<PluginTemplateId | null>(null)
const language = ref<CodePluginLanguage>('js')
const submitted = ref(false)
const pending = ref(false)
/** Server answers that belong to a field (the id became taken meanwhile, a reserved id, ...). */
const serverErrors = ref<{ name?: string, id?: string }>({})

const nameId = useId()
const idId = useId()
const nameErrorId = useId()
const idErrorId = useId()
const templateLabelId = useId()
const languageLabelId = useId()
const languageHintId = useId()

const languageHint = computed(() => CODE_LANGUAGES.find(option => option.value === language.value)?.hint ?? '')

/** A single ToggleGroup emits an empty value when the active item is clicked again: keep the choice. */
function onLanguage(value: unknown) {
  if (value === 'js' || value === 'ts')
    language.value = value
}

onMounted(() => {
  if (!plugins.loaded)
    void plugins.fetchAll().catch(() => {})
})

// The id follows the name until the user edits it.
watch(name, (value) => {
  if (!idEdited.value)
    id.value = slugifyPluginId(value)
})

function onTemplate(value: unknown) {
  template.value = CODE_TEMPLATES.find(option => option.id === value)?.id ?? null
}

function onIdInput(value: string | number) {
  idEdited.value = true
  id.value = String(value).trim().toLowerCase()
}

watch([name, id, template], () => {
  serverErrors.value = {}
})

const nameProblem = computed(() => serverErrors.value.name ?? pluginNameProblem(name.value))
const idProblem = computed(() => serverErrors.value.id
  ?? pluginIdProblem(id.value, template.value, candidate => plugins.byId(candidate) !== undefined))
const templateProblem = computed(() => (template.value === null ? 'Choose a template.' : null))
const valid = computed(() => !nameProblem.value && !idProblem.value && !templateProblem.value)

/** Field messages show after the first submit, or as soon as a field has content. */
const shownNameError = computed(() => (submitted.value || name.value !== '' ? nameProblem.value : null))
const shownIdError = computed(() => (submitted.value || id.value !== '' ? idProblem.value : null))

async function submit() {
  submitted.value = true
  if (!valid.value || pending.value || template.value === null)
    return
  // `js` is the server default, so JavaScript requests stay as they were.
  const body = { id: id.value, name: name.value.trim(), template: template.value, ...(language.value === 'ts' ? { language: 'ts' as const } : {}) }
  pending.value = true
  try {
    const detail = await freshAuth.run(() => api.pluginFiles.scaffold({ body }), { required: true })
    void plugins.fetchAll().catch(() => {})
    toast.success(`Created ${detail.name}`)
    emit('created', detail.id)
  }
  catch (error) {
    if (isFreshAuthCancelled(error))
      return
    const failure = toHarnessError(error)
    const issuePath = (failure.details as { issues?: Array<{ path?: unknown[] }> } | undefined)?.issues?.[0]?.path?.[0]
    if (failure.code === 'conflict' || (failure.code === 'forbidden' && failure.action !== 'login') || issuePath === 'id')
      serverErrors.value = { id: failure.message }
    else if (issuePath === 'name')
      serverErrors.value = { name: failure.message }
    else
      toast.error(errorTitle(failure), { description: failure.message })
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <form
    :data-testid="testIds.codePluginForm"
    class="grid gap-6"
    novalidate
    @submit.prevent="submit"
  >
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="grid content-start gap-2">
        <Label :for="nameId">Name</Label>
        <Input
          :id="nameId"
          v-model="name"
          :maxlength="PLUGIN_NAME_MAX"
          autocomplete="off"
          placeholder="Weather tools"
          :aria-invalid="shownNameError ? true : undefined"
          :aria-describedby="shownNameError ? nameErrorId : undefined"
          :data-testid="testIds.codePluginName"
        />
        <p v-if="shownNameError" :id="nameErrorId" class="text-sm text-destructive">
          {{ shownNameError }}
        </p>
      </div>
      <div class="grid content-start gap-2">
        <Label :for="idId">Id</Label>
        <Input
          :id="idId"
          :model-value="id"
          :maxlength="PLUGIN_ID_MAX"
          autocomplete="off"
          spellcheck="false"
          placeholder="weather-tools"
          class="font-mono"
          :aria-invalid="shownIdError ? true : undefined"
          :aria-describedby="shownIdError ? idErrorId : `${idId}-hint`"
          :data-testid="testIds.codePluginId"
          @update:model-value="onIdInput"
        />
        <p v-if="shownIdError" :id="idErrorId" class="text-sm text-destructive">
          {{ shownIdError }}
        </p>
        <p v-else :id="`${idId}-hint`" class="text-sm text-muted-foreground">
          The folder name of the plugin. It cannot be changed later.
        </p>
      </div>
    </div>

    <div class="grid gap-3">
      <span :id="templateLabelId" class="text-sm font-medium">Template</span>
      <RadioGroupRoot
        :model-value="template"
        :aria-labelledby="templateLabelId"
        class="grid gap-3 sm:grid-cols-2"
        @update:model-value="onTemplate"
      >
        <RadioGroupItem
          v-for="option in CODE_TEMPLATES"
          :key="option.id"
          :value="option.id"
          :data-testid="testIds.codePluginTemplate"
          :data-value="option.id"
          :class="cn(
            'flex items-start gap-3 rounded-lg border bg-card p-4 text-left outline-none transition-colors',
            'hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'data-[state=checked]:border-primary data-[state=checked]:bg-primary/5',
          )"
        >
          <component :is="TEMPLATE_ICONS[option.id]" aria-hidden="true" class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <span class="grid flex-1 gap-1">
            <span class="font-medium">{{ option.label }}</span>
            <span class="text-sm text-muted-foreground">{{ option.description }}</span>
          </span>
          <RadioGroupIndicator class="shrink-0">
            <CircleCheckIcon aria-hidden="true" class="size-4 text-primary" />
          </RadioGroupIndicator>
        </RadioGroupItem>
      </RadioGroupRoot>
      <p v-if="submitted && templateProblem" class="text-sm text-destructive" role="alert">
        {{ templateProblem }}
      </p>
    </div>

    <div class="grid gap-2">
      <span :id="languageLabelId" class="text-sm font-medium">Language</span>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ToggleGroup
          type="single"
          variant="outline"
          :model-value="language"
          :disabled="pending"
          :aria-labelledby="languageLabelId"
          :aria-describedby="languageHintId"
          :data-testid="testIds.codePluginLanguage"
          :data-value="language"
          @update:model-value="onLanguage"
        >
          <ToggleGroupItem v-for="option in CODE_LANGUAGES" :key="option.value" :value="option.value" :data-value="option.value">
            {{ option.label }}
          </ToggleGroupItem>
        </ToggleGroup>
        <p :id="languageHintId" class="text-sm text-muted-foreground">
          {{ languageHint }}
        </p>
      </div>
      <p class="text-sm text-muted-foreground">
        Plugins created here are trusted to run code on this server.
      </p>
    </div>

    <div class="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" :disabled="pending" @click="emit('cancel')">
        Cancel
      </Button>
      <Button type="submit" :disabled="pending || (submitted && !valid)" :aria-busy="pending || undefined" :data-testid="testIds.codePluginCreate">
        <Spinner v-if="pending" data-icon="inline-start" />
        Create plugin
      </Button>
    </div>

    <ConfirmPasswordDialog
      :open="freshAuth.open.value"
      :pending="freshAuth.pending.value"
      :error="freshAuth.error.value"
      description="Creating a plugin that runs code needs your password."
      @update:open="freshAuth.setOpen"
      @submit="freshAuth.submit"
    />
  </form>
</template>
