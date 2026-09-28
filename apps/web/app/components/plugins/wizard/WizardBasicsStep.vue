<script setup lang="ts">
// Step 1 of the provider wizard (docs/UI.md 8.5): name, id (slug of the name until edited; pattern, reserved ids and
// installed plugins checked live), icon (upload / LobeHub / monogram) and description.
import type { IconRef } from '@harness-forge/shared'
import { ImageUpIcon, XIcon } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { testIds } from '~/utils/testids'
import { useLobeIcons } from './lobe-icons'
import LobeIconPicker from './LobeIconPicker.vue'
import { iconPreviewUrl, providerIdOf, readIconFile, slugify } from './wizard'
import { useWizardContext } from './wizard-context'

const { form, values, issues, editing, errorOf, touch, existingIcon } = useWizardContext()
const lobe = useLobeIcons()

const ids = { name: useId(), id: useId(), idHint: useId(), description: useId(), icon: useId() }
const fileInput = ref<HTMLInputElement | null>(null)
const fileError = ref<string | null>(null)
const dragging = ref(false)

const ICON_MODES = [
  { value: 'upload', label: 'Upload' },
  { value: 'lobe', label: 'LobeHub' },
  { value: 'monogram', label: 'Monogram' },
] as const

function onName(value: string | number, handleChange: (value: string) => void) {
  const name = String(value)
  handleChange(name)
  if (!editing.value && !values.value.idEdited)
    form.setFieldValue('id', slugify(name), { dontUpdateMeta: true })
}

function onId(value: string | number, handleChange: (value: string) => void) {
  const id = String(value).toLowerCase().replace(/\s+/g, '-')
  handleChange(id)
  form.setFieldValue('idEdited', id !== '', { dontUpdateMeta: true })
}

/** The id is derived live from the name: conflicts show as soon as there is an id. */
const idError = computed(() => (values.value.id !== '' && !editing.value ? issues.value.id : errorOf('id')))
const modelRefHint = computed(() => `${providerIdOf(values.value) || 'my-provider'}:model-id`)

const previewIcon = computed<IconRef>(() => {
  const current = values.value
  if (current.iconMode === 'upload')
    return current.iconFile ? { color: iconPreviewUrl(current.iconFile) } : existingIcon.value
  if (current.iconMode === 'lobe' && current.lobeSlug !== '')
    return lobe.iconOf(current.lobeSlug)
  return null
})

function setIconMode(mode: unknown) {
  if (mode === 'upload' || mode === 'lobe' || mode === 'monogram')
    form.setFieldValue('iconMode', mode)
}

async function takeFile(file: File | undefined) {
  if (!file)
    return
  fileError.value = null
  try {
    form.setFieldValue('iconFile', await readIconFile(file))
    touch('icon')
  }
  catch (error) {
    fileError.value = error instanceof Error ? error.message : 'The file cannot be read.'
  }
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  void takeFile(input.files?.[0])
  input.value = ''
}

function onDrop(event: DragEvent) {
  dragging.value = false
  void takeFile(event.dataTransfer?.files[0])
}

function removeFile() {
  form.setFieldValue('iconFile', null)
  fileError.value = null
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}
</script>

