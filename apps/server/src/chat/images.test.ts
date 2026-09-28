// Image turns, generated files, the `generate_image` injection and the history of generated images, through
// `POST /api/chat` on the media test app (the C11 fakes for `ImageService`, `saveGenerated` and the media resolvers).
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ChatDetail, HarnessUIMessage, HarnessUIMessagePart, MessageMetadata, ServerEvent } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { MediaTestApp } from './testing.ts'
import { Buffer } from 'node:buffer'
import { chatDetailSchema, HarnessError, harnessErrorEnvelopeSchema, messageMetadataSchema } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readPng } from '../builtin-plugins/mock/media.test-util.ts'
import { mockImagePng } from '../builtin-plugins/mock/media.ts'
import { PDF, PNG } from '../services/files/fixtures.test-util.ts'
import { CARRIED_IMAGES_TEXT } from './files.ts'
import { IMAGE_KEEPALIVE_MS } from './images.ts'
import { NOTICES } from './notices.ts'
import {
  chatBody,
  chunkUrls,
  createMediaTestApp,
  imageToolText,
  messagesWithDataUrls,
  messageText,
  nextEvent,
  postChat,
  readSse,
  readUntil,
  runnerOf,
  streamedText,
  testChatId,
  userMessage,
} from './testing.ts'

let t: MediaTestApp
let nextChat = 3000
const KEEPALIVE_MS = 40

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

async function detailOf(chatId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

function waitRunFinished(chatId: string): Promise<Extract<ServerEvent, { type: 'run.finished' }>> {
  return nextEvent(t, 'run.finished', event => event.data.chatId === chatId, 15_000)
}

function types(chunks: readonly UIMessageChunk[]): string[] {
  return chunks.map(chunk => chunk.type)
}

function fileParts(message: HarnessUIMessage | undefined): Extract<HarnessUIMessagePart, { type: 'file' }>[] {
  return (message?.parts ?? []).filter((part): part is Extract<HarnessUIMessagePart, { type: 'file' }> => part.type === 'file')
}

function fileIdOf(url: string): string {
  return url.slice('/api/files/'.length)
}

function metadataOf(chunk: UIMessageChunk | undefined): MessageMetadata | undefined {
  if (chunk === undefined || !('messageMetadata' in chunk))
    return undefined
  return messageMetadataSchema.parse(chunk.messageMetadata)
}

function toolPart(message: HarnessUIMessage | undefined): Record<string, unknown> | undefined {
  return message?.parts.find(part => part.type.startsWith('tool-')) as Record<string, unknown> | undefined
}

/** Marks every pending approval of `message` as answered (the client side of `addToolApprovalResponse`). */
function approved(message: HarnessUIMessage): HarnessUIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const value = part as unknown as Record<string, unknown>
      if (value.state !== 'approval-requested')
        return part
      return { ...value, state: 'approval-responded', approval: { ...(value.approval as object), approved: true } } as unknown as typeof part
    }),
  }
}

function finishPart(): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    finishReason: { unified: 'stop', raw: 'stop' },
  }
}

/** A scripted `mediakit` model (calls recorded). */
function scriptedModel(script: (options: LanguageModelV4CallOptions) => LanguageModelV4StreamPart[]): { model: MockLanguageModelV4, calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    provider: 'mediakit',
    modelId: 'scripted',
    doStream: async (options) => {
      calls.push(options)
      return { stream: convertArrayToReadableStream(script(options)) }
    },
  })
  return { model, calls }
}

beforeAll(async () => {
  t = await createMediaTestApp({ imageKeepAliveMs: KEEPALIVE_MS })
})

beforeEach(() => {
  t.events.length = 0
  t.scripted.clear()
  for (const key of Object.keys(t.imageOptions) as (keyof typeof t.imageOptions)[])
    delete t.imageOptions[key]
})

afterAll(async () => {
  await t.close()
})

