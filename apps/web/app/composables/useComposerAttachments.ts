// Composer attachments (docs/UI.md 7.7, 7.26, 10.6, 11): every added file uploads at once to `POST /api/files` through
// `$api`. Chips show uploading / error (Retry) / done; image chips preview the local file. Files the server can never
// accept (type, size; also `payload_too_large` / `validation_error` answers) are reported through `onReject` and
// not kept. Sending waits for uploads in flight (`settled()`), then sends the uploaded `FileRef`s.
// Phase 9 (ADR-042): `addProject(projectId, path)` attaches a project file picked in the `@` menu (`source: 'project'`,
// no local file): `POST /projects/:id/files/attach` snapshots it as an upload; the same path is attached once; a file
// the server refuses (413 / 404 / 400) is dropped and reported through `onReject` with `source` and `path`.
// `addRefs(refs)` adds chips of files that are already uploaded (queued messages put back into the composer).
import type { FileRef, HarnessError } from '@harness-forge/shared'
import type { ComputedRef, Ref } from 'vue'
import type { AttachmentRejection } from '~/components/chat/composer/attachments'
import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue'
import { checkAttachment, isImageMime } from '~/components/chat/composer/attachments'
import { pathBaseName } from '~/components/chat/composer/mention-menu'
import { useApi } from '~/composables/useApi'
import { useProjectFiles } from '~/composables/useProjectFiles'
import { isAbortError, toHarnessError } from '~/utils/errors'

export type ComposerAttachmentState = 'uploading' | 'error' | 'done'

/** + Phase 9: `upload` = a local file (or an already uploaded one); `project` = a project file of an `@` mention. */
export type ComposerAttachmentSource = 'upload' | 'project'

export interface ComposerAttachment {
  /** Local id (not the server file id). */
  id: string
  /** + Phase 9: where the file comes from. */
  source: ComposerAttachmentSource
  /** The file as uploaded (its type normalized to an accepted MIME type); absent for project chips and restored files. */
  file?: File
  /** + Phase 9: the project-relative path of a project chip. */
  path?: string
  /** + Phase 9: the project of a project chip. */
  projectId?: string
  /** File name (a project chip: the base name of its path). */
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
  /** The file name (a project chip: its path). */
  name: string
  /** `type` / `size`: checked before uploading; `server`: the server refused the file. */
  reason: AttachmentRejection | 'server'
  /** Server message for `server` rejections. */
  message?: string
  /** + Phase 9: `project` for a project chip (default `upload`). */
  source?: ComposerAttachmentSource
  /** + Phase 9: the path of a refused project chip. */
  path?: string
  /** + Phase 9: the server's error of a refused project chip. */
  error?: HarnessError
}

export type UploadFile = (file: File, signal: AbortSignal) => Promise<FileRef>

/** + Phase 9: attaches a project file (`POST /projects/:id/files/attach`). */
export type AttachProjectFile = (projectId: string, path: string, signal: AbortSignal) => Promise<FileRef>

export interface ComposerAttachmentsOptions {
  /** Default: `POST /api/files` through `$api` (multipart, one `file` part). */
  upload?: UploadFile
  /** + Phase 9. Default: `useProjectFiles().attach`. */
  attachProject?: AttachProjectFile
  /** Called for every file that is not (or no longer) attached. */
  onReject?: (rejection: AttachmentRejectionInfo) => void
}

export interface ComposerAttachments {
  items: Ref<ComposerAttachment[]>
  /** Checks and uploads files; returns the attached ones. */
  add: (files: Iterable<File> | ArrayLike<File>) => ComposerAttachment[]
  /** + Phase 9: attaches a project file once (an existing chip of the same path is returned; a failed one retried). */
  addProject: (projectId: string, path: string) => ComposerAttachment
  /** + Phase 9: adds chips of already uploaded files (a file already shown is skipped); returns the added ones. */
  addRefs: (refs: readonly FileRef[]) => ComposerAttachment[]
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
// A project file can also be gone (404).
const PERMANENT_PROJECT_CODES = new Set(['payload_too_large', 'validation_error', 'not_found'])

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
  if (url?.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function')
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

  let attachProject: AttachProjectFile | null = options.attachProject ?? null
  // Created on the first project chip (`useApi()` needs the Nuxt app).
  const projectAttach = (): AttachProjectFile => (attachProject ??= (() => {
    const files = useProjectFiles()
    return (projectId, path, signal) => files.attach(projectId, path, { signal })
  })())

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

  /** Uploads a local file or attaches a project file. */
  function send(attachment: ComposerAttachment, signal: AbortSignal): Promise<FileRef> {
    if (attachment.source === 'project' && attachment.projectId && attachment.path)
      return projectAttach()(attachment.projectId, attachment.path, signal)
    if (attachment.file)
      return upload(attachment.file, signal)
    return Promise.reject(new Error('Nothing to upload.'))
  }

  async function start(attachment: ComposerAttachment) {
    controllers.get(attachment.id)?.abort()
    const controller = new AbortController()
    controllers.set(attachment.id, controller)
    patch(attachment.id, { state: 'uploading', error: undefined })
    const project = attachment.source === 'project'
    try {
      const fileRef = await send(attachment, controller.signal)
      if (controller.signal.aborted)
        return
      patch(attachment.id, project
        ? { state: 'done', ref: fileRef, mime: fileRef.mime, size: fileRef.size }
        : { state: 'done', ref: fileRef })
    }
    catch (error) {
      if (controller.signal.aborted || isAbortError(error))
        return
      const failure = toHarnessError(error)
      if ((project ? PERMANENT_PROJECT_CODES : PERMANENT_CODES).has(failure.code)) {
        drop(attachment.id)
        options.onReject?.({
          name: project ? attachment.path ?? attachment.name : attachment.name,
          reason: failure.code === 'payload_too_large' ? 'size' : 'server',
          message: failure.message,
          ...(project ? { source: 'project' as const, path: attachment.path, error: failure } : {}),
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
        source: 'upload',
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

  function addProject(projectId: string, path: string): ComposerAttachment {
    const existing = items.value.find(item => item.source === 'project' && item.projectId === projectId && item.path === path)
    if (existing) {
      if (existing.state === 'error')
        void start(existing)
      return existing
    }
    nextLocalId += 1
    const attachment: ComposerAttachment = {
      id: `att_${nextLocalId}`,
      source: 'project',
      path,
      projectId,
      name: pathBaseName(path),
      size: 0,
      mime: '',
      state: 'uploading',
    }
    items.value = [...items.value, attachment]
    void start(attachment)
    return attachment
  }

  function addRefs(refs: readonly FileRef[]): ComposerAttachment[] {
    const shown = new Set(items.value.flatMap(item => (item.ref ? [item.ref.id] : [])))
    const added: ComposerAttachment[] = []
    for (const fileRef of refs) {
      if (shown.has(fileRef.id))
        continue
      shown.add(fileRef.id)
      nextLocalId += 1
      added.push({
        id: `att_${nextLocalId}`,
        source: 'upload',
        name: fileRef.name,
        size: fileRef.size,
        mime: fileRef.mime,
        // Uploaded images preview from the server (`/api/files/<id>`).
        previewUrl: isImageMime(fileRef.mime) ? fileRef.url : undefined,
        state: 'done',
        ref: fileRef,
      })
    }
    if (added.length > 0)
      items.value = [...items.value, ...added]
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

  return { items, add, addProject, addRefs, remove: drop, retry, clear, uploading, failed, fileRefs, settled }
}
