// What the Settings -> Data sections ask of the page (docs/UI.md 9.8): the summary line reloads after a cleanup, and the
// summary and Shared links reload after a key rotation (every share URL changed). The sections keep their frozen "no
// props, no emits" contracts (docs/UI.md 10.4), so DataSettings provides these through `provide` / `inject`; outside
// DataSettings (a section mounted on its own) every call does nothing.
import type { InjectionKey } from 'vue'
import { inject } from 'vue'

export interface DataSettingsContext {
  /** Reloads the summary line (`GET /api/data`). */
  reloadSummary: () => void
  /** Reloads the Shared links section (its share URLs changed). */
  reloadShares: () => void
}

export const dataSettingsContextKey: InjectionKey<DataSettingsContext> = Symbol('data-settings')

const detached: DataSettingsContext = {
  reloadSummary: () => {},
  reloadShares: () => {},
}

/** The page's context; a no-op one outside DataSettings. Call it in `setup`. */
export function useDataSettingsContext(): DataSettingsContext {
  return inject(dataSettingsContextKey, detached)
}
