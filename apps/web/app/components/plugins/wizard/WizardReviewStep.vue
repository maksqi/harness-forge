<script setup lang="ts">
// Step 5 of the provider wizard (docs/UI.md 8.5): a summary, the read-only manifest JSON (exactly what plugin.json will
// contain; credentials are never part of it) and "Test connection": a 1-token ping of the small or first model through
// `POST /api/plugins/drafts/test` ("Connected · 412 ms" or the error). Create / Save lives in the wizard footer.
import type { DraftTestResult } from '@harness-forge/shared'
import { CheckCircle2Icon, PlugZapIcon } from '@lucide/vue'
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import CopyButton from '~/components/common/CopyButton.vue'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { useApi } from '~/composables/useApi'
import { testIds } from '~/utils/testids'
import { useLobeIcons } from './lobe-icons'
import {
  apiFormatOption,
  authSummary,
  buildTestRequest,
  enteredCredentials,
  iconPreviewUrl,
  manifestJson,
  pingModelId,
  providerIdOf,
  REASONING_STYLE_LABELS,
} from './wizard'
import { useWizardContext } from './wizard-context'
import WizardErrorAlert from './WizardErrorAlert.vue'

const WizardManifestView = defineAsyncComponent(() => import('./WizardManifestView.vue'))

const { values, base, editing, fetched, existingIcon } = useWizardContext()
const api = useApi()
const lobe = useLobeIcons()

const testing = ref(false)
const result = ref<DraftTestResult | null>(null)
const failure = ref<unknown>(null)

const manifest = computed(() => manifestJson(values.value, base.value))
const pingTarget = computed(() => pingModelId(values.value, fetched.value ?? []))
const status = computed(() => (testing.value ? 'running' : failure.value || result.value?.ok === false ? 'error' : result.value?.ok ? 'ok' : 'idle'))
const entered = computed(() => Object.keys(enteredCredentials(values.value)))
/** Required fields without a value: the provider shows "Not configured" until they are entered in Settings. */
const missingRequired = computed(() => values.value.credentials.filter(field => field.required && !entered.value.includes(field.key.trim())))

const icon = computed(() => {
  const current = values.value
  if (current.iconMode === 'upload')
    return current.iconFile ? { color: iconPreviewUrl(current.iconFile) } : existingIcon.value
  if (current.iconMode === 'lobe' && current.lobeSlug !== '')
    return lobe.iconOf(current.lobeSlug)
  return null
})

const listing = computed(() => {
  const current = values.value
  if (!current.listModels)
    return 'Off: only the models above'
  const filters = [current.listInclude && `include ${current.listInclude}`, current.listExclude && `exclude ${current.listExclude}`].filter(Boolean)
  return filters.length > 0 ? `On (${filters.join(', ')})` : 'On'
})

// A result belongs to the configuration it tested.
watch(manifest, () => {
  result.value = null
  failure.value = null
})

