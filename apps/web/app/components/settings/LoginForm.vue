<script setup lang="ts">
// Login card (docs/UI.md 9.7): brand, "Enter your password", Log in. Errors show under the field: "Wrong password",
// or "Too many attempts. Try again in {n}s." counting down while the button waits. Success goes to `redirect`
// (in-app paths only: starts with a single "/") or "/". TanStack Form (AGENT.md).
import type { LoginFailure } from './login'
import { useForm } from '@tanstack/vue-form'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import BrandMark from '~/components/common/BrandMark.vue'
import { useAuthStore } from '~/stores/auth'
import { afterLoginPath } from '~/utils/redirect'
import { testIds } from '~/utils/testids'
import { loginFailure, rateLimitMessage, secondsUntil } from './login'
import { navigateTo } from './nuxt-imports'

const props = defineProps<{
  /** The raw `?redirect=` query value; anything that is not a safe in-app path means "/". */
  redirect?: unknown
}>()

const auth = useAuthStore()
const failure = ref<LoginFailure | null>(null)
const input = ref<InstanceType<typeof Input> | null>(null)

// Countdown of a rate limit.
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined

function stopTicker() {
  clearInterval(ticker)
  ticker = undefined
}

const waitSeconds = computed(() => secondsUntil(failure.value?.retryAt ?? null, now.value))

watch(failure, (value) => {
  stopTicker()
  now.value = Date.now()
  if (value?.retryAt !== null && value?.retryAt !== undefined) {
    ticker = setInterval(() => {
      now.value = Date.now()
      if (waitSeconds.value === 0)
        stopTicker()
    }, 250)
  }
})

onBeforeUnmount(stopTicker)

const errorText = computed(() => {
  const current = failure.value
  if (!current)
    return null
  if (current.retryAt !== null)
    return waitSeconds.value > 0 ? rateLimitMessage(waitSeconds.value) : null
  return current.message || null
})

function passwordElement(): HTMLInputElement | null {
  return (input.value?.$el ?? null) as HTMLInputElement | null
}

function focusPassword() {
  passwordElement()?.focus()
  passwordElement()?.select()
}

// `autofocus` is not reliable on elements rendered after the page loaded.
onMounted(() => passwordElement()?.focus())

const form = useForm({
  defaultValues: { password: '' },
  onSubmit: async ({ value }) => {
    failure.value = null
    try {
      await auth.login(value.password)
      await navigateTo(afterLoginPath(props.redirect), { replace: true })
    }
    catch (error) {
      failure.value = loginFailure(error)
      focusPassword()
    }
  },
})

const password = form.useSelector(state => state.values.password)
const submitting = form.useSelector(state => state.isSubmitting)
const canSubmit = computed(() => password.value.length > 0 && !submitting.value && waitSeconds.value === 0)

function submit() {
  if (canSubmit.value)
    void form.handleSubmit()
}
</script>

<template>
  <form
    :data-testid="testIds.loginForm"
    aria-label="Log in"
    class="flex flex-col gap-6 rounded-xl border bg-card p-6 shadow-sm"
    novalidate
    @submit.prevent.stop="submit"
  >
    <div class="flex items-center gap-2">
      <BrandMark :size="16" />
      <span class="font-mono text-[13px] font-medium tracking-tight">harness-forge</span>
    </div>
    <!-- Lets password managers file the password under a name. -->
    <input
      type="text"
      name="username"
      value="harness-forge"
      autocomplete="username"
      readonly
      tabindex="-1"
      aria-hidden="true"
      class="sr-only"
    >
    <form.Field name="password">
      <template #default="{ field, state }">
        <div class="flex flex-col gap-2">
          <label for="login-password" class="text-sm font-medium">Enter your password</label>
          <Input
            id="login-password"
            ref="input"
            :model-value="state.value"
            name="password"
            type="password"
            autocomplete="current-password"
            autofocus
            :aria-invalid="errorText ? true : undefined"
            :aria-describedby="errorText ? 'login-error' : undefined"
            :data-testid="testIds.loginPassword"
            @update:model-value="value => field.handleChange(String(value))"
            @blur="field.handleBlur"
          />
          <p
            v-if="errorText"
            id="login-error"
            :data-testid="testIds.loginError"
            role="alert"
            class="text-sm text-destructive tabular-nums"
          >
            {{ errorText }}
          </p>
        </div>
      </template>
    </form.Field>
    <Button
      type="submit"
      class="w-full"
      :disabled="!canSubmit"
      :aria-busy="submitting || undefined"
      :data-testid="testIds.loginSubmit"
    >
      <Spinner v-if="submitting" data-icon="inline-start" />
      Log in
    </Button>
  </form>
</template>
