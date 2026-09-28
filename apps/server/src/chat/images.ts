// Image turns (ADR-028, ARCHITECTURE.md 6.11, API.md 6.8): a request whose model is an image model (`kind: 'image'`)
// is answered by one `ImageService.generate` call (the prompt and the input images planned by `prepare.ts`; no history
// is sent). The stream is built with `createUIMessageStream` like a reply command, so persistence, `run.finished`,
// resume and Stop work as for chat runs:
//   start (metadata { modelRef, startedAt, image: { n, aspectRatio?, inputs } })
//   start-step
//   message-metadata (the same start metadata every `IMAGE_KEEPALIVE_MS`, while the provider works: proxies close idle
//     connections)
//   file { url: '/api/files/<id>', mediaType } per stored image (an inline `generated-file-dropped` notice for images
//     the service refused)
//   finish-step
//   finish (metadata with usage, costUsd?, image.revisedPrompt?)
// The images are stored by the service before they are streamed: the replay buffer holds URLs only. A failure is
// `recordFatal` + an `error` chunk (the envelope, persisted in `metadata.error`); Stop is an `abort` chunk (saved with
// `aborted: true`). The service writes the usage row (`purpose: 'image'`) and records the provider outcome.
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { ImageGenerationResult } from '../services/images/types.ts'
import type { RunSession } from './pipeline.ts'
import { createUIMessageStream } from 'ai'
import { errorEnvelopeText } from './errors.ts'
import { NOTICES } from './notices.ts'

/** Interval of the `message-metadata` keep-alive of an image turn (Cloudflare closes connections idle for 100 s). */
export const IMAGE_KEEPALIVE_MS = 15_000

/** The stream of an image turn (see the header comment). */
export function imageStream(session: RunSession): ReadableStream<UIMessageChunk> {
  const { deps, run, prepared } = session.ctx
  const target = prepared.target
  if (target.kind !== 'image')
    throw new Error('imageStream needs an image model.')
  session.mode = 'image'
  const { model, options } = target
  if (options.dropped > 0)
    session.notices.push(NOTICES.filesNotSent(options.dropped))
  const keepAliveMs = session.ctx.imageKeepAliveMs ?? IMAGE_KEEPALIVE_MS

  return createUIMessageStream<HarnessUIMessage>({
    originalMessages: prepared.history,
    generateId: () => session.assistantId,
    execute: async ({ writer }) => {
      const start = session.startMetadata()
      writer.write({ type: 'start', messageId: session.assistantId, messageMetadata: start })
      writer.write({ type: 'start-step' })
      const keepAlive = setInterval(() => writer.write({ type: 'message-metadata', messageMetadata: start }), keepAliveMs)
      keepAlive.unref()
      const stopKeepAlive = (): void => clearInterval(keepAlive)
      run.signal.addEventListener('abort', stopKeepAlive, { once: true })
      let result: ImageGenerationResult
      try {
        result = await deps.images.generate({
          resolved: model,
          prompt: options.prompt,
          inputFileIds: options.inputFileIds,
          n: options.n,
          ...(options.aspectRatio === undefined ? {} : { aspectRatio: options.aspectRatio }),
          signal: run.signal,
          chatId: run.chatId,
          messageId: session.assistantId,
        })
      }
      catch (error) {
        if (run.signal.aborted) {
          writer.write({ type: 'abort' })
          return
        }
        session.recordFatal(error)
        writer.write({ type: 'error', errorText: errorEnvelopeText(session.fatal ?? session.map(error)) })
        return
      }
      finally {
        stopKeepAlive()
        run.signal.removeEventListener('abort', stopKeepAlive)
      }
      session.image = result
      for (const image of result.images)
        writer.write({ type: 'file', url: session.generated.add(image.file), mediaType: image.file.mime })
      if (result.dropped > 0)
        writer.write({ type: 'data-notice', data: NOTICES.generatedFileDropped(result.dropped) })
      writer.write({ type: 'finish-step' })
      session.finished = true
      session.finishMetadata = session.buildFinishMetadata(session.ctx.now(), 'completed')
      writer.write({ type: 'finish', finishReason: 'stop', messageMetadata: session.finishMetadata })
    },
    onError: error => session.errorText(error),
    onEnd: session.onEnd,
  }) as ReadableStream<UIMessageChunk>
}
