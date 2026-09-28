import type { PluginManifest } from '@harness-forge/shared'
import type { WizardValues } from './wizard'
import { draftTestRequestSchema, pluginDraftSchema, pluginManifestUpdateSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubLocalStorage } from '~/utils/testing/storage'
import { PROVIDER_TEMPLATES, templateById } from './provider-templates'
import {
  applyTemplate,
  buildDraft,
  buildManifest,
  buildManifestUpdate,
  buildProvider,
  buildTestRequest,
  changeApiFormat,
  changeAuthStyle,
  clearWizardDraft,
  defaultWizardValues,
  emptyModel,
  firstInvalidStep,
  hasDraftContent,
  isPlainHttpRemote,
  issuesOfStep,
  loadWizardDraft,
  parsePrice,
  parseTokenCount,
  pingModelId,
  saveWizardDraft,
  slugify,
  stepOfPath,
  validateWizard,
  valuesFromManifest,
  WIZARD_DRAFT_KEY,
  wizardPathOfIssue,
} from './wizard'

const NO_IDS = { existingIds: new Set<string>(), editing: false }

/** Values that pass every step: a Together-style provider with one model. */
function completeValues(overrides: Partial<WizardValues> = {}): WizardValues {
  return {
    ...applyTemplate({ ...defaultWizardValues(), name: 'Acme AI', id: 'acme-ai' }, templateById('together-ai')!),
    models: [{ ...emptyModel('acme/large'), name: 'Acme Large', contextWindow: '128K', tools: true, reasoning: true, efforts: ['high', 'low'], inputCost: '0.60', outputCost: '$2' }],
    credentialValues: { apiKey: 'sk-acme-secret-value' },
    ...overrides,
  }
}

describe('small helpers', () => {
  it('slugifies names into plugin ids', () => {
    expect(slugify('Together AI')).toBe('together-ai')
    expect(slugify('  LM Studio!! ')).toBe('lm-studio')
    expect(slugify('Crème brûlée API')).toBe('creme-brulee-api')
    expect(slugify('--x--')).toBe('x')
    expect(slugify(`${'a'.repeat(39)}-bcd`)).toBe('a'.repeat(39))
    expect(slugify('')).toBe('')
  })

  it('parses token counts and prices', () => {
    expect(parseTokenCount('128000')).toBe(128_000)
    expect(parseTokenCount('128K')).toBe(128_000)
    expect(parseTokenCount('1.5m')).toBe(1_500_000)
    expect(parseTokenCount('0')).toBeNull()
    expect(parseTokenCount('lots')).toBeNull()
    expect(parsePrice('0.60')).toBe(0.6)
    expect(parsePrice('$2')).toBe(2)
    expect(parsePrice('-1')).toBeNull()
    expect(parsePrice('free')).toBeNull()
  })

  it('flags plain HTTP to other hosts only', () => {
    expect(isPlainHttpRemote('http://192.168.1.20:8000/v1')).toBe(true)
    expect(isPlainHttpRemote('http://gpu.example.com/v1')).toBe(true)
    expect(isPlainHttpRemote('http://localhost:1234/v1')).toBe(false)
    expect(isPlainHttpRemote('http://127.0.0.1:8000/v1')).toBe(false)
    expect(isPlainHttpRemote('http://[::1]:8000/v1')).toBe(false)
    expect(isPlainHttpRemote('https://api.example.com/v1')).toBe(false)
    expect(isPlainHttpRemote('not a url')).toBe(false)
  })
})

