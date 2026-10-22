<script setup lang="ts">
// Settings → Web search, the page body (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 9.15, 10.10): "Web search in chats"
// ("Use the model's own web search when it has one" → `webSearchNative`, "Turn on web search in new chats" →
// `webSearchDefault`, through the settings store) and "Search API" (the backend select Brave Search · Tavily · Exa, one
// write-only key row per backend, Max results, Test search and its result line, through the web-search store, which
// writes `core-search`'s settings). Every Switch keeps the 40 px coarse-pointer hit area. Mounted by
// `pages/settings/search.vue` inside SettingsPage.
// No props, no emits; the root test id is frozen from Gate P14-0b (C54 stub); W14.10 implements the page.
// On mount it loads the settings (unless loaded) and the search API configuration (`fetch({ maxAgeMs: 15_000 })`); the
// sections render right away and a failed load shows SettingsLoadError with Retry. Switches and the select save on
// change, optimistically (a failure toasts and rolls back); Max results saves on blur or Enter (Esc restores). While
// `core-search` is turned off, the Search API section says so (with "Open plugin") and its controls are disabled. The
// page never shows a stored key, never searches on load (only Test search does) and never changes a chat's own choice.
import type { Settings, WebSearchBackend } from '@harness-forge/shared'
import { CircleAlertIcon, CircleCheckIcon, SearchIcon } from '@lucide/vue'
import { computed, onMounted, ref, useId } from 'vue'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { WEB_SEARCH_BACKEND_LABELS } from '~/components/chat/composer/web-search'
import { useSettingsStore } from '~/stores/settings'
import { useWebSearchStore } from '~/stores/web-search'
import { testIds } from '~/utils/testids'
import { blurTarget, cancelDraftEdit, useDraftField } from '../general'
import { toastError } from '../notify'
import SettingsLoadError from '../SettingsLoadError.vue'
import SettingsSection from '../SettingsSection.vue'
import {
  CORE_SEARCH_PLUGIN_PATH,
  keyRowOrder,
  MAX_RESULTS_MAX,
  parseMaxResults,
  testErrorText,
  testResultText,
  WEB_SEARCH_CONFIG_MAX_AGE_MS,
} from './web-search-settings'
import WebSearchKeyRow from './WebSearchKeyRow.vue'

const settings = useSettingsStore()
const webSearch = useWebSearchStore()
const resolved = computed(() => settings.resolved)
const config = computed(() => webSearch.config)

const ids = {
  native: useId(),
  defaultOn: useId(),
  backend: useId(),
  keys: useId(),
  maxResults: useId(),
  maxResultsError: useId(),
}

const BACKENDS = Object.keys(WEB_SEARCH_BACKEND_LABELS) as WebSearchBackend[]

// ---------- loading ----------

