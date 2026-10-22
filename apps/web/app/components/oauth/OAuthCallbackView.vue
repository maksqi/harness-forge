<script setup lang="ts">
// The sign-in callback page's body (Phase 14, ADR-059; docs/UI.md 2.20, 6, 8.14, 10.10): on mount it reads `code`,
// `state`, `error`, `error_description` and `iss` from the query once (`readCallbackQuery`) and calls `router.replace({
// query: {} })` before anything else, then `useMcpSignIn().complete(…)` (`POST /mcp/oauth/callback` with the session
// cookie): `working` (a `role="status"` spinner "Finishing sign-in…"), `success` (`navigateTo(returnTo ?? fallback, {
// replace: true })` and the toast "Signed in to {server}."), `error` (`oauth-callback-error`, `data-code`, `role="alert"`:
// the provider's or the server's text as plain text, at most 300 characters; a used or expired link reads "This sign-in
// link was already used or expired."; Try again (`oauth-callback-retry`) and Back to MCP servers (`oauth-callback-back`)).
// It never renders the code or the state. Mounted by `pages/oauth/callback.vue` (layout `auth`).
// No props, no emits; the root test id is frozen from Gate P14-0b (C54 stub); W14.7 implements the page in P14-A.
// Try again appears only when the failed answer names its server (`details.target` / `details.serverId`); it starts a new
// sign-in that returns to the server list. The error card takes focus once it shows.
import type { McpAuthTarget } from '@harness-forge/shared'
import { CircleAlertIcon, Loader2Icon, LogInIcon } from '@lucide/vue'
import { nextTick, onMounted, ref, useTemplateRef } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import BrandMark from '~/components/common/BrandMark.vue'
import { navigateTo, useRoute, useRouter } from '~/components/settings/nuxt-imports'
import { useMcpSignIn } from '~/composables/useMcpSignIn'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectMcpStore } from '~/stores/project-mcp'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  CALLBACK_NO_STATE_CODE,
  CALLBACK_NO_STATE_TEXT,
  callbackErrorText,
  callbackFallback,
  callbackRetryTarget,
  readCallbackQuery,
} from './oauth-callback'

type ViewState = 'working' | 'success' | 'error'

interface CallbackFailure {
  /** The answer's error code (`data-code`). */
  code: string
  /** Plain text, at most 300 characters. */
  text: string
  /** The server the answer named (Try again), else null. */
  target: McpAuthTarget | null
}

const route = useRoute()
const router = useRouter()
const signIn = useMcpSignIn()
const plugins = usePluginsStore()
const projectMcp = useProjectMcpStore()

// Read once, in setup: the query leaves the history before the request.
const body = readCallbackQuery(route.query)

const state = ref<ViewState>('working')
const failure = ref<CallbackFailure | null>(null)
const retrying = ref(false)
const card = useTemplateRef<HTMLElement>('card')

/** The server's display name from the refetched lists, else its id. */
function serverName(target: McpAuthTarget): string {
  if (target.kind === 'global')
    return plugins.mcp.find(server => server.id === target.serverId)?.name ?? target.serverId
  return projectMcp.byId(target.projectId, target.serverId)?.name ?? target.serverId
}

async function fail(next: CallbackFailure): Promise<void> {
  failure.value = next
  state.value = 'error'
  await nextTick()
  card.value?.focus()
}

function failWith(error: unknown): Promise<void> {
  const harnessError = toHarnessError(error)
  return fail({ code: harnessError.code, text: callbackErrorText(harnessError), target: callbackRetryTarget(harnessError) })
}

async function finish(): Promise<void> {
  try {
    await router.replace({ query: {} })
  }
  catch {
    // A refused navigation keeps the page; the request still runs.
  }
  if (body === null) {
    await fail({ code: CALLBACK_NO_STATE_CODE, text: CALLBACK_NO_STATE_TEXT, target: null })
    return
  }
  try {
    const result = await signIn.complete(body)
    state.value = 'success'
    toast.success(`Signed in to ${serverName(result.target)}.`)
    await navigateTo(result.returnTo ?? callbackFallback(result.target), { replace: true })
  }
  catch (error) {
    await failWith(error)
  }
}

onMounted(() => {
  void finish()
})

async function retry(): Promise<void> {
  const target = failure.value?.target
  if (!target || retrying.value)
    return
  retrying.value = true
  try {
    const fallback = callbackFallback(target)
    const outcome = await signIn.start(target, { returnTo: fallback, name: serverName(target) })
    // `redirected`: the page leaves, the button stays busy. `authorized`: the server works again.
    if (outcome === 'authorized') {
      retrying.value = false
      await navigateTo(fallback, { replace: true })
    }
  }
  catch (error) {
    retrying.value = false
    await failWith(error)
  }
}

function back(): void {
  void navigateTo(callbackFallback(failure.value?.target ?? null), { replace: true })
}
</script>

<template>
  <div
    :data-testid="testIds.oauthCallback"
    :data-state="state"
    class="flex flex-col gap-5 rounded-xl border bg-card p-6 shadow-sm"
  >
    <h1 class="sr-only">
      Signing in to an MCP server
    </h1>
    <div class="flex items-center justify-center gap-2">
      <BrandMark :size="16" />
      <span class="font-mono text-[13px] font-medium tracking-tight">harness-forge</span>
    </div>

    <p v-if="state !== 'error'" role="status" class="flex items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2Icon aria-hidden="true" class="size-4 animate-spin motion-reduce:animate-none" />
      Finishing sign-in…
    </p>

    <div
      v-else-if="failure"
      ref="card"
      tabindex="-1"
      role="alert"
      :data-testid="testIds.oauthCallbackError"
      :data-code="failure.code"
      class="grid gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <p class="flex items-center gap-2 font-medium">
        <CircleAlertIcon aria-hidden="true" class="size-4 shrink-0 text-destructive" />
        Sign-in failed
      </p>
      <p class="text-sm break-words text-foreground/80">
        {{ failure.text }}
      </p>
      <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          v-if="failure.target"
          type="button"
          :disabled="retrying"
          :aria-busy="retrying || undefined"
          :data-testid="testIds.oauthCallbackRetry"
          class="pointer-coarse:h-10"
          @click="retry"
        >
          <Spinner v-if="retrying" data-icon="inline-start" />
          <LogInIcon v-else aria-hidden="true" data-icon="inline-start" />
          Try again
        </Button>
        <Button
          type="button"
          variant="outline"
          :data-testid="testIds.oauthCallbackBack"
          class="pointer-coarse:h-10"
          @click="back"
        >
          Back to MCP servers
        </Button>
      </div>
    </div>
  </div>
</template>