describe('templates', () => {
  it('prefills every template as documented and each one is valid with a model', () => {
    for (const template of PROVIDER_TEMPLATES) {
      const values = applyTemplate(defaultWizardValues(), template)
      expect(values.name, template.id).toBe(template.name)
      expect(values.id).toBe(template.id)
      expect(values.baseURL).toBe(template.baseURL)
      expect(values.iconMode).toBe(template.icon ? 'lobe' : 'monogram')
      const withModel = { ...values, models: [emptyModel('some-model')] }
      expect(validateWizard(withModel, NO_IDS), template.id).toEqual({})
      expect(pluginDraftSchema.safeParse(buildDraft(withModel)).success).toBe(true)
    }
  })

  it('together AI: bearer key, filtered listing, effort reasoning, models.dev id, icon', () => {
    const provider = buildProvider(applyTemplate(defaultWizardValues(), templateById('together-ai')!))
    expect(provider).toEqual({
      id: 'together-ai',
      name: 'Together AI',
      baseURL: 'https://api.together.xyz/v1',
      apiFormat: 'openai-chat',
      auth: { type: 'bearer' },
      credentials: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true, helpUrl: 'https://api.together.ai/settings/api-keys' }],
      listModels: { exclude: 'embed|rerank|whisper|flux|stable-diffusion|tts|guard' },
      reasoningStyle: 'openai-effort',
      modelsDevId: 'togetherai',
    })
  })

  it('lM Studio needs no key, vLLM and LiteLLM take an optional one', () => {
    const lmstudio = buildProvider(applyTemplate(defaultWizardValues(), templateById('lmstudio')!))
    expect(lmstudio).toMatchObject({ auth: { type: 'none' }, credentials: [], baseURL: 'http://localhost:1234/v1', listModels: true })
    for (const id of ['vllm', 'litellm']) {
      const provider = buildProvider(applyTemplate(defaultWizardValues(), templateById(id)!))
      expect(provider.credentials, id).toEqual([{ key: 'apiKey', label: 'API key', type: 'secret' }])
    }
  })

  it('keeps a name, id and icon the user already chose', () => {
    const values = { ...defaultWizardValues(), name: 'My gateway', id: 'my-gateway', iconMode: 'lobe' as const, lobeSlug: 'openai' }
    const next = applyTemplate(values, templateById('fireworks')!)
    expect(next).toMatchObject({ name: 'My gateway', id: 'my-gateway', lobeSlug: 'openai', baseURL: 'https://api.fireworks.ai/inference/v1', modelsDevId: 'fireworks-ai' })
  })
})

describe('api format and auth style', () => {
  it('switching to Anthropic moves a default auth to x-api-key and the reasoning control to thinking', () => {
    const next = changeApiFormat(completeValues(), 'anthropic')
    expect(next).toMatchObject({ apiFormat: 'anthropic', authStyle: 'header', authHeader: 'x-api-key', reasoningStyle: 'anthropic-thinking' })
    const google = changeApiFormat(next, 'google')
    expect(google).toMatchObject({ authStyle: 'header', authHeader: 'x-goog-api-key', reasoningStyle: 'google-thinking' })
  })

  it('keeps a custom auth style', () => {
    const custom = { ...completeValues(), authStyle: 'header' as const, authHeader: 'api-key' }
    expect(changeApiFormat(custom, 'anthropic')).toMatchObject({ authStyle: 'header', authHeader: 'api-key' })
    const none = { ...completeValues(), authStyle: 'none' as const }
    expect(changeApiFormat(none, 'anthropic').authStyle).toBe('none')
  })

  it('none drops the untouched key field; bearer brings it back', () => {
    const none = changeAuthStyle(defaultWizardValues(), 'none')
    expect(none.credentials).toEqual([])
    const bearer = changeAuthStyle(none, 'bearer')
    expect(bearer.credentials.map(field => field.key)).toEqual(['apiKey'])
    const edited = { ...defaultWizardValues(), credentials: [{ ...defaultWizardValues().credentials[0]!, label: 'Token' }] }
    expect(changeAuthStyle(edited, 'none').credentials).toHaveLength(1)
  })
})