describe('image turns', () => {
  it('streams start (image metadata), start-step, one stored file per image, finish-step and finish', async () => {
    const chatId = newChatId()
    const body = chatBody(chatId, 'a red fox', { modelRef: 'mock:image', imageOptions: { n: 2, aspectRatio: '16:9' } })
    const finished = waitRunFinished(chatId)
    const response = await postChat(t, body)
    expect(response.status).toBe(200)
    const { chunks, done } = await readSse(response)
    expect(done).toBe(true)
    // Keep-alives (if the generation took longer than the interval) come only while the images are generated.
    expect(types(chunks).filter(type => type !== 'message-metadata')).toEqual(['start', 'start-step', 'file', 'file', 'finish-step', 'finish'])
    const start = metadataOf(chunks[0])
    expect(start).toMatchObject({ modelRef: 'mock:image', image: { n: 2, aspectRatio: '16:9', inputs: 0 } })
    for (const chunk of chunks.filter(value => value.type === 'message-metadata'))
      expect(metadataOf(chunk)).toEqual(start)
    const files = chunks.filter(chunk => chunk.type === 'file')
    for (const chunk of files)
      expect(chunk).toMatchObject({ mediaType: 'image/png', url: expect.stringMatching(/^\/api\/files\/file_[\dA-Z]{16}$/i) })
    expect(chunkUrls(chunks).some(url => url.startsWith('data:'))).toBe(false)
    const finish = metadataOf(chunks.at(-1))
    expect(finish).toMatchObject({
      modelRef: 'mock:image',
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 200, totalTokens: 203 },
      image: { n: 2, aspectRatio: '16:9', inputs: 0, revisedPrompt: 'Mock: a red fox' },
    })
    expect(finish?.costUsd).toBeUndefined()
    expect((await finished).data).toMatchObject({ outcome: 'completed', awaitingApproval: false })

    // One call of the image service: the prompt, no history, the run signal, the usage row's chat and message.
    expect(t.images.calls).toHaveLength(1)
    const call = t.images.calls[0]!
    expect(call).toMatchObject({ prompt: 'a red fox', n: 2, aspectRatio: '16:9', inputFileIds: [], chatId, resolved: { modelRef: 'mock:image' } })
    const detail = await detailOf(chatId)
    const [user, reply] = detail.messages
    expect(user?.id).toBe(body.message.id)
    expect(call.messageId).toBe(reply?.id)
    expect(call.signal.aborted).toBe(false)
    // The saved reply equals the streamed one, plus the file names a UI chunk cannot carry.
    expect(fileParts(reply)).toEqual(files.map((chunk, index) => ({ type: 'file', mediaType: 'image/png', url: chunk.type === 'file' ? chunk.url : '', filename: `image-${index + 1}.png` })))
    expect(reply?.metadata).toMatchObject({ image: { n: 2, aspectRatio: '16:9', inputs: 0, revisedPrompt: 'Mock: a red fox' }, usage: { totalTokens: 203 }, finishReason: 'stop' })
    expect(reply?.metadata?.aborted).toBeUndefined()
    const stored = await t.deps.files.read(fileIdOf(fileParts(reply)[0]!.url))
    expect(readPng(stored.data)).toMatchObject({ width: 320, height: 180 })
    expect(await messagesWithDataUrls(t)).toBe(0)
    // The usage row of the generation (purpose image) is written by the service, not by the pipeline.
    expect(detail.totals.outputTokens).toBeGreaterThanOrEqual(0)
    await runnerOf(t).idle()
  })

  it('sends a keep-alive with the start metadata while the images are generated', async () => {
    t.imageOptions.delayMs = KEEPALIVE_MS * 4
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'a slow owl', { modelRef: 'mock:image' })))
    const keepAlives = chunks.filter(chunk => chunk.type === 'message-metadata')
    expect(keepAlives.length).toBeGreaterThanOrEqual(1)
    const firstFile = chunks.findIndex(chunk => chunk.type === 'file')
    expect(chunks.findIndex(chunk => chunk.type === 'message-metadata')).toBeGreaterThan(chunks.findIndex(chunk => chunk.type === 'start-step'))
    expect(chunks.findLastIndex(chunk => chunk.type === 'message-metadata')).toBeLessThan(firstFile)
    expect(metadataOf(keepAlives[0])).toEqual(metadataOf(chunks[0]))
    expect(metadataOf(chunks[0])?.image).toEqual({ n: 1, inputs: 0 })
    expect(IMAGE_KEEPALIVE_MS).toBe(15_000)
    await runnerOf(t).idle()
  })

  it('edits the previous images ("make it blue"), attached images win, editPrevious false starts over', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'a red fox', { modelRef: 'mock:image', imageOptions: { n: 2 } })))
    const first = await detailOf(chatId)
    const previous = fileParts(first.messages[1]).map(part => fileIdOf(part.url))
    expect(previous).toHaveLength(2)

    const edit = await readSse(await postChat(t, chatBody(chatId, 'make it blue', { modelRef: 'mock:image' })))
    expect(metadataOf(edit.chunks[0])?.image).toEqual({ n: 1, inputs: 2 })
    expect(t.images.calls.at(-1)).toMatchObject({ prompt: 'make it blue', n: 1, inputFileIds: previous })
    const edited = await detailOf(chatId)
    expect(edited.messages.at(-1)?.metadata?.image).toMatchObject({ inputs: 2 })

    const fresh = await readSse(await postChat(t, chatBody(chatId, 'a new picture', { modelRef: 'mock:image', imageOptions: { editPrevious: false } })))
    expect(metadataOf(fresh.chunks[0])?.image).toEqual({ n: 1, inputs: 0 })
    expect(t.images.calls.at(-1)?.inputFileIds).toEqual([])

    // An attached image is the input (vision model), instead of the parent's images.
    const upload = await t.deps.files.upload(new File([PNG], 'sketch.png', { type: 'image/png' }))
    const message = { ...userMessage('color this sketch'), parts: [{ type: 'file' as const, mediaType: 'image/png', url: upload.url }, { type: 'text' as const, text: 'color this sketch' }] }
    const attached = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:image' }), message }))
    expect(metadataOf(attached.chunks[0])?.image).toEqual({ n: 1, inputs: 1 })
    expect(t.images.calls.at(-1)?.inputFileIds).toEqual([upload.id])
    await runnerOf(t).idle()
  })

  it('keeps other attachments away from the image model with the attachments-unsupported notice', async () => {
    const chatId = newChatId()
    const pdf = await t.deps.files.upload(new File([PDF], 'brief.pdf', { type: 'application/pdf' }))
    const message = { ...userMessage('draw the brief'), parts: [{ type: 'file' as const, mediaType: 'application/pdf', url: pdf.url }, { type: 'text' as const, text: 'draw the brief' }] }
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:image' }), message }))
    expect(types(chunks).slice(0, 3)).toEqual(['start', 'data-notice', 'start-step'])
    expect(chunks[1]).toEqual({ type: 'data-notice', data: NOTICES.filesNotSent(1) })
    expect(t.images.calls.at(-1)?.inputFileIds).toEqual([])
    const reply = (await detailOf(chatId)).messages[1]
    expect(reply?.parts[0]).toEqual({ type: 'data-notice', data: NOTICES.filesNotSent(1) })
    await runnerOf(t).idle()
  })

  it('stop during the generation aborts it and saves the reply as aborted', async () => {
    t.imageOptions.delayMs = 10_000
    const chatId = newChatId()
    const finished = waitRunFinished(chatId)
    const response = await postChat(t, chatBody(chatId, 'a slow painting', { modelRef: 'mock:image', imageOptions: { n: 3 } }))
    await readUntil(response, chunks => chunks.some(chunk => chunk.type === 'start-step'))
    const stop = await t.request(`/api/chat/${chatId}/stop`, { method: 'POST' })
    expect(await stop.json()).toEqual({ stopped: true })
    expect((await finished).data).toMatchObject({ outcome: 'aborted' })
    expect(t.images.calls.at(-1)?.signal.aborted).toBe(true)
    const reply = (await detailOf(chatId)).messages[1]
    expect(reply?.metadata).toMatchObject({ aborted: true, image: { n: 3, inputs: 0 } })
    expect(reply?.metadata?.finishedAt).toBeGreaterThan(0)
    expect(fileParts(reply)).toEqual([])
    expect(runnerOf(t).isActive(chatId)).toBe(false)
    await runnerOf(t).idle()
  })

  it('a failed generation ends with the error envelope, saved in metadata.error', async () => {
    t.imageOptions.failWith = () => new HarnessError({ code: 'provider_error', message: 'Mock image generation failure', providerId: 'mock', status: 400, action: 'retry' })
    const chatId = newChatId()
    const finished = waitRunFinished(chatId)
    const { chunks, done } = await readSse(await postChat(t, chatBody(chatId, 'please fail', { modelRef: 'mock:image' })))
    expect(done).toBe(true)
    expect(types(chunks).filter(type => type !== 'message-metadata')).toEqual(['start', 'start-step', 'error'])
    const error = chunks.find(chunk => chunk.type === 'error')
    expect(harnessErrorEnvelopeSchema.parse(JSON.parse(error?.type === 'error' ? error.errorText : '{}')).error).toMatchObject({ code: 'provider_error', message: 'Mock image generation failure' })
    expect((await finished).data).toMatchObject({ outcome: 'failed', error: { code: 'provider_error' } })
    const reply = (await detailOf(chatId)).messages[1]
    expect(reply?.metadata).toMatchObject({ finishReason: 'error', error: { code: 'provider_error' }, image: { n: 1, inputs: 0 } })
    expect(fileParts(reply)).toEqual([])
    await runnerOf(t).idle()
  })

  it('images the service refused are replaced by the generated-file-dropped notice', async () => {
    t.imageOptions.dropped = 1
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'two birds', { modelRef: 'mock:image', imageOptions: { n: 2 } })))
    expect(types(chunks).filter(type => type !== 'message-metadata')).toEqual(['start', 'start-step', 'file', 'data-notice', 'finish-step', 'finish'])
    const reply = (await detailOf(chatId)).messages[1]
    expect(reply?.parts.map(part => part.type)).toEqual(['step-start', 'file', 'data-notice'])
    expect(reply?.parts[2]).toEqual({ type: 'data-notice', data: NOTICES.generatedFileDropped(1) })
    await runnerOf(t).idle()
  })

  it('resume replays the image turn exactly once (URLs only)', async () => {
    t.imageOptions.delayMs = 300
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'a resumable heron', { modelRef: 'mock:image', imageOptions: { n: 2 } }))
    const partial = await readUntil(response, chunks => chunks.some(chunk => chunk.type === 'start-step'))
    expect(partial.done).toBe(false)
    expect(runnerOf(t).isActive(chatId)).toBe(true)
    const replay = await readSse(await t.request(`/api/chat/${chatId}/stream`))
    expect(replay.done).toBe(true)
    expect(replay.chunks.filter(chunk => chunk.type === 'start')).toHaveLength(1)
    expect(replay.chunks.filter(chunk => chunk.type === 'file')).toHaveLength(2)
    expect(chunkUrls(replay.chunks).every(url => url.startsWith('/api/files/'))).toBe(true)
    const reply = (await detailOf(chatId)).messages[1]
    expect(fileParts(reply).map(part => part.url)).toEqual(chunkUrls(replay.chunks))
    expect(t.images.calls.filter(call => call.chatId === chatId)).toHaveLength(1)
    await runnerOf(t).idle()
  })

  it('regenerate adds a version with new images', async () => {
    const chatId = newChatId()
    const body = chatBody(chatId, 'a lighthouse', { modelRef: 'mock:image' })
    await readSse(await postChat(t, body))
    const first = (await detailOf(chatId)).messages[1]!
    const { chunks } = await readSse(await postChat(t, { ...body, trigger: 'regenerate-message', messageId: first.id }))
    expect(chunks.filter(chunk => chunk.type === 'file')).toHaveLength(1)
    const after = await detailOf(chatId)
    const second = after.messages[1]!
    expect(second.id).not.toBe(first.id)
    expect(after.branches).toEqual({ [second.id]: { siblings: [first.id, second.id], index: 1 } })
    // A regenerate answers the same user message: its parent has no images, so nothing is edited.
    expect(t.images.calls.at(-1)).toMatchObject({ prompt: 'a lighthouse', inputFileIds: [] })
    await runnerOf(t).idle()
  })

  it('titles a new image chat with the small model of the provider, never with the image model', async () => {
    const chatId = newChatId()
    const titled = nextEvent(t, 'chat.updated', event => event.data.id === chatId && event.data.title !== null)
    await readSse(await postChat(t, chatBody(chatId, 'a quiet harbor at dawn', { modelRef: 'mock:image' })))
    // mock:echo (the small model of the mock provider) echoes the text.
    expect((await titled).data).toMatchObject({ title: 'a quiet harbor at dawn', titleSource: 'auto' })
    await runnerOf(t).idle()
  })

  it('keeps the default title when neither titleModelRef nor a small model exists', async () => {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'a mountain lake', { modelRef: 'mediakit:pix' })))
    expect(chunks.filter(chunk => chunk.type === 'file')).toHaveLength(1)
    await runnerOf(t).idle()
    const detail = await detailOf(chatId)
    expect(detail).toMatchObject({ title: null, titleSource: null })
    expect(t.images.calls.filter(call => call.chatId === chatId)).toHaveLength(1)
    expect(t.events.some(event => event.type === 'chat.updated' && event.data.id === chatId && event.data.title !== null)).toBe(false)
  })
})

