import type { CatalogModel, ImageOptions } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'
import { catalogModel } from '~/utils/testing/fixtures'
import { stubLocalStorage } from '~/utils/testing/storage'
import { IMAGE_OPTIONS_KEY, imageOptionsForModel, imageOptionsScope } from './useImageOptions'

const NO_IMAGE_CAPS = { tools: true, vision: true, pdf: false, reasoning: false, structuredOutput: true, imageOutput: false }

const imageModel = catalogModel({ providerId: 'openai', id: 'gpt-image-1', kind: 'image', capabilities: { ...NO_IMAGE_CAPS, tools: false } })
const imageOutputModel = catalogModel({ providerId: 'google', id: 'gemini-3-pro-image', capabilities: { ...NO_IMAGE_CAPS, imageOutput: true } })
const chatModel = catalogModel({ capabilities: NO_IMAGE_CAPS })
const speechModel = catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-tts', kind: 'speech', capabilities: { ...NO_IMAGE_CAPS, imageOutput: true } })

/** A fresh copy of the module: its app-wide state is created again from localStorage. */
async function freshModule(): Promise<typeof import('./useImageOptions')> {
  vi.resetModules()
  return import('./useImageOptions')
}

let storage: Storage

beforeEach(() => {
  storage = stubLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stored(): unknown {
  const raw = storage.getItem(IMAGE_OPTIONS_KEY)
  return raw === null ? null : JSON.parse(raw)
}

describe('useImageOptions', () => {
  it('starts from {} (1 image, Auto, edit the previous image) as a read-only ref', async () => {
    const { useImageOptions } = await freshModule()
    const { options } = useImageOptions()
    expect(options.value).toEqual({})
    expect(isReadonly(options)).toBe(true)
  })

  it('merges patches, clears an option set to undefined and persists to localStorage["hf-image-options"]', async () => {
    const { useImageOptions } = await freshModule()
    const { options, set } = useImageOptions()
    set({ aspectRatio: '16:9' })
    set({ n: 2 })
    expect(options.value).toEqual({ aspectRatio: '16:9', n: 2 })
    expect(stored()).toEqual({ aspectRatio: '16:9', n: 2 })
    set({ aspectRatio: undefined, editPrevious: false })
    expect(options.value).toEqual({ n: 2, editPrevious: false })
    expect(stored()).toEqual({ n: 2, editPrevious: false })
  })

  it('ignores a patch that fails imageOptionsSchema', async () => {
    const { useImageOptions } = await freshModule()
    const { options, set } = useImageOptions()
    set({ n: 3 })
    set({ n: 5 })
    set({ aspectRatio: '5:4' as ImageOptions['aspectRatio'] })
    set({ unknown: true } as Partial<ImageOptions>)
    expect(options.value).toEqual({ n: 3 })
    expect(stored()).toEqual({ n: 3 })
  })

  it('shares one state across calls (the composer menu writes, the chat request reads)', async () => {
    const { useImageOptions } = await freshModule()
    const menu = useImageOptions()
    const request = useImageOptions()
    expect(request).toBe(menu)
    menu.set({ n: 4, aspectRatio: '1:1' })
    expect(request.forModel(imageModel)).toEqual({ n: 4, aspectRatio: '1:1' })
  })

  it('restores valid stored options and drops an invalid stored value', async () => {
    storage.setItem(IMAGE_OPTIONS_KEY, JSON.stringify({ n: 2, aspectRatio: '3:4', editPrevious: true }))
    expect((await freshModule()).useImageOptions().options.value).toEqual({ n: 2, aspectRatio: '3:4', editPrevious: true })

    for (const invalid of [JSON.stringify({ n: 9 }), JSON.stringify({ aspectRatio: 'wide' }), JSON.stringify(['16:9']), 'not json']) {
      storage.setItem(IMAGE_OPTIONS_KEY, invalid)
      expect((await freshModule()).useImageOptions().options.value).toEqual({})
      expect(storage.getItem(IMAGE_OPTIONS_KEY)).toBeNull()
    }
  })

  it('keeps the options in memory when storage is blocked', async () => {
    const blocked = () => {
      throw new DOMException('Blocked', 'SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    const { useImageOptions } = await freshModule()
    const { options, set } = useImageOptions()
    expect(options.value).toEqual({})
    set({ aspectRatio: '9:16' })
    expect(options.value).toEqual({ aspectRatio: '9:16' })
  })

  it('forModel(): image models get every option, image-output chat models the aspect ratio only, others nothing', async () => {
    const { useImageOptions } = await freshModule()
    const { forModel, set } = useImageOptions()
    expect(forModel(imageModel)).toEqual({})
    expect(forModel(imageOutputModel)).toBeUndefined()
    set({ n: 2, aspectRatio: '16:9', editPrevious: false })
    expect(forModel(imageModel)).toEqual({ n: 2, aspectRatio: '16:9', editPrevious: false })
    expect(forModel(imageOutputModel)).toEqual({ aspectRatio: '16:9' })
    expect(forModel(chatModel)).toBeUndefined()
    expect(forModel(speechModel)).toBeUndefined()
    expect(forModel(null)).toBeUndefined()
    expect(forModel(undefined)).toBeUndefined()
  })

  it('forModel() returns a plain copy that does not change the options', async () => {
    const { useImageOptions } = await freshModule()
    const { forModel, options, set } = useImageOptions()
    set({ n: 2 })
    const body = forModel(imageModel)!
    body.n = 4
    expect(options.value).toEqual({ n: 2 })
    expect(JSON.parse(JSON.stringify(forModel(imageModel)))).toEqual({ n: 2 })
  })
})

describe('imageOptionsScope / imageOptionsForModel', () => {
  it('classifies models by kind and image output', () => {
    const cases: Array<[CatalogModel | null | undefined, ReturnType<typeof imageOptionsScope>]> = [
      [imageModel, 'image'],
      [imageOutputModel, 'image-output'],
      [chatModel, null],
      [speechModel, null],
      [null, null],
      [undefined, null],
    ]
    for (const [model, scope] of cases)
      expect(imageOptionsScope(model)).toBe(scope)
  })

  it('leaves undefined options out of the request body', () => {
    expect(imageOptionsForModel({ n: undefined, aspectRatio: '4:3' }, imageModel)).toEqual({ aspectRatio: '4:3' })
    expect(imageOptionsForModel({ n: 3, editPrevious: true }, imageOutputModel)).toBeUndefined()
  })
})
