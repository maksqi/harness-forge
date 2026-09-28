// State shared by ProviderWizard and its steps (docs/UI.md 8.5): the TanStack form that holds the values, the issues
// computed from them with the shared zod schemas (wizard.ts), which errors to show, and the models fetched in the
// Models step. Provided by ProviderWizard, injected by the steps.
import type { IconRef, ModelInfo, PluginManifest } from '@harness-forge/shared'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { WizardIssues, WizardStep, WizardValues } from './wizard'
import { useForm } from '@tanstack/vue-form'
import { inject } from 'vue'
import { stepOfPath } from './wizard'

export function createWizardForm(initial: WizardValues) {
  return useForm({ defaultValues: initial })
}

export type WizardForm = ReturnType<typeof createWizardForm>

export interface WizardContext {
  form: WizardForm
  /** Current values. */
  values: Readonly<Ref<WizardValues>>
  /** Problems by field path (client checks plus the last server validation). */
  issues: ComputedRef<WizardIssues>
  /** Edit mode (`?edit=<id>`): the id is fixed. */
  editing: ComputedRef<boolean>
  /** The manifest being edited. */
  base: Readonly<Ref<PluginManifest | null>>
  /** Icon of the plugin being edited (its current file icon). */
  existingIcon: Readonly<Ref<IconRef>>
  /** Models found by "Fetch models" (kept while the wizard is open, never persisted). */
  fetched: Ref<ModelInfo[] | null>
  /** The message of `path` when it should be shown: after the field was left, or after Next was pressed. */
  errorOf: (path: string) => string | undefined
  /** Marks a field as left (its error shows from now on). */
  touch: (path: string) => void
  /** Replaces several values at once (templates, format and auth switches) without marking fields as left. */
  patch: (next: Partial<WizardValues>) => void
}

export const WIZARD_CONTEXT: InjectionKey<WizardContext> = Symbol('provider-wizard')

export function useWizardContext(): WizardContext {
  const context = inject(WIZARD_CONTEXT, null)
  if (!context)
    throw new Error('Wizard steps must be rendered inside ProviderWizard.')
  return context
}

/** `errorOf` over the issues, the fields left so far and the steps whose Next was pressed while invalid. */
export function createErrorLookup(
  issues: Readonly<Ref<WizardIssues>>,
  touched: Readonly<Ref<ReadonlySet<string>>>,
  attempted: Readonly<Ref<ReadonlySet<WizardStep>>>,
): (path: string) => string | undefined {
  return (path) => {
    const message = issues.value[path]
    if (message === undefined)
      return undefined
    return touched.value.has(path) || attempted.value.has(stepOfPath(path)) ? message : undefined
  }
}