describe('validation', () => {
  it('reports the empty wizard on the first steps', () => {
    const issues = validateWizard(defaultWizardValues(), NO_IDS)
    expect(issues).toMatchObject({ name: 'Enter a name.', id: 'Enter an id.', baseURL: 'Enter the base URL of the API.' })
    expect(firstInvalidStep(issues)).toBe('basics')
    expect(issuesOfStep(issues, 'api').map(([path]) => path)).toEqual(['baseURL'])
  })

  it('checks the id: pattern, reserved, taken; not in edit mode', () => {
    expect(validateWizard(completeValues({ id: 'Bad_Id' }), NO_IDS).id).toMatch(/1-40 characters/)
    expect(validateWizard(completeValues({ id: 'openai' }), NO_IDS).id).toBe('"openai" is reserved for built-in plugins.')
    expect(validateWizard(completeValues({ id: 'core-x' }), NO_IDS).id).toMatch(/reserved/)
    expect(validateWizard(completeValues(), { existingIds: new Set(['acme-ai']), editing: false }).id).toBe('A plugin with this id already exists.')
    expect(validateWizard(completeValues(), { existingIds: new Set(['acme-ai']), editing: true }).id).toBeUndefined()
  })

  it('needs the chosen icon', () => {
    expect(validateWizard(completeValues({ iconMode: 'upload' }), NO_IDS).icon).toBe('Choose an SVG or PNG file.')
    expect(validateWizard(completeValues({ iconMode: 'lobe', lobeSlug: '' }), NO_IDS).icon).toBe('Pick an icon.')
    expect(validateWizard(completeValues({ iconMode: 'upload', iconFile: { name: 'icon.png', base64: 'iVBORw0KGgo=', size: 8 } }), NO_IDS)).toEqual({})
  })

  it('checks the base URL', () => {
    for (const baseURL of ['api.example.com', 'ftp://x.example.com', 'https://api.example.com/v1?x=1', 'https://user:pw@api.example.com'])
      expect(validateWizard(completeValues({ baseURL }), NO_IDS).baseURL, baseURL).toBeDefined()
  })

  it('checks credentials, auth and headers', () => {
    const values = completeValues({
      credentials: [
        { key: 'token', label: 'Token', type: 'secret', required: true, default: '', options: '', helpUrl: 'nope', advanced: false },
        { key: 'token', label: '', type: 'select', required: false, default: 'z', options: 'a, b', helpUrl: '', advanced: false },
      ],
      headers: [
        { name: 'Authorization', value: 'x' },
        { name: 'X-Team', value: '{{credentials.team}}' },
        { name: 'Cookie', value: 'a' },
        { name: 'bad header', value: '{{settings.x}}' },
      ],
    })
    const issues = validateWizard(values, NO_IDS)
    expect(issues).toMatchObject({
      'credentials': expect.stringContaining('"apiKey"'),
      'credentials.0.helpUrl': expect.stringContaining('URL'),
      'credentials.1.key': 'This key is already used.',
      'credentials.1.label': 'Enter a label.',
      'credentials.1.default': 'The default must be one of the options.',
      'headers.0.name': 'The authentication already sends this header.',
      'headers.1.value': 'Unknown credential "team".',
      'headers.2.name': '"Cookie" cannot be set.',
      'headers.3.name': expect.stringContaining('header name'),
      'headers.3.value': 'Only {{credentials.<key>}} placeholders are allowed.',
    })
    expect(Object.keys(issues).every(path => stepOfPath(path) === 'credentials')).toBe(true)
  })

  it('accepts a custom scheme through none + a templated header', () => {
    const values = completeValues({
      authStyle: 'none',
      credentials: [{ key: 'token', label: 'Token', type: 'secret', required: true, default: '', options: '', helpUrl: '', advanced: false }],
      headers: [{ name: 'Authorization', value: 'Token {{credentials.token}}' }],
      credentialValues: { token: 'abc' },
    })
    expect(validateWizard(values, NO_IDS)).toEqual({})
    expect(buildProvider(values).headers).toEqual({ Authorization: 'Token {{credentials.token}}' })
  })

  it('checks models and the runtime listing', () => {
    const issues = validateWizard(completeValues({
      models: [
        { ...emptyModel('a'), contextWindow: 'big', inputCost: 'free' },
        emptyModel('a'),
        emptyModel(''),
      ],
      listExclude: '(',
    }), NO_IDS)
    expect(issues).toMatchObject({
      'models.0.contextWindow': expect.stringContaining('tokens'),
      'models.0.inputCost': expect.stringContaining('price'),
      'models.1.id': 'This model is already listed.',
      'models.2.id': 'Enter the model id.',
      'listExclude': 'Enter a valid regular expression.',
    })
    expect(validateWizard(completeValues({ models: [], listModels: false }), NO_IDS).models).toMatch(/at least one model/)
    expect(validateWizard(completeValues({ models: [], listModels: true }), NO_IDS)).toEqual({})
  })
})

