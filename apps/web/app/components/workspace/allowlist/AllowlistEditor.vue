<script setup lang="ts">
// The shell rules of one scope (docs/UI.md 2.15, 7.23, 9.10; ADR-038), in AllowlistDialog (a project) and
// GlobalAllowlistSection (every project). The containers show the explanation (allowlistDescription) as their
// description; the editor shows the muted risk note, the rules sorted by prefix (allowlist-rule: data-rule-id,
// data-value; mono) with Remove (allowlist-rule-remove, Trash2, "Remove {prefix}"; immediate, no confirmation; focus
// then moves to the next rule's Remove, else the previous one, else the input), the add form (allowlist-input with the
// placeholder "pnpm test", allowlist-add; Enter submits; checkRulePrefix first, then `shellRules.create`; the input
// clears and keeps focus), inline errors (allowlist-error, data-code = the parseShellRule reason or the HarnessError
// code; 409 exists -> "This rule already exists.", other failures -> the server message), the non-blocking one-word
// warning "This allows every {word} command.", "No allowed commands yet." (allowlist-empty) and, when the list could not
// be loaded, "Couldn't load the allowed commands" with Retry. There is no edit: a rule is removed and added again.
// Reads and writes useShellRulesStore; it loads the rules when they were never loaded (joining a load already running,
// e.g. the one of pages/settings/projects.vue).
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props below, no emits; no root test id
// (data-slot="allowlist-editor").
import type { ShellRule } from '@harness-forge/shared'
import type { AllowlistError } from './allowlist'
import { CircleAlertIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { toastError } from '~/components/settings/notify'
import SettingsLoadError from '~/components/settings/SettingsLoadError.vue'
import { useShellRulesStore } from '~/stores/shell-rules'
import { testIds } from '~/utils/testids'
import { checkRulePrefix } from './allow-rule'
import { ALLOWLIST_EMPTY, ALLOWLIST_LOAD_ERROR, ALLOWLIST_RISK_NOTE, allowlistError } from './allowlist'

const props = defineProps<{
  /** The project whose rules are shown; null = the global rules ("Allowed in every project"). */
  projectId: string | null
}>()

const store = useShellRulesStore()
const root = useTemplateRef<HTMLElement>('root')
const ids = { error: useId(), warning: useId() }

const rules = computed<ShellRule[]>(() => (props.projectId === null ? store.global : store.forProject(props.projectId)))

// ---------- load ----------

const loadError = shallowRef<unknown>(null)
const showLoadError = computed(() => loadError.value !== null && !store.loaded)

async function load(): Promise<void> {
  loadError.value = null
  try {
    await store.fetchAll()
  }
  catch (error) {
    loadError.value = error
  }
}

onMounted(() => {
  if (!store.loaded)
    void load()
})

// ---------- add ----------

const draft = ref('')
const adding = ref(false)
const error = shallowRef<AllowlistError | null>(null)

/** The non-blocking warning of a valid one-word prefix, while typing. */
const warning = computed(() => {
  if (draft.value.trim() === '')
    return null
  const check = checkRulePrefix(draft.value)
  return check.ok ? check.warning : null
})

const describedBy = computed(() => (error.value ? ids.error : warning.value ? ids.warning : undefined))

// A new text clears the error of the previous one.
watch(draft, () => {
  error.value = null
})

function inputElement(): HTMLInputElement | null {
  return root.value?.querySelector<HTMLInputElement>(`[data-testid="${testIds.allowlistInput}"]`) ?? null
}

async function add(): Promise<void> {
  if (adding.value)
    return
  const check = checkRulePrefix(draft.value)
  if (!check.ok) {
    error.value = { code: check.code, message: check.message }
    inputElement()?.focus()
    return
  }
  adding.value = true
  try {
    await store.create({ projectId: props.projectId, prefix: check.canonical })
    draft.value = ''
  }
  catch (failure) {
    error.value = allowlistError(failure)
  }
  finally {
    adding.value = false
  }
  await nextTick()
  inputElement()?.focus()
}

// ---------- remove ----------

const removing = new Set<string>()

function removeButtons(): HTMLElement[] {
  return [...(root.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.allowlistRuleRemove}"]`) ?? [])]
}

async function remove(rule: ShellRule): Promise<void> {
  if (removing.has(rule.id))
    return
  removing.add(rule.id)
  const index = rules.value.findIndex(item => item.id === rule.id)
  const hadFocus = root.value?.contains(document.activeElement) ?? false
  try {
    await store.remove(rule.id)
  }
  catch (failure) {
    toastError(failure)
    return
  }
  finally {
    removing.delete(rule.id)
  }
  if (!hadFocus)
    return
  await nextTick()
  // The rule that took its place, else the one before it, else the add input.
  const buttons = removeButtons()
  const next = buttons[Math.min(Math.max(index, 0), buttons.length - 1)]
  if (next)
    next.focus()
  else
    inputElement()?.focus()
}
</script>

<template>
  <div ref="root" data-slot="allowlist-editor" class="flex min-w-0 flex-col gap-3">
    <p class="text-sm text-muted-foreground">
      {{ ALLOWLIST_RISK_NOTE }}
    </p>

    <SettingsLoadError
      v-if="showLoadError"
      :error="loadError"
      :title="ALLOWLIST_LOAD_ERROR"
      :pending="store.loading"
      @retry="load"
    />

    <div v-else-if="!store.loaded" aria-busy="true" class="flex flex-col gap-2">
      <span class="sr-only">Loading allowed commands…</span>
      <Skeleton v-for="n in 2" :key="n" class="h-9 rounded-md" />
    </div>

    <ul v-else-if="rules.length > 0" class="flex min-w-0 flex-col divide-y rounded-lg border">
      <li
        v-for="rule in rules"
        :key="rule.id"
        :data-testid="testIds.allowlistRule"
        :data-rule-id="rule.id"
        :data-value="rule.prefix"
        class="flex min-w-0 items-center gap-2 py-1 pr-1 pl-3"
      >
        <span class="min-w-0 flex-1 truncate font-mono text-sm" :title="rule.prefix">{{ rule.prefix }}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          :aria-label="`Remove ${rule.prefix}`"
          :data-testid="testIds.allowlistRuleRemove"
          class="shrink-0 text-muted-foreground hover:text-destructive pointer-coarse:size-10"
          @click="remove(rule)"
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </li>
    </ul>

    <p v-else :data-testid="testIds.allowlistEmpty" class="text-sm text-muted-foreground">
      {{ ALLOWLIST_EMPTY }}
    </p>

    <form class="flex min-w-0 flex-col gap-1.5" novalidate @submit.prevent="add">
      <div class="flex min-w-0 gap-2">
        <Input
          v-model="draft"
          type="text"
          placeholder="pnpm test"
          aria-label="Start of a command to allow"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="min-w-0 flex-1 font-mono pointer-coarse:h-10"
          :aria-invalid="error ? true : undefined"
          :aria-describedby="describedBy"
          :data-testid="testIds.allowlistInput"
        />
        <Button
          type="submit"
          variant="outline"
          class="shrink-0 pointer-coarse:h-10"
          :aria-busy="adding || undefined"
          :data-testid="testIds.allowlistAdd"
        >
          Add
        </Button>
      </div>
      <p
        v-if="error"
        :id="ids.error"
        role="alert"
        :data-testid="testIds.allowlistError"
        :data-code="error.code"
        class="flex items-start gap-2 text-sm text-destructive"
      >
        <CircleAlertIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
        <span>{{ error.message }}</span>
      </p>
      <p
        v-else-if="warning"
        :id="ids.warning"
        data-slot="allowlist-warning"
        class="flex items-start gap-2 text-sm text-muted-foreground"
      >
        <TriangleAlertIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-warning" />
        <span>{{ warning }}</span>
      </p>
    </form>
  </div>
</template>
