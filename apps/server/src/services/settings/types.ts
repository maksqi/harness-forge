// Frozen interface of the global settings service (API.md 4.3 `Settings`, table `settings`).
// Implementation: `createSettingsService(deps)` in `services/settings/index.ts` (W1.2).
import type { Settings, SettingsUpdate } from '@harness-forge/shared'

/**
 * Internal keys of the `settings` table: prefix `_`, never returned by the API (e.g. `_auth.sessionEpoch`).
 */
export type InternalSettingKey = `_${string}`

/** Internal key holding the session epoch (sessions with another epoch are rejected, ARCHITECTURE.md 10.1). */
export const SESSION_EPOCH_KEY = '_auth.sessionEpoch' satisfies InternalSettingKey

export interface SettingsService {
  /** Every key with defaults applied (`DEFAULT_SETTINGS`); invalid stored values fall back to their default. Cached. */
  readonly get: () => Promise<Settings>
  /**
   * Validates a partial update (`settingsUpdateSchema`: strict, at least one key; model refs are checked for format
   * only), persists it and returns the full settings. Throws `validation_error`.
   */
  readonly update: (patch: SettingsUpdate) => Promise<Settings>
  /** An internal value, or undefined when unset. */
  readonly getInternal: <T = unknown>(key: InternalSettingKey) => Promise<T | undefined>
  /** Sets (or removes with `undefined`) an internal value. */
  readonly setInternal: (key: InternalSettingKey, value: unknown) => Promise<void>
}