<template>
  <div class="grid gap-6">
    <div class="grid gap-4 sm:grid-cols-2">
      <form.Field name="name">
        <template #default="{ field, state }">
          <div class="grid content-start gap-2">
            <Label :for="ids.name">Name</Label>
            <Input
              :id="ids.name"
              :model-value="state.value"
              placeholder="Together AI"
              autocomplete="off"
              data-wizard-autofocus
              :data-testid="testIds.wizardName"
              :aria-invalid="errorOf('name') ? true : undefined"
              @update:model-value="value => onName(value, field.handleChange)"
              @blur="touch('name')"
            />
            <FieldError :errors="[errorOf('name')]" class="text-xs" />
          </div>
        </template>
      </form.Field>

      <form.Field name="id">
        <template #default="{ field, state }">
          <div class="grid content-start gap-2">
            <Label :for="ids.id">Id</Label>
            <Input
              :id="ids.id"
              :model-value="state.value"
              :readonly="editing"
              placeholder="together-ai"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              :data-testid="testIds.wizardId"
              :aria-invalid="idError ? true : undefined"
              :aria-describedby="ids.idHint"
              class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm read-only:bg-muted/50 read-only:text-muted-foreground"
              @update:model-value="value => onId(value, field.handleChange)"
              @blur="touch('id')"
            />
            <FieldError v-if="idError" :errors="[idError]" class="text-xs" />
            <p v-else :id="ids.idHint" class="text-xs text-muted-foreground">
              <template v-if="editing">
                The id of a plugin cannot change.
              </template>
              <template v-else>
                Model refs look like <span class="font-mono text-foreground/80">{{ modelRefHint }}</span>
              </template>
            </p>
          </div>
        </template>
      </form.Field>
    </div>

    <div class="grid gap-2">
      <Label :id="ids.icon">Icon</Label>
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div class="flex shrink-0 items-center gap-3 sm:w-28 sm:flex-col sm:items-center">
          <div class="flex size-16 items-center justify-center rounded-xl border bg-muted/30">
            <ProviderIcon :id="providerIdOf(values) || values.name" :icon="previewIcon" :name="values.name || 'Provider'" variant="color" size="lg" />
          </div>
          <p class="text-xs text-muted-foreground sm:text-center">
            Preview
          </p>
        </div>

        <Tabs :model-value="values.iconMode" class="min-w-0 flex-1" :aria-labelledby="ids.icon" @update:model-value="setIconMode">
          <TabsList class="w-full sm:w-fit">
            <TabsTrigger
              v-for="mode in ICON_MODES"
              :key="mode.value"
              :value="mode.value"
              :data-testid="testIds.wizardIconTab"
              :data-value="mode.value"
            >
              {{ mode.label }}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upload" class="mt-3">
            <div
              class="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors"
              :class="dragging ? 'border-primary bg-primary/5' : errorOf('icon') ? 'border-destructive' : 'border-border'"
              @dragover.prevent="dragging = true"
              @dragleave="dragging = false"
              @drop.prevent="onDrop"
            >
              <template v-if="values.iconFile">
                <p class="text-sm">
                  <span class="font-mono">{{ values.iconFile.name }}</span>
                  <span class="text-muted-foreground"> · {{ formatSize(values.iconFile.size) }}</span>
                </p>
                <div class="flex gap-2">
                  <Button type="button" size="sm" variant="outline" @click="fileInput?.click()">
                    Replace…
                  </Button>
                  <Button type="button" size="sm" variant="ghost" @click="removeFile">
                    <XIcon data-icon="inline-start" aria-hidden="true" />
                    Remove
                  </Button>
                </div>
              </template>
              <template v-else>
                <ImageUpIcon aria-hidden="true" class="size-5 text-muted-foreground" />
                <p class="text-sm">
                  Drop an SVG or PNG here, or
                  <button type="button" class="rounded-sm font-medium text-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50" @click="fileInput?.click()">
                    choose a file
                  </button>
                </p>
                <p v-if="values.iconExisting" class="text-xs text-muted-foreground">
                  Keeps the current <span class="font-mono">{{ values.iconExisting }}</span> until you choose another file.
                </p>
              </template>
              <input
                ref="fileInput"
                type="file"
                class="sr-only"
                tabindex="-1"
                aria-hidden="true"
                accept=".svg,.png,image/svg+xml,image/png"
                @change="onFileChange"
              >
            </div>
            <p class="mt-2 text-xs text-muted-foreground">
              Up to 256 KB. SVG files are cleaned of scripts and external references on the server.
            </p>
            <FieldError :errors="[fileError ?? undefined, errorOf('icon')]" class="mt-1 text-xs" />
          </TabsContent>

          <TabsContent value="lobe" class="mt-3">
            <LobeIconPicker
              :model-value="values.lobeSlug"
              :invalid="Boolean(errorOf('icon'))"
              @update:model-value="slug => { form.setFieldValue('lobeSlug', slug); touch('icon') }"
            />
            <FieldError :errors="[errorOf('icon')]" class="mt-1 text-xs" />
          </TabsContent>

          <TabsContent value="monogram" class="mt-3">
            <p class="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              The first letters of the name on a colored tile. Nothing to upload.
            </p>
          </TabsContent>
        </Tabs>
      </div>
    </div>

    <form.Field name="description">
      <template #default="{ field, state }">
        <div class="grid gap-2">
          <Label :for="ids.description">
            Description <span class="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            :id="ids.description"
            :model-value="state.value"
            rows="2"
            placeholder="Open models through the Together AI API."
            class="min-h-16 resize-y"
            :aria-invalid="errorOf('description') ? true : undefined"
            @update:model-value="value => field.handleChange(String(value))"
            @blur="touch('description')"
          />
          <FieldError :errors="[errorOf('description')]" class="text-xs" />
        </div>
      </template>
    </form.Field>
  </div>
</template>