describe('chat models with image output', () => {
  it('stores the generated image before it is streamed or saved (mock:image-chat)', async () => {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'a red fox', { modelRef: 'mock:image-chat', imageOptions: { aspectRatio: '16:9' } })))
    expect(streamedText(chunks)).toBe('Image for: a red fox')
    const files = chunks.filter(chunk => chunk.type === 'file')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ mediaType: 'image/png', url: expect.stringMatching(/^\/api\/files\/file_/) })
    // No base64 is ever streamed or saved.
    expect(chunkUrls(chunks).some(url => url.startsWith('data:'))).toBe(false)
    expect(JSON.stringify(chunks)).not.toContain('base64')
    const reply = (await detailOf(chatId)).messages[1]
    expect(messageText(reply)).toBe('Image for: a red fox')
    expect(fileParts(reply)).toEqual([{ type: 'file', mediaType: 'image/png', url: files[0]?.type === 'file' ? files[0].url : '', filename: 'image-1.png' }])
    expect(await messagesWithDataUrls(t)).toBe(0)
    // `imageParams` of the mock provider passed the aspect ratio: 16:9 is 320x180.
    const stored = await t.deps.files.read(fileIdOf(fileParts(reply)[0]!.url))
    expect(readPng(stored.data)).toMatchObject({ width: 320, height: 180 })
    await runnerOf(t).idle()
  })

  it('merges the imageParams provider options into every call of an image-output model', async () => {
    const { model, calls } = scriptedModel(() => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, finishPart()])
    t.scripted.set('painter', model)
    await readSse(await postChat(t, chatBody(newChatId(), 'paint', { modelRef: 'mediakit:painter', imageOptions: { aspectRatio: '3:4' } })))
    expect(calls[0]?.providerOptions).toMatchObject({ mediakit: { aspectRatio: '3:4' } })
    await readSse(await postChat(t, chatBody(newChatId(), 'paint', { modelRef: 'mediakit:painter' })))
    expect(calls[1]?.providerOptions?.mediakit).toBeUndefined()
    await runnerOf(t).idle()
  })

  it('drops a generated file that is not a stored raster image, with an inline notice', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const png = mockImagePng('painter', 0, { width: 4, height: 2 })
    const { model } = scriptedModel(() => [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Here it is' },
      { type: 'text-end', id: 't' },
      { type: 'file', mediaType: 'image/svg+xml', data: { type: 'data', data: svg } },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } },
      finishPart(),
    ])
    t.scripted.set('painter', model)
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'draw', { modelRef: 'mediakit:painter' })))
    // (The painter has no tool support: the tools-unsupported notice follows `start`.)
    const fromText = chunks.slice(types(chunks).indexOf('text-start'))
    expect(types(fromText)).toEqual(['text-start', 'text-delta', 'text-end', 'data-notice', 'file', 'finish-step', 'finish'])
    expect(fromText[3]).toEqual({ type: 'data-notice', data: NOTICES.generatedFileDropped() })
    expect(chunkUrls(chunks).some(url => url.startsWith('data:'))).toBe(false)
    const reply = (await detailOf(chatId)).messages[1]
    const parts = reply?.parts.filter(part => !(part.type === 'data-notice' && part.data.code === 'tools-unsupported'))
    expect(parts?.map(part => part.type)).toEqual(['step-start', 'text', 'data-notice', 'file'])
    expect(fileParts(reply)[0]).toMatchObject({ mediaType: 'image/png', filename: 'image-1.png' })
    expect(readPng((await t.deps.files.read(fileIdOf(fileParts(reply)[0]!.url))).data)).toMatchObject({ width: 4, height: 2 })
    expect(await messagesWithDataUrls(t)).toBe(0)
    await runnerOf(t).idle()
  })
})

