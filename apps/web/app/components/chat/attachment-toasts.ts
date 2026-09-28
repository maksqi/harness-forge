// Toasts for files that cannot be attached (docs/UI.md 7.5, 7.7): the texts of the composer, for the message editor's
// own `useComposerAttachments()` instance (S8). One place, so both surfaces read the same.
import type { AttachmentRejectionInfo } from '~/composables/useComposerAttachments'
import { LIMITS } from '@harness-forge/shared'
import { toast } from 'vue-sonner'

const UPLOAD_LIMIT_MB = Math.round(LIMITS.uploadBytes / (1024 * 1024))

/** Title and description of the toast for a rejected file. */
export function attachmentRejectionText(rejection: AttachmentRejectionInfo): { title: string, description?: string } {
  if (rejection.reason === 'size')
    return { title: `${rejection.name} is too large`, description: `Files can be up to ${UPLOAD_LIMIT_MB} MB.` }
  if (rejection.reason === 'type')
    return { title: `${rejection.name} can't be attached`, description: 'Attach images, PDFs or text files.' }
  return rejection.message
    ? { title: `${rejection.name} can't be attached`, description: rejection.message }
    : { title: `${rejection.name} can't be attached` }
}

/** Shows the error toast for a file that was not attached (`useComposerAttachments({ onReject })`). */
export function toastAttachmentRejection(rejection: AttachmentRejectionInfo): void {
  const { title, description } = attachmentRejectionText(rejection)
  if (description)
    toast.error(title, { description })
  else
    toast.error(title)
}
