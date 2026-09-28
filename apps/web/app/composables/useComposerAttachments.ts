// Composer attachments (docs/UI.md 7.7, 11): every added file uploads at once to `POST /api/files` through `$api`.
// Chips show uploading / error (Retry) / done; image chips preview the local file. Files the server can never
// accept (type, size; also `payload_too_large` / `validation_error` answers) are reported through `onReject` and
// not kept. Sending waits for uploads in flight (`settled()`), then sends the uploaded `FileRef`s.
import type { FileRef, HarnessError } from '@harness-forge/shared'
import type { ComputedRef, Ref } from 'vue'
import type { AttachmentRejection } from '~/components/chat/composer/attachments'
import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue'
import { checkAttachment, isImageMime } from '~/components/chat/composer/attachments'
import { useApi } from '~/composables/useApi'
import { isAbortError, toHarnessError } from '~/utils/errors'

export type ComposerAttachmentState = 'uploading' | 'error' | 'done'

export interface ComposerAttachment {
  /** Local id (not the server file id). */
  id: string
  /** The file as uploaded (its type normalized to an accepted MIME type). */
  file: File
  name: string
  size: number
  mime: string
  /** `blob:` URL of an image, for the chip thumbnail. */
  previewUrl?: string
  state: ComposerAttachmentState
  /** The uploaded file, once `state` is `done`. */
  ref?: FileRef
  /** Why the last upload failed (`state` is `error`). */
  error?: HarnessError
}

export interface AttachmentRejectionInfo {
  name: string
  /** `type` / `size`: checked before uploading; `server`: the server refused the file. */
  reason: AttachmentRejection | 'server'
  /** Server message for `server` rejections. */
  message?: string
}

export type UploadFile = (file: File, signal: AbortSignal) => Promise<FileRef>

export interface ComposerAttachmentsOptions {
  /** Default: `POST /api/files` through `$api` (multipart, one `file` part). */
  upload?: UploadFile
  /** Called for every file that is not (or no longer) attached. */
  onReject?: (rejection: AttachmentRejectionInfo) => void
}

export interface ComposerAttachments {
  items: Ref<ComposerAttachment[]>
  /** Checks and uploads files; returns the attached ones. */
  add: (files: Iterable<File> | ArrayLike<File>) => ComposerAttachment[]
  remove: (id: string) => void
  retry: (id: string) => void
  /** Removes everything (aborting uploads in flight). */
  clear: () => void
  uploading: ComputedRef<boolean>
  failed: ComputedRef<boolean>
  /** Uploaded files, in chip order. */
  fileRefs: ComputedRef<FileRef[]>
  /** Resolves once no upload is in flight. */
  settled: () => Promise<void>
}

// Codes that mean the server will never take this file; anything else (network, 5xx) can be retried.
const PERMANENT_CODES = new Set(['payload_too_large', 'validation_error'])

let nextLocalId = 0

function createPreviewUrl(file: File, mime: string): string | undefined {
  if (!isImageMime(mime) || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function')
    return undefined
  try {
    return URL.createObjectURL(file)
  }
  catch {
    return undefined
  }
}

function revokePreviewUrl(url: string | undefined) {
  if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function')
    URL.revokeObjectURL(url)
}

export function useComposerAttachments(options: ComposerAttachmentsOptions = {}): ComposerAttachments {
  const upload: UploadFile = options.upload ?? (() => {
    const api = useApi()
    return (file, signal) => {
      const form = new FormData()
      form.append('file', file, file.name)
      return api.files.upload({ form, signal })
    }
  })()

  const items = ref<ComposerAttachment[]>([])
  const controllers = new Map<string, AbortController>()

  function patch(id: string, change: Partial<ComposerAttachment>) {
    items.value = items.value.map(item => (item.id === id ? { ...item, ...change } : item))
  }

  function drop(id: string) {
    const item = items.value.find(entry => entry.id === id)
    controllers.get(id)?.abort()
    controllers.delete(id)
    revokePreviewUrl(item?.previewUrl)
    items.value = items.value.filter(entry => entry.id !== id)
  }

  async function start(attachment: ComposerAttachment) {
    controllers.get(attachment.id)?.abort()
    const controller = new AbortController()
    controllers.set(attachment.id, controller)
    patch(attachment.id, { state: 'uploading', error: undefined })
    try {
      const fileRef = await upload(attachment.file, controller.signal)
      if (controller.signal.aborted)
        return
      patch(attachment.id, { state: 'done', ref: fileRef })
    }
    catch (error) {
      if (controller.signal.aborted || isAbortError(error))
        return
      const failure = toHarnessError(error)
      if (PERMANENT_CODES.has(failure.code)) {
        drop(attachment.id)
        options.onReject?.({
          name: attachment.name,
          reason: failure.code === 'payload_too_large' ? 'size' : 'server',
          message: failure.message,
        })
        return
      }
      patch(attachment.id, { state: 'error', error: failure })
    }
    finally {
      if (controllers.get(attachment.id) === controller)
        controllers.delete(attachment.id)
    }
  }

  function add(files: Iterable<File> | ArrayLike<File>): ComposerAttachment[] {
    const added: ComposerAttachment[] = []
    for (const original of Array.from(files)) {
      const check = checkAttachment(original)
      if (!check.ok) {
        options.onReject?.({ name: original.name, reason: check.reason })
        continue
      }
      // Re-typed copy when the browser reported another type (e.g. `.ts` as video/mp2t).
      const file = original.type === check.mime
        ? original
        : new File([original], original.name, { type: check.mime, lastModified: original.lastModified })
      nextLocalId += 1
      added.push({
        id: `att_${nextLocalId}`,
        file,
        name: original.name,
        size: original.size,
        mime: check.mime,
        previewUrl: createPreviewUrl(file, check.mime),
        state: 'uploading',
      })
    }
    if (added.length > 0) {
      items.value = [...items.value, ...added]
      for (const attachment of added)
        void start(attachment)
    }
    return added
  }

  function retry(id: string) {
    const attachment = items.value.find(item => item.id === id)
    if (attachment && attachment.state === 'error')
      void start(attachment)
  }

  function clear() {
    for (const controller of controllers.values())
      controller.abort()
    controllers.clear()
    for (const item of items.value)
      revokePreviewUrl(item.previewUrl)
    items.value = []
  }

  const uploading = computed(() => items.value.some(item => item.state === 'uploading'))
  const failed = computed(() => items.value.some(item => item.state === 'error'))
  const fileRefs = computed(() => items.value.flatMap(item => (item.state === 'done' && item.ref ? [item.ref] : [])))

  function settled(): Promise<void> {
    if (!uploading.value)
      return Promise.resolve()
    return new Promise((resolve) => {
      const stop = watch(uploading, (busy) => {
        if (!busy) {
          stop()
          resolve()
        }
      })
    })
  }

  if (getCurrentScope())
    onScopeDispose(clear)

  return { items, add, remove: drop, retry, clear, uploading, failed, fileRefs, settled }
}
