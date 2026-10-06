// The context CustomizeSettings provides to its rows (Phase 11, W11.8; docs/UI.md 9.13): CustomizationRow's props are
// frozen (`entry`, `busy`), so the output style defaults of the shown scope ("Your default", "Default in {project}") and
// the pending trust item of a project command with `!` lines ("Needs approval", Review…) come through injection. Rows
// rendered without the page (tests, other hosts) show neither.
import type { CustomizationEntry, TrustItem } from '@harness-forge/shared'
import type { ComputedRef, InjectionKey } from 'vue'
import type { StyleDefaults } from './customize'

export interface CustomizeRowContext {
  /** The global default style and the selected project's (null while the settings are unknown). */
  styleDefaults: ComputedRef<StyleDefaults | null>
  /** The pending trust item of a project command row (its `!` lines wait for approval), else null. */
  pendingTrust: (entry: CustomizationEntry) => TrustItem | null
}

export const CUSTOMIZE_ROW_CONTEXT: InjectionKey<CustomizeRowContext> = Symbol('customize-row-context')

/**
 * Phase 12 (ADR-056; C46, W12.12 owns it in P12-A): what HooksPanel provides to its rows (HookRow's props are frozen):
 * whether the hooks of the selected project's settings files can be edited from here (Edit… on project rows opens the
 * hook editor in project mode). Rows rendered without the panel offer no project Edit….
 */
export interface HookRowContext {
  /** A project is selected and its settings files can be written (`PUT /projects/:id/definitions/file`). */
  editProjectHooks: ComputedRef<boolean>
}

export const HOOK_ROW_CONTEXT: InjectionKey<HookRowContext> = Symbol('hook-row-context')