describe('the generate_image tool', () => {
  let tool: Disposable | undefined

  afterAll(() => {
    tool?.dispose()
  })

  it('appends the images of core-tools\' generate_image after the tool output and adds its cost', async () => {
    tool = t.registerImageTool()
    t.imageOptions.costUsd = 0.04
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'a red fox', { modelRef: 'mock:image-tool', toolMode: 'auto' })))
    const output = types(chunks).indexOf('tool-output-available')
    expect(output).toBeGreaterThan(0)
    expect(types(chunks)[output + 1]).toBe('file')
    expect(streamedText(chunks)).toBe('Image tool result: 1 image(s)')
    const reply = (await detailOf(chatId)).messages[1]
    expect(reply?.parts.map(part => part.type)).toEqual(['step-start', 'tool-generate_image', 'file', 'step-start', 'text'])
    const [file] = fileParts(reply)
    expect(file).toMatchObject({ mediaType: 'image/png', filename: 'image-1.png' })
    expect((toolPart(reply)?.output as { images: { url: string }[] }).images[0]?.url).toBe(file?.url)
    // The model got text only.
    expect(JSON.stringify(reply)).not.toContain('base64')
    // The message cost is the model cost plus the tool's estimated image cost.
    const metadata = reply?.metadata
    const modelCost = ((metadata?.usage?.inputTokens ?? 0) * 1 + (metadata?.usage?.outputTokens ?? 0) * 2) / 1_000_000
    expect(metadata?.costUsd).toBeCloseTo(0.04 + modelCost, 10)
    expect(metadataOf(chunks.at(-1))?.costUsd).toBe(metadata?.costUsd)
    expect(t.images.calls.at(-1)).toMatchObject({ prompt: 'a red fox', chatId, messageId: null })
    expect(imageToolText({ modelRef: 'mock:image', images: [] })).toContain('0 images')
    await runnerOf(t).idle()
  })

  it('appends the images on an approval continuation', async () => {
    tool ??= t.registerImageTool()
    const chatId = newChatId()
    const first = await readSse(await postChat(t, chatBody(chatId, 'a blue whale', { modelRef: 'mock:image-tool' })))
    expect(first.chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(true)
    const pending = (await detailOf(chatId)).messages[1]!
    expect(toolPart(pending)).toMatchObject({ state: 'approval-requested' })
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:image-tool' }), message: approved(pending) }))
    expect(types(chunks)[types(chunks).indexOf('tool-output-available') + 1]).toBe('file')
    const reply = (await detailOf(chatId)).messages[1]
    expect(reply?.id).toBe(pending.id)
    expect(reply?.parts.map(part => part.type)).toEqual(['step-start', 'tool-generate_image', 'file', 'step-start', 'text'])
    expect(fileParts(reply)[0]).toMatchObject({ filename: 'image-1.png' })
    await runnerOf(t).idle()
  })

  it('never appends files for a generate_image tool of another plugin', async () => {
    tool?.dispose()
    tool = undefined
    const foreign = t.registerImageTool('mock')
    try {
      t.imageOptions.costUsd = 0.5
      const chatId = newChatId()
      const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'a red fox', { modelRef: 'mock:image-tool', toolMode: 'auto' })))
      expect(types(chunks)).toContain('tool-output-available')
      expect(types(chunks)).not.toContain('file')
      const reply = (await detailOf(chatId)).messages[1]
      expect(fileParts(reply)).toEqual([])
      expect(reply?.metadata?.costUsd).toBeLessThan(0.5)
      await runnerOf(t).idle()
    }
    finally {
      foreign.dispose()
    }
  })
})

