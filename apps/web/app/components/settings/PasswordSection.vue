<script setup lang="ts">
// Password block of Settings -> General (docs/UI.md 9.4): status ("No password", "Password set", "Set by
// HF_PASSWORD", read-only), Set / Change / Remove through PasswordDialog, and Log out while a session exists.
import type { PasswordDialogMode } from './password'
import { LockIcon, LockOpenIcon, LogOutIcon, ServerIcon } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import { toastError } from './notify'
import { navigateTo } from './nuxt-imports'
import { passwordState } from './password'
import PasswordDialog from './PasswordDialog.vue'
import SettingsSection from './SettingsSection.vue'

const auth = useAuthStore()

const state = computed(() => passwordState(auth.status))
const hasSession = computed(() => auth.status?.enabled === true && auth.status.authenticated)

const STATUS = {
  none: { label: 'No password', description: 'Anyone who can reach this server can use harness-forge.', icon: LockOpenIcon },
  settings: { label: 'Password set', description: 'Every new browser asks for it before opening harness-forge.', icon: LockIcon },
  env: { label: 'Set by HF_PASSWORD', description: 'The password comes from the server environment. Change it there.', icon: ServerIcon },
  unknown: { label: 'Password status unavailable', description: 'The server did not report whether a password is set.', icon: LockIcon },
} as const

const status = computed(() => STATUS[state.value])

const dialogOpen = ref(false)
const dialogMode = ref<PasswordDialogMode>('set')
const loggingOut = ref(false)

onMounted(() => {
  if (!auth.status)
    auth.fetchStatus().catch(() => {})
})

function openDialog(mode: PasswordDialogMode) {
  dialogMode.value = mode
  dialogOpen.value = true
}

async function logout() {
  loggingOut.value = true
  try {
    await auth.logout()
    await navigateTo('/login')
  }
  catch (error) {
    toastError(error)
  }
  finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <SettingsSection title="Password" description="Protects this server when other people can reach it.">
    <div
      data-slot="password-status"
      :data-state="state"
      class="flex flex-col gap-4 rounded-xl border bg-card p-4 sm:flex-row sm:items-center"
    >
      <div class="flex min-w-0 flex-1 items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <component :is="status.icon" aria-hidden="true" class="size-4" />
        </span>
        <div class="min-w-0">
          <p class="text-sm font-medium">
            {{ status.label }}
          </p>
          <p class="text-sm text-muted-foreground">
            {{ status.description }}
          </p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 sm:justify-end">
        <Button
          v-if="state === 'none'"
          type="button"
          size="sm"
          :data-testid="testIds.passwordSet"
          @click="openDialog('set')"
        >
          Set password
        </Button>
        <template v-else-if="state === 'settings'">
          <Button
            type="button"
            size="sm"
            variant="outline"
            :data-testid="testIds.passwordSet"
            @click="openDialog('change')"
          >
            Change password
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-action="remove-password"
            :data-testid="testIds.passwordRemove"
            class="text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15"
            @click="openDialog('remove')"
          >
            Remove password
          </Button>
        </template>
        <Button
          v-if="hasSession"
          type="button"
          size="sm"
          variant="outline"
          :disabled="loggingOut"
          :data-testid="testIds.logout"
          @click="logout"
        >
          <Spinner v-if="loggingOut" data-icon="inline-start" />
          <LogOutIcon v-else aria-hidden="true" data-icon="inline-start" />
          Log out
        </Button>
      </div>
    </div>
    <PasswordDialog v-model:open="dialogOpen" :mode="dialogMode" />
  </SettingsSection>
</template>
