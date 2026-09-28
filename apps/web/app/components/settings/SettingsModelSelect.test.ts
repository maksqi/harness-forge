import type { CatalogModel, ProviderSummary } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { testIds } from '~/utils/testids'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import SettingsModelSelect from './SettingsModelSelect.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const openai = providerSummary({ id: 'openai', name: 'OpenAI (ChatGPT)' })
const groq = providerSummary({ id: 'groq', name: 'Groq' })
const mistral = providerSummary({ id: 'mistral', name: 'Mistral AI', status: 'not_configured' })

const catalog: CatalogModel[] = [
  catalogModel({ providerId: 'openai', id: 'gpt-5', name: 'GPT-5' }),
  catalogModel({ providerId: 'openai', id: 'gpt-5-mini', name: 'GPT-5 mini', hidden: true }),
  catalogModel({ providerId: 'openai', id: 'gpt-image-1', name: 'GPT Image 1', kind: 'image' }),
  catalogModel({ providerId: 'openai', id: 'dall-e-2', name: 'DALL-E 2', kind: 'image', hidden: true }),
  catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe', kind: 'transcription', hidden: true }),
  catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS', kind: 'speech', hidden: true }),
  catalogModel({ providerId: 'openai', id: 'tts-1', name: 'TTS 1', kind: 'speech', hidden: false }),
  catalogModel({ providerId: 'openai', id: 'text-embedding-3-small', kind: 'embedding' }),
  catalogModel({ providerId: 'groq', id: 'whisper-large-v3-turbo', name: 'Whisper large v3 turbo', kind: 'transcription', hidden: true }),
  catalogModel({ providerId: 'groq', id: 'llama-4-scout', name: 'Llama 4 Scout' }),
  catalogModel({ providerId: 'mistral', id: 'voxtral-mini-latest', name: 'Voxtral mini', kind: 'transcription', hidden: true }),
]

let pinia: ReturnType<typeof createPinia>

function seed(providers: ProviderSummary[], models: CatalogModel[], loaded = true) {
  useProvidersStore().items = providers
  useProvidersStore().loaded = true
  useModelsStore().items = models
  useModelsStore().loaded = loaded
}

beforeEach(() => {
  mock.api = createMockApi()
  pinia = createPinia()
  setActivePinia(pinia)
  stubLocalStorage()
  seed([groq, openai, mistral], catalog)
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

interface SelectProps {
  kind?: 'chat' | 'image' | 'transcription' | 'speech'
  allowNone?: boolean
  noneLabel?: string
  initial?: string | null
}

/** Mounts a v-model bound select (the value lives in `value`) and returns the trigger. */
async function mountSelect(props: SelectProps = {}) {
  const value = ref<string | null>(props.initial ?? null)
  const changes: Array<string | null> = []
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(SettingsModelSelect, {
        'modelValue': value.value,
        'kind': props.kind,
        'allowNone': props.allowNone,
        'noneLabel': props.noneLabel,
        'label': 'Model',
        'data-testid': testIds.settingsImageModel,
        'onUpdate:modelValue': (next: string | null) => {
          changes.push(next)
          value.value = next
        },
      }),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  const trigger = document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.settingsImageModel}"]`)!
  return { wrapper, trigger, value, changes }
}

async function open(trigger: HTMLElement) {
  trigger.click()
  await flushPromises()
}

function option(modelRef: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"][data-model-ref="${modelRef}"]`)
}

function optionRefs(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"]`)]
    .map(option => option.dataset.modelRef ?? '')
}

function groupHeadings(): string[] {
  return [...document.body.querySelectorAll('[data-slot="command-group-heading"]')].map(heading => heading.textContent?.trim() ?? '')
}

function emptyText(): string | null {
  return document.body.querySelector('[data-slot="model-select-empty"]')?.textContent?.trim() ?? null
}

describe('settingsModelSelect', () => {
  it('lists the visible chat models of connected providers by default', async () => {
    const { trigger } = await mountSelect()
    expect(trigger.dataset.kind).toBe('chat')
    await open(trigger)
    // Hidden chat models, other kinds (even visible ones) and disconnected providers are left out.
    expect(optionRefs()).toEqual(['groq:llama-4-scout', 'openai:gpt-5'])
    expect(groupHeadings()).toEqual(['Groq', 'OpenAI (ChatGPT)'])
    expect(document.body.querySelector('[data-slot="command-input"]')).not.toBeNull()
  })

  it('lists the visible image models for kind="image"', async () => {
    const { trigger } = await mountSelect({ kind: 'image', allowNone: true, noneLabel: 'None (the generate_image tool is off)' })
    expect(trigger.dataset.value).toBe('')
    expect(trigger.textContent).toContain('None (the generate_image tool is off)')
    await open(trigger)
    expect(optionRefs()).toEqual(['', 'openai:gpt-image-1'])
  })

  it('lists every speech-to-text model of connected providers, hidden ones included', async () => {
    const { trigger } = await mountSelect({ kind: 'transcription', allowNone: true, noneLabel: 'Off' })
    await open(trigger)
    expect(optionRefs()).toEqual(['', 'groq:whisper-large-v3-turbo', 'openai:gpt-4o-mini-transcribe'])
    expect(groupHeadings()).toEqual(['Groq', 'OpenAI (ChatGPT)'])
  })

  it('lists every text-to-speech model and emits the choice', async () => {
    const { trigger, changes } = await mountSelect({ kind: 'speech', allowNone: true, noneLabel: 'Off' })
    await open(trigger)
    expect(optionRefs()).toEqual(['', 'openai:gpt-4o-mini-tts', 'openai:tts-1'])
    option('openai:gpt-4o-mini-tts')!.click()
    await flushPromises()
    expect(changes).toEqual(['openai:gpt-4o-mini-tts'])
    expect(trigger.dataset.value).toBe('openai:gpt-4o-mini-tts')
    expect(trigger.getAttribute('aria-label')).toBe('Model, GPT-4o mini TTS')

    await open(trigger)
    expect(option('openai:gpt-4o-mini-tts')!.dataset.checked).toBe('true')
    option('')!.click()
    await flushPromises()
    expect(changes).toEqual(['openai:gpt-4o-mini-tts', null])
    expect(trigger.getAttribute('aria-label')).toBe('Model, Off')
  })

  it('says so when no connected provider has a model of the kind, without a search field', async () => {
    seed([groq, openai], catalog.filter(model => model.kind !== 'image'))
    const { trigger } = await mountSelect({ kind: 'image', allowNone: true, noneLabel: 'None (the generate_image tool is off)' })
    await open(trigger)
    expect(optionRefs()).toEqual([''])
    expect(emptyText()).toBe('No image models from your connected providers.')
    expect(document.body.querySelector('[data-slot="command-input"]')).toBeNull()
  })

  it('says "Loading models…" until the catalog arrives', async () => {
    seed([groq, openai], [], false)
    const { trigger } = await mountSelect({ kind: 'speech' })
    await open(trigger)
    expect(emptyText()).toBe('Loading models…')

    useModelsStore().items = catalog
    useModelsStore().loaded = true
    await flushPromises()
    expect(emptyText()).toBeNull()
    expect(optionRefs()).toEqual(['openai:gpt-4o-mini-tts', 'openai:tts-1'])
  })
})