describe('manifest and requests', () => {
  it('builds a draft the server schema accepts, with the key outside the manifest', () => {
    const draft = buildDraft(completeValues())
    expect(pluginDraftSchema.safeParse(draft).success).toBe(true)
    expect(draft.credentials).toEqual({ 'acme-ai': { apiKey: 'sk-acme-secret-value' } })
    expect(JSON.stringify(draft.manifest)).not.toContain('sk-acme-secret-value')
    expect(draft.manifest).toMatchObject({ manifestVersion: 1, id: 'acme-ai', name: 'Acme AI', version: '1.0.0', icon: 'lobe:together', engines: { harness: '^1.0.0' } })
    expect(draft.manifest.contributes?.providers?.[0]?.models).toEqual([{
      id: 'acme/large',
      name: 'Acme Large',
      contextWindow: 128_000,
      capabilities: { tools: true, vision: false, reasoning: true, pdf: false },
      reasoningEfforts: ['low', 'high'],
      cost: { input: 0.6, output: 2 },
    }])
  })

  it('includes the uploaded icon and omits empty credentials', () => {
    const draft = buildDraft(completeValues({ iconMode: 'upload', iconFile: { name: 'icon.svg', base64: 'PHN2Zy8+', size: 6 }, credentialValues: { apiKey: '  ' } }))
    expect(draft.iconFile).toEqual({ name: 'icon.svg', base64: 'PHN2Zy8+' })
    expect(draft.manifest.icon).toBe('icon.svg')
    expect(draft.credentials).toBeUndefined()
  })

  it('builds draft test requests', () => {
    const values = completeValues()
    const list = buildTestRequest(values, 'list-models')
    expect(draftTestRequestSchema.safeParse(list).success).toBe(true)
    expect(list).toMatchObject({ action: 'list-models', credentials: { apiKey: 'sk-acme-secret-value' } })
    expect(buildTestRequest(values, 'ping', 'acme/large')).toMatchObject({ action: 'ping', modelId: 'acme/large' })
    expect(pingModelId(values)).toBe('acme/large')
    expect(pingModelId({ ...values, smallModelId: 'acme/small' })).toBe('acme/small')
    expect(pingModelId({ ...values, models: [] }, [{ id: 'fetched' }])).toBe('fetched')
    expect(pingModelId({ ...values, models: [] })).toBeNull()
  })

  it('round-trips an existing manifest in edit mode and keeps what the wizard does not edit', () => {
    const base: PluginManifest = {
      manifestVersion: 1,
      id: 'acme-ai',
      name: 'Acme AI',
      version: '2.1.0',
      author: 'Acme',
      icon: 'icon.png',
      engines: { harness: '^1.0.0' },
      contributes: {
        providers: [{
          id: 'acme-ai-chat',
          name: 'Acme AI',
          baseURL: 'https://api.acme.example/anthropic/v1',
          apiFormat: 'anthropic',
          headers: { 'anthropic-beta': 'tools-2024' },
          listModels: { path: '/v1/models', include: 'claude' },
          models: [{ id: 'acme-1', contextWindow: 200_000, capabilities: { tools: true }, reasoningEfforts: ['low', 'max'] }],
          smallModelId: 'acme-1',
        }],
        commands: [{ name: 'acme', description: 'Ask Acme', template: '{{input}}' }],
      },
    }
    const values = valuesFromManifest(base)
    expect(values).toMatchObject({
      providerId: 'acme-ai-chat',
      iconMode: 'upload',
      iconExisting: 'icon.png',
      authStyle: 'header',
      authHeader: 'x-api-key',
      reasoningStyle: 'none',
      listPath: '/v1/models',
      listInclude: 'claude',
      headers: [{ name: 'anthropic-beta', value: 'tools-2024' }],
    })
    const update = buildManifestUpdate({ ...values, description: 'Edited' }, base)
    expect(pluginManifestUpdateSchema.safeParse(update).success).toBe(true)
    expect(update.iconFile).toBeUndefined()
    expect(update.manifest).toMatchObject({
      version: '2.1.0',
      author: 'Acme',
      description: 'Edited',
      icon: 'icon.png',
      contributes: {
        commands: base.contributes!.commands,
        providers: [{ id: 'acme-ai-chat', listModels: { path: '/v1/models', include: 'claude' }, smallModelId: 'acme-1' }],
      },
    })
    expect(update.manifest.contributes?.providers?.[0]?.models?.[0]).toMatchObject({ id: 'acme-1', contextWindow: 200_000, reasoningEfforts: ['low', 'max'] })
    expect(validateWizard(values, { existingIds: new Set(['acme-ai']), editing: true, base })).toEqual({})
  })

  it('manifest keys come out in the documented order', () => {
    expect(Object.keys(buildManifest(completeValues({ description: 'Hi' })))).toEqual(['manifestVersion', 'id', 'name', 'version', 'description', 'icon', 'engines', 'contributes'])
  })

  it('maps schema issue paths to wizard fields', () => {
    const values = completeValues({ headers: [{ name: 'X-A', value: 'x' }] })
    expect(wizardPathOfIssue(['manifest', 'contributes', 'providers', 0, 'baseURL'], values)).toBe('baseURL')
    expect(wizardPathOfIssue(['manifest', 'contributes', 'providers', 0, 'credentials', 1, 'options'], values)).toBe('credentials.1.options')
    expect(wizardPathOfIssue(['manifest', 'contributes', 'providers', 0, 'headers', 'X-A'], values)).toBe('headers.0.value')
    expect(wizardPathOfIssue(['manifest', 'contributes', 'providers', 0, 'models', 2, 'cost', 'input'], values)).toBe('models.2.inputCost')
    expect(wizardPathOfIssue(['credentials', 'acme-ai', 'apiKey'], values)).toBe('credentialValues.apiKey')
    expect(wizardPathOfIssue(['iconFile', 'base64'], values)).toBe('icon')
    expect(wizardPathOfIssue(['manifest', 'settings'], values)).toBe('manifest')
    expect(stepOfPath('manifest')).toBe('review')
  })
})