const loading = ref(false)
const loadError = ref<unknown>(null)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    await Promise.all([
      settings.loaded ? Promise.resolve() : settings.fetch(),
      webSearch.fetch({ maxAgeMs: WEB_SEARCH_CONFIG_MAX_AGE_MS }),
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

// ---------- Web search in chats (the settings store) ----------

async function saveSetting(patch: Partial<Settings>) {
  try {
    await settings.update(patch)
  }
  catch (error) {
    toastError(error)
  }
}

function onNative(value: boolean) {
  if (value !== resolved.value.webSearchNative)
    void saveSetting({ webSearchNative: value })
}

function onDefault(value: boolean) {
  const mode = value ? 'auto' : 'off'
  if (mode !== resolved.value.webSearchDefault)
    void saveSetting({ webSearchDefault: mode })
}

// ---------- Search API (the web-search store) ----------

/** The selected backend (Brave Search until the configuration loads). */
const backend = computed<WebSearchBackend>(() => config.value?.backend ?? 'brave')
const backendName = computed(() => WEB_SEARCH_BACKEND_LABELS[backend.value])
/** `core-search` is turned off (known only once loaded). */
const pluginOff = computed(() => config.value !== null && !config.value.pluginActive)
/** The Search API controls work only with a loaded configuration and `core-search` on. */
const apiDisabled = computed(() => config.value === null || !config.value.pluginActive)
const keyRows = computed(() => keyRowOrder(backend.value))
const selectedHasKey = computed(() => config.value?.keys[backend.value]?.set === true)

async function onBackend(value: unknown) {
  if (typeof value !== 'string' || !(BACKENDS as string[]).includes(value) || value === backend.value)
    return
  try {
    await webSearch.save({ backend: value as WebSearchBackend })
  }
  catch (error) {
    toastError(error)
  }
}

const maxResults = useDraftField(() => String(config.value?.maxResults ?? ''))

async function commitMaxResults() {
  maxResults.focused.value = false
  if (config.value === null)
    return
  const parsed = parseMaxResults(maxResults.draft.value)
  if ('error' in parsed) {
    maxResults.error.value = parsed.error
    return
  }
  maxResults.error.value = null
  maxResults.draft.value = String(parsed.value)
  if (parsed.value === config.value.maxResults)
    return
  try {
    await webSearch.save({ maxResults: parsed.value })
  }
  catch (error) {
    toastError(error)
    maxResults.restore()
  }
}

// ---------- Test search ----------

/** The backend of the last test this page ran (its result line shows only while that backend is selected). */
const testedBackend = ref<WebSearchBackend | null>(null)

const testDisabled = computed(() => apiDisabled.value || !selectedHasKey.value)

const testLine = computed<{ state: 'ok' | 'error', text: string } | null>(() => {
  if (webSearch.testing || testedBackend.value === null || testedBackend.value !== backend.value)
    return null
  if (webSearch.lastTest)
    return { state: 'ok', text: testResultText(webSearch.lastTest) }
  if (webSearch.testError)
    return { state: 'error', text: testErrorText(webSearch.testError, testedBackend.value) }
  return null
})

async function runTest() {
  if (testDisabled.value || webSearch.testing)
    return
  testedBackend.value = backend.value
  // The result line shows the outcome (and is announced); nothing else to report.
  await webSearch.test(backend.value).catch(() => {})
}
</script>

<template>
  <div :data-testid="testIds.webSearchSettings" class="flex flex-col">
    <SettingsLoadError
      v-if="loadError"
      title="Could not load the web search settings"
      :error="loadError"
      :pending="loading"
      class="mt-4"
      @retry="load"
    />

    <SettingsSection title="Web search in chats" description="Whether chats search the web and how.">
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel :for="ids.native">
              Use the model's own web search when it has one
            </FieldLabel>
            <FieldDescription>
              Anthropic, OpenAI, Google, xAI, OpenRouter and Groq (gpt-oss) models search with their provider. Off: chats
              always use the search API below. The provider bills its searches; they aren't in harness-forge's cost
              estimate.
            </FieldDescription>
          </FieldContent>
          <Switch
            :id="ids.native"
            :model-value="resolved.webSearchNative"
            :data-testid="testIds.settingsSearchNative"
            class="pointer-coarse:after:-inset-y-3"
            @update:model-value="onNative"
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel :for="ids.defaultOn">
              Turn on web search in new chats
            </FieldLabel>
            <FieldDescription>
              Each chat keeps its own choice (the Search button in the composer). A search sends your query to the
              model's provider or the search API.
            </FieldDescription>
          </FieldContent>
          <Switch
            :id="ids.defaultOn"
            :model-value="resolved.webSearchDefault === 'auto'"
            :data-testid="testIds.settingsSearchDefault"
            class="pointer-coarse:after:-inset-y-3"
            @update:model-value="onDefault"
          />
        </Field>
      </FieldGroup>
    </SettingsSection>

    <SettingsSection title="Search API" description="For models without their own search, or when the switch above is off.">
      <Alert v-if="pluginOff" data-slot="web-search-plugin-off" class="pr-32">
        <CircleAlertIcon aria-hidden="true" />
        <AlertDescription>
          The core-search plugin is turned off, so the search API isn't used.
        </AlertDescription>
        <AlertAction>
          <Button as-child type="button" size="xs" variant="outline" class="pointer-coarse:h-10">
            <NuxtLink :to="CORE_SEARCH_PLUGIN_PATH">
              Open plugin
            </NuxtLink>
          </Button>
        </AlertAction>
      </Alert>

      <FieldGroup>
        <Field orientation="responsive">
          <FieldLabel :for="ids.backend">
            Search API
          </FieldLabel>
          <Select :model-value="backend" :disabled="apiDisabled" @update:model-value="onBackend">
            <SelectTrigger
              :id="ids.backend"
              class="@md/field-group:w-48! pointer-coarse:data-[size=default]:h-10"
              :data-testid="testIds.settingsSearchBackend"
              :data-value="backend"
            >
              <span>{{ backendName }}</span>
            </SelectTrigger>
            <SelectContent position="popper" align="end" class="w-48">
              <SelectItem v-for="option in BACKENDS" :key="option" :value="option" :data-value="option">
                {{ WEB_SEARCH_BACKEND_LABELS[option] }}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>

      <div v-if="config" class="flex flex-col">
        <ul :id="ids.keys" aria-label="Search API keys" class="flex flex-col">
          <template v-for="(option, index) in keyRows" :key="option">
            <li v-if="index === 1" aria-hidden="true" class="mt-1 border-t border-border pt-4 pb-1 text-xs font-medium text-muted-foreground">
              Other search APIs
            </li>
            <WebSearchKeyRow
              :backend="option"
              :state="config.keys[option]"
              :disabled="apiDisabled"
              :class="index > 1 ? 'border-t border-border' : undefined"
            />
          </template>
        </ul>
      </div>
      <div v-else-if="!loadError" data-slot="web-search-keys-loading" class="flex flex-col gap-3 py-3" aria-hidden="true">
        <Skeleton v-for="row in 3" :key="row" class="h-9 w-full" />
      </div>

      <FieldGroup>
        <Field orientation="responsive" :data-invalid="maxResults.error.value ? true : undefined">
          <FieldContent>
            <FieldLabel :for="ids.maxResults">
              Max results
            </FieldLabel>
            <FieldDescription>Results per search (1–{{ MAX_RESULTS_MAX }}).</FieldDescription>
          </FieldContent>
          <div class="grid gap-1.5 @md/field-group:w-48!">
            <Input
              :id="ids.maxResults"
              v-model="maxResults.draft.value"
              inputmode="numeric"
              maxlength="2"
              autocomplete="off"
              class="tabular-nums pointer-coarse:h-10"
              :disabled="apiDisabled"
              :aria-invalid="maxResults.error.value ? true : undefined"
              :aria-describedby="maxResults.error.value ? ids.maxResultsError : undefined"
              :data-testid="testIds.settingsSearchMaxResults"
              @focus="maxResults.focused.value = true"
              @blur="commitMaxResults"
              @keydown.enter.prevent="blurTarget"
              @keydown.esc.prevent="cancelDraftEdit(maxResults, $event)"
            />
            <FieldError v-if="maxResults.error.value" :id="ids.maxResultsError" class="text-xs">
              {{ maxResults.error.value }}
            </FieldError>
          </div>
        </Field>
      </FieldGroup>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="testDisabled"
          :aria-busy="webSearch.testing || undefined"
          :data-testid="testIds.settingsSearchTest"
          class="pointer-coarse:h-10"
          @click="runTest"
        >
          <Spinner v-if="webSearch.testing" data-icon="inline-start" />
          <SearchIcon v-else aria-hidden="true" data-icon="inline-start" />
          Test search
        </Button>
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          :data-testid="testIds.settingsSearchTestResult"
          :data-state="testLine?.state"
          class="flex min-w-0 items-center gap-1.5 text-sm"
          :class="testLine?.state === 'error' ? 'text-destructive' : undefined"
        >
          <template v-if="testLine">
            <CircleCheckIcon v-if="testLine.state === 'ok'" aria-hidden="true" class="size-4 shrink-0 text-success" />
            <CircleAlertIcon v-else aria-hidden="true" class="size-4 shrink-0" />
            <span class="min-w-0 break-words">{{ testLine.text }}</span>
          </template>
        </p>
      </div>

      <p class="text-xs text-muted-foreground">
        Only your query, the number of results and the time filter go to {{ backendName }}. Queries and keys are never
        logged.
      </p>
    </SettingsSection>
  </div>
</template>
