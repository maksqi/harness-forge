// Failure toasts of the settings pages (docs/UI.md 7.4, 9): settings save on change and only a failure shows a toast,
// titled like every other request error outside the transcript.
import { toast } from 'vue-sonner'
import { toHarnessError } from '~/utils/errors'
import { errorTitle } from '../common/harness-error'

/** `toast.error(title, { description })` for anything thrown by a store action. */
export function toastError(error: unknown, providerName?: string): void {
  const harnessError = toHarnessError(error)
  toast.error(errorTitle(harnessError, providerName), { description: harnessError.message })
}