describe('draft persistence', () => {
  beforeEach(() => {
    stubLocalStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stores the draft without secret values and restores it', () => {
    const values = completeValues({
      credentials: [
        ...completeValues().credentials,
        { key: 'team', label: 'Team', type: 'text', required: false, default: '', options: '', helpUrl: '', advanced: false },
      ],
      credentialValues: { apiKey: 'sk-acme-secret-value', team: 'blue' },
    })
    expect(saveWizardDraft('credentials', values)).toBe(true)
    const raw = localStorage.getItem(WIZARD_DRAFT_KEY) ?? ''
    expect(raw).not.toContain('sk-acme-secret-value')
    expect(raw).toContain('blue')
    const restored = loadWizardDraft()
    expect(restored?.step).toBe('credentials')
    expect(restored?.values).toEqual({ ...values, credentialValues: { team: 'blue' } })
    clearWizardDraft()
    expect(loadWizardDraft()).toBeNull()
  })

  it('ignores a draft it cannot read', () => {
    localStorage.setItem(WIZARD_DRAFT_KEY, '{"step":"api","values":{"name":42}}')
    expect(loadWizardDraft()).toBeNull()
    localStorage.setItem(WIZARD_DRAFT_KEY, 'not json')
    expect(loadWizardDraft()).toBeNull()
    localStorage.setItem(WIZARD_DRAFT_KEY, '{"step":"nowhere","values":{"name":"Kept"}}')
    expect(loadWizardDraft()).toMatchObject({ step: 'basics', values: { name: 'Kept', apiFormat: 'openai-chat' } })
  })

  it('knows when there is something worth keeping', () => {
    expect(hasDraftContent(defaultWizardValues())).toBe(false)
    expect(hasDraftContent({ ...defaultWizardValues(), name: 'x' })).toBe(true)
    // A typed secret alone is never stored, so it is no draft.
    expect(hasDraftContent({ ...defaultWizardValues(), credentialValues: { apiKey: 'sk-x' } })).toBe(false)
  })
})