describe('generated images in the history', () => {
  it('carries the latest images into the next user message of a vision model and names the others', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'a red fox', { modelRef: 'mock:image', imageOptions: { n: 2 } })))
    // mock:echo (vision) echoes the text parts of the last user message and counts its files: the two carried images.
    const echo = await readSse(await postChat(t, chatBody(chatId, 'describe them')))
    expect(streamedText(echo.chunks)).toBe(`${CARRIED_IMAGES_TEXT} describe them\n\n[files: 2]`)

    const { model, calls } = scriptedModel(() => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'seen' }, { type: 'text-end', id: 't' }, finishPart()])
    t.scripted.set('seer', model)
    await readSse(await postChat(t, chatBody(chatId, 'and now?', { modelRef: 'mediakit:seer' })))
    const prompt = calls[0]!.prompt
    const [firstReply] = prompt.filter(message => message.role === 'assistant')
    expect(firstReply?.content).toEqual([{ type: 'text', text: '[Generated image: image-1.png]' }, { type: 'text', text: '[Generated image: image-2.png]' }])
    const users = prompt.filter(message => message.role === 'user')
    // The images follow the image turn's reply: they are carried into the next user message ("describe them") only.
    expect(users[1]?.content.map(part => part.type)).toEqual(['text', 'file', 'file', 'text'])
    expect(users[1]?.content[0]).toEqual({ type: 'text', text: CARRIED_IMAGES_TEXT })
    expect(users[2]?.content).toEqual([{ type: 'text', text: 'and now?' }])
    // The bytes of the stored images (sent as data, never as a URL to fetch).
    const carried = users[1]?.content[1]
    expect(carried).toMatchObject({ type: 'file', mediaType: 'image/png', data: { type: 'data' } })
    await runnerOf(t).idle()
  })

  it('never saves a data URL', async () => {
    expect(await messagesWithDataUrls(t)).toBe(0)
    expect(Buffer.from('ok').toString('base64')).toBe('b2s=')
  })
})