async function testConnection() {
  testing.value = true
  result.value = null
  failure.value = null
  try {
    const target = pingTarget.value
    result.value = await api.pluginDrafts.test({
      body: target === null ? buildTestRequest(values.value, 'list-models') : buildTestRequest(values.value, 'ping', target),
    })
  }
  catch (error) {
    failure.value = error
  }
  finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="grid gap-6">
    <section class="grid gap-4 rounded-lg border bg-card p-4" aria-label="Summary">
      <div class="flex items-center gap-3">
        <ProviderIcon :id="providerIdOf(values)" :icon="icon" :name="values.name || 'Provider'" variant="color" size="lg" />
        <div class="min-w-0">
          <p class="truncate font-medium">
            {{ values.name }}
          </p>
          <p class="truncate font-mono text-xs text-muted-foreground">
            {{ providerIdOf(values) }}:model-id
          </p>
        </div>
      </div>
      <p v-if="values.description.trim()" class="text-sm text-muted-foreground">
        {{ values.description.trim() }}
      </p>
      <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt class="text-muted-foreground">
          API
        </dt>
        <dd class="min-w-0">
          {{ apiFormatOption(values.apiFormat).label }} · <span class="font-mono text-[13px] break-all">{{ values.baseURL.trim() }}</span>
        </dd>
        <dt class="text-muted-foreground">
          Authentication
        </dt>
        <dd>{{ authSummary(values) }}</dd>
        <dt class="text-muted-foreground">
          Credentials
        </dt>
        <dd>
          <template v-if="values.credentials.length === 0">
            None (local provider)
          </template>
          <template v-else>
            {{ values.credentials.map(field => field.label || field.key).join(', ') }}
            <span class="text-muted-foreground">
              · {{ entered.length === 0 ? 'none entered' : editing ? `${entered.length} entered, saved on save` : `${entered.length} entered, stored encrypted on create` }}
            </span>
            <span v-if="missingRequired.length > 0 && !editing" class="mt-1 block text-xs text-muted-foreground">
              {{ missingRequired.map(field => field.label || field.key).join(', ') }} {{ missingRequired.length === 1 ? 'is' : 'are' }} still empty: the provider stays "Not configured" until you enter {{ missingRequired.length === 1 ? 'it' : 'them' }} in Credentials or later in Settings.
            </span>
          </template>
        </dd>
        <template v-if="values.headers.length > 0">
          <dt class="text-muted-foreground">
            Extra headers
          </dt>
          <dd class="font-mono text-[13px]">
            {{ values.headers.map(header => header.name).join(', ') }}
          </dd>
        </template>
        <dt class="text-muted-foreground">
          Models
        </dt>
        <dd>
          {{ values.models.length }} in the manifest · runtime list {{ listing }}
        </dd>
        <dt class="text-muted-foreground">
          Reasoning
        </dt>
        <dd>{{ REASONING_STYLE_LABELS[values.reasoningStyle] }}</dd>
      </dl>
    </section>

    <section class="grid gap-2">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-medium">
          Manifest <span class="font-mono text-xs font-normal text-muted-foreground">plugin.json</span>
        </h3>
        <CopyButton :text="manifest" label="Copy manifest" size="sm" />
      </div>
      <div :data-testid="testIds.wizardManifest" class="hf-scroll-stable max-h-96 overflow-auto rounded-lg border bg-muted/30">
        <WizardManifestView :json="manifest" />
      </div>
      <p class="text-xs text-muted-foreground">
        Credentials are not part of the manifest: they are stored encrypted as the provider's credentials.
      </p>
    </section>

    <section class="grid gap-3 rounded-lg border p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="grid gap-0.5">
          <h3 class="text-sm font-medium">
            Test connection
          </h3>
          <p class="text-xs text-muted-foreground">
            <template v-if="pingTarget">
              Sends a 1-token request to <span class="font-mono text-foreground/80">{{ pingTarget }}</span>.
            </template>
            <template v-else>
              No model to ping yet: lists the models instead.
            </template>
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          :disabled="testing"
          :aria-busy="testing || undefined"
          :data-testid="testIds.wizardTest"
          data-wizard-autofocus
          @click="testConnection"
        >
          <Spinner v-if="testing" data-icon="inline-start" />
          <PlugZapIcon v-else data-icon="inline-start" aria-hidden="true" />
          Test connection
        </Button>
      </div>
      <div :data-testid="testIds.wizardTestResult" :data-status="status" role="status" aria-live="polite">
        <p v-if="result?.ok" class="flex items-center gap-2 text-sm">
          <CheckCircle2Icon aria-hidden="true" class="size-4 text-success" />
          <span>
            Connected · {{ result.latencyMs }} ms
            <template v-if="result.models"> · {{ result.models.length }} {{ result.models.length === 1 ? 'model' : 'models' }}</template>
          </span>
          <span v-if="result.output" class="min-w-0 truncate text-muted-foreground">· replied "{{ result.output }}"</span>
        </p>
        <WizardErrorAlert
          v-else-if="result && !result.ok"
          :error="{ error: result.error ?? { code: 'provider_error', message: 'The test failed.' } }"
          :provider-name="values.name || undefined"
        />
        <WizardErrorAlert v-else-if="failure" :error="failure" />
      </div>
    </section>
  </div>
</template>
