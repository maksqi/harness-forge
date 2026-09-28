<script setup lang="ts">
// Login (docs/UI.md 9.7), `auth` layout. STUB (C5), already functional so a password-protected server stays usable
// until W2.5 builds the final page (LoginForm): password -> auth.login() -> ?redirect= (in-app paths only) or /.
// Never renders its own <main> (the auth layout does).
import { computed, ref } from 'vue'
import { navigateTo, useRoute } from '#imports'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import BrandMark from '~/components/common/BrandMark.vue'
import { useAuthStore } from '~/stores/auth'
import { toHarnessError } from '~/utils/errors'
import { afterLoginPath } from '~/utils/redirect'
import { testIds } from '~/utils/testids'

definePageMeta({ layout: 'auth' })

const route = useRoute()
const auth = useAuthStore()

const password = ref('')
const pending = ref(false)
const error = ref<string | null>(null)
const canSubmit = computed(() => password.value.length > 0 && !pending.value)

function messageOf(failure: unknown): string {
  const harnessError = toHarnessError(failure)
  if (harnessError.code === 'unauthorized')
    return 'Wrong password'
  if (harnessError.code === 'rate_limited') {
    const seconds = Math.max(1, Math.ceil((harnessError.retryAfterMs ?? 1000) / 1000))
    return `Too many attempts. Try again in ${seconds}s.`
  }
  return harnessError.message
}

async function submit() {
  if (!canSubmit.value)
    return
  pending.value = true
  error.value = null
  try {
    await auth.login(password.value)
    await navigateTo(afterLoginPath(route.query.redirect), { replace: true })
  }
  catch (failure) {
    error.value = messageOf(failure)
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <form
    :data-testid="testIds.loginForm"
    aria-label="Log in"
    class="flex flex-col gap-6 rounded-xl border bg-card p-6 shadow-sm"
    novalidate
    @submit.prevent="submit"
  >
    <div class="flex items-center gap-2">
      <BrandMark :size="16" />
      <span class="font-mono text-[13px] font-medium tracking-tight">harness-forge</span>
    </div>
    <div class="flex flex-col gap-2">
      <label for="login-password" class="text-sm font-medium">Enter your password</label>
      <Input
        id="login-password"
        :model-value="password"
        :data-testid="testIds.loginPassword"
        type="password"
        autocomplete="current-password"
        autofocus
        :aria-invalid="error ? true : undefined"
        :aria-describedby="error ? 'login-error' : undefined"
        @update:model-value="value => password = String(value)"
      />
      <p
        v-if="error"
        id="login-error"
        :data-testid="testIds.loginError"
        role="alert"
        class="text-sm text-destructive"
      >
        {{ error }}
      </p>
    </div>
    <Button type="submit" :data-testid="testIds.loginSubmit" :disabled="!canSubmit" class="w-full">
      <Spinner v-if="pending" aria-hidden="true" />
      Log in
    </Button>
  </form>
</template>
