<script setup lang="ts">
// Add / edit an MCP server of the MCP panel (docs/UI.md 8.12): name, id (slug of the name until edited; fixed when
// editing), transport tabs stdio (command, arguments one per line, environment rows) / HTTP / SSE (URL, header rows),
// and the approval policy. Header and environment VALUES are write-only secrets (scope `mcp:<id>`): stored rows start
// empty with the masked hint as placeholder, an empty input keeps the stored value, and every typed value is dropped
// when the dialog closes. Saving a stdio server is a fresh-auth action (docs/UI.md 8.4, ADR-017; useFreshAuth with
// `required` for such a request): with a password set and a stale session the password is asked first, and a
// `403 forbidden` + `action: 'login'` answer is followed by one prompt and one more run.
import type { McpServer } from '@harness-forge/shared'
import type { McpFormErrors, McpFormState, McpSaveRequest, McpTransportType } from './mcp-form'
import { TerminalIcon } from '@lucide/vue'
import { computed, reactive, ref, useId, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import {
  buildCreateInput,
  buildUpdatePatch,
  emptyForm,
  formFromServer,
  newRow,
  POLICY_OPTIONS,
  policyLabel,
  requiresFreshAuth,
  saveErrorFields,
  schemaErrors,
  slugify,
  TRANSPORT_OPTIONS,
  validateForm,
} from './mcp-form'
import McpSecretRows from './McpSecretRows.vue'

// Attributes go to the dialog content, not to the renderless dialog root.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{ open: boolean, server?: McpServer | null }>(), { server: null })

const emit = defineEmits<{
  'update:open': [value: boolean]
  'saved': [server: McpServer]
}>()

// URL literals stay out of template props: vue-tsc 3.3.12 breaks on `//` inside a component prop value
// (vuejs/language-tools#6240).
const URL_PLACEHOLDERS = { http: 'https://mcp.example.com/mcp', sse: 'https://mcp.example.com/sse' } as const

/** Two example arguments, one per line. */
const ARGS_PLACEHOLDER = '-y\n@modelcontextprotocol/server-everything'

type Phase = 'idle' | 'saving'
type SecretList = 'headers' | 'env'

const plugins = usePluginsStore()
const freshAuth = useFreshAuth()

const ids = {
  name: useId(),
  id: useId(),
  idHelp: useId(),
  command: useId(),
  args: useId(),
  argsHelp: useId(),
  url: useId(),
  policy: useId(),
  policyHelp: useId(),
  transport: useId(),
}

const form = reactive<McpFormState>(emptyForm())
const phase = ref<Phase>('idle')
/** Validation runs live once a save was attempted. */
const attempted = ref(false)
/** Messages of the last failed request (or of the schema check), cleared when the form changes. */
const serverErrors = ref<McpFormErrors>({})
// Bumped on every open and close, so a request that outlives its dialog session cannot touch the next one.
let session = 0

const editing = computed(() => props.server !== null)
const mode = computed<'create' | 'edit'>(() => (editing.value ? 'edit' : 'create'))
const busy = computed(() => phase.value !== 'idle')
/** The save request runs (not while the password prompt waits for the user). */
const saving = computed(() => phase.value === 'saving' && !freshAuth.open.value)
const clientErrors = computed<McpFormErrors>(() => (attempted.value ? validateForm(form, mode.value) : {}))
const errors = computed<McpFormErrors>(() => ({ ...serverErrors.value, ...clientErrors.value }))
const dirty = computed(() => (props.server ? Object.keys(buildUpdatePatch(props.server, form)).length > 0 : true))
const canSave = computed(() => !busy.value && dirty.value)
const title = computed(() => (props.server ? `Edit ${props.server.name}` : 'Add MCP server'))

function resetForm(server: McpServer | null) {
  Object.assign(form, server ? formFromServer(server) : emptyForm())
  attempted.value = false
  serverErrors.value = {}
  phase.value = 'idle'
  // A waiting password prompt belongs to the dialog session that ends here.
  freshAuth.cancel()
}

watch(() => [props.open, props.server?.id ?? null] as const, ([open]) => {
  session += 1
  // Typed secrets never outlive the dialog: closing resets the form too.
  resetForm(open ? props.server : null)
}, { immediate: true })

// A changed form invalidates the messages of the last request.
watch(form, () => {
  if (Object.keys(serverErrors.value).length > 0)
    serverErrors.value = {}
}, { deep: true })

// On create the id follows the name until the user types one.
watch(() => form.name, (name) => {
  if (!editing.value && !form.idEdited)
    form.id = slugify(name)
})

function onIdInput(value: string | number) {
  const next = String(value).toLowerCase()
  if (next.trim() === '') {
    form.idEdited = false
    form.id = slugify(form.name)
    return
  }
  form.idEdited = true
  form.id = next
}

function setType(value: string | number) {
  const option = TRANSPORT_OPTIONS.find(item => item.value === value)
  if (option)
    form.type = option.value as McpTransportType
}

function onPolicy(value: unknown) {
  const option = POLICY_OPTIONS.find(item => item.value === value)
  if (option)
    form.policy = option.value
}

function addRow(list: SecretList) {
  form[list] = [...form[list], newRow()]
}

function removeRow(list: SecretList, uid: number) {
  form[list] = form[list].filter(row => row.uid !== uid)
}

function updateRow(list: SecretList, uid: number, field: 'name' | 'value', value: string) {
  const row = form[list].find(item => item.uid === uid)
  if (!row || (field === 'name' && row.stored !== null))
    return
  row[field] = value
}

function onOpenChange(value: boolean) {
  // A save in flight finishes first.
  if (!value && saving.value)
    return
  emit('update:open', value)
}

function currentRequest(): McpSaveRequest {
  if (props.server)
    return { kind: 'update', id: props.server.id, patch: buildUpdatePatch(props.server, form) }
  return { kind: 'create', input: buildCreateInput(form) }
}

async function send(request: McpSaveRequest): Promise<void> {
  const current = session
  phase.value = 'saving'
  serverErrors.value = {}
  try {
    const input = request.kind === 'create' ? request.input : { id: request.id, patch: request.patch }
    const saved = await freshAuth.run(() => plugins.saveMcp(input), { required: requiresFreshAuth(request) })
    if (current !== session)
      return
    phase.value = 'idle'
    toast.success(request.kind === 'create' ? `Added ${saved.name}` : `Saved ${saved.name}`)
    emit('saved', saved)
    emit('update:open', false)
  }
  catch (error) {
    if (current !== session)
      return
    phase.value = 'idle'
    if (!isFreshAuthCancelled(error))
      serverErrors.value = saveErrorFields(error, form, mode.value)
  }
}

async function onSave() {
  if (!canSave.value)
    return
  attempted.value = true
  serverErrors.value = {}
  if (Object.keys(validateForm(form, mode.value)).length > 0)
    return
  const request = currentRequest()
  const problems = schemaErrors(request, form)
  if (Object.keys(problems).length > 0) {
    serverErrors.value = problems
    return
  }
  await send(request)
}

function secretListOf(type: McpTransportType): SecretList {
  return type === 'stdio' ? 'env' : 'headers'
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :data-testid="testIds.mcpDialog"
      :data-mode="mode"
      class="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-xl"
      v-bind="$attrs"
    >
      <form class="grid gap-5" novalidate @submit.prevent="onSave">
        <DialogHeader>
          <DialogTitle class="truncate pr-8">
            {{ title }}
          </DialogTitle>
          <DialogDescription>
            Its tools become tools of the chat. Header and environment values are stored encrypted and never shown again.
          </DialogDescription>
        </DialogHeader>

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="grid content-start gap-2">
            <Label :for="ids.name">Name</Label>
            <Input
              :id="ids.name"
              :model-value="form.name"
              :disabled="busy"
              :aria-invalid="errors.name ? true : undefined"
              data-field="name"
              placeholder="GitHub"
              autocomplete="off"
              maxlength="100"
              @update:model-value="value => (form.name = String(value))"
            />
            <p v-if="errors.name" role="alert" class="text-xs text-destructive">
              {{ errors.name }}
            </p>
          </div>
          <div class="grid content-start gap-2">
            <Label :for="ids.id">Id</Label>
            <Input
              :id="ids.id"
              :model-value="form.id"
              :readonly="editing"
              :disabled="busy"
              :aria-invalid="errors.id ? true : undefined"
              :aria-describedby="errors.id ? undefined : ids.idHelp"
              data-field="id"
              placeholder="github"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              maxlength="32"
              class="font-mono text-[13px] read-only:bg-muted/50 read-only:text-muted-foreground placeholder:font-sans placeholder:text-sm"
              @update:model-value="onIdInput"
            />
            <p v-if="errors.id" role="alert" class="text-xs text-destructive">
              {{ errors.id }}
            </p>
            <p v-else :id="ids.idHelp" class="text-xs text-muted-foreground">
              {{ editing ? 'The id cannot change.' : 'Its tools are named mcp__<id>__<tool>.' }}
            </p>
          </div>
        </div>

        <div role="group" :aria-labelledby="ids.transport" class="grid gap-2">
          <span :id="ids.transport" class="text-sm font-medium">Transport</span>
          <Tabs :model-value="form.type" @update:model-value="setType">
            <TabsList class="w-full">
              <TabsTrigger
                v-for="option in TRANSPORT_OPTIONS"
                :key="option.value"
                :value="option.value"
                :disabled="busy"
                :data-testid="testIds.mcpTransportTab"
                :data-value="option.value"
              >
                {{ option.label }}
              </TabsTrigger>
            </TabsList>

            <TabsContent
              v-for="option in TRANSPORT_OPTIONS"
              :key="option.value"
              :value="option.value"
              class="grid gap-4 pt-2"
            >
              <template v-if="option.value === 'stdio'">
                <p
                  data-slot="mcp-stdio-note"
                  class="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm dark:bg-warning/10"
                >
                  <TerminalIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-warning" />
                  <span>Runs a local command on your server.</span>
                </p>
                <div class="grid gap-2">
                  <Label :for="ids.command">Command</Label>
                  <Input
                    :id="ids.command"
                    :model-value="form.command"
                    :disabled="busy"
                    :aria-invalid="errors.command ? true : undefined"
                    data-field="command"
                    placeholder="npx"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                    @update:model-value="value => (form.command = String(value))"
                  />
                  <p v-if="errors.command" role="alert" class="text-xs text-destructive">
                    {{ errors.command }}
                  </p>
                </div>
                <div class="grid gap-2">
                  <Label :for="ids.args">
                    Arguments <span class="font-normal text-muted-foreground">(one per line)</span>
                  </Label>
                  <Textarea
                    :id="ids.args"
                    :model-value="form.args"
                    :disabled="busy"
                    :aria-invalid="errors.args ? true : undefined"
                    :aria-describedby="errors.args ? undefined : ids.argsHelp"
                    data-field="args"
                    :placeholder="ARGS_PLACEHOLDER"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    rows="3"
                    class="max-h-48 font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                    @update:model-value="value => (form.args = String(value))"
                  />
                  <p v-if="errors.args" role="alert" class="text-xs text-destructive">
                    {{ errors.args }}
                  </p>
                  <p v-else :id="ids.argsHelp" class="text-xs text-muted-foreground">
                    Started without a shell. Keep secrets in environment variables: other local users can see arguments.
                  </p>
                </div>
              </template>

              <div v-else class="grid gap-2">
                <Label :for="ids.url">URL</Label>
                <Input
                  :id="ids.url"
                  :model-value="form.url"
                  type="url"
                  :disabled="busy"
                  :aria-invalid="errors.url ? true : undefined"
                  data-field="url"
                  :placeholder="option.value === 'sse' ? URL_PLACEHOLDERS.sse : URL_PLACEHOLDERS.http"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                  @update:model-value="value => (form.url = String(value))"
                />
                <p v-if="errors.url" role="alert" class="text-xs text-destructive">
                  {{ errors.url }}
                </p>
              </div>

              <McpSecretRows
                :kind="secretListOf(option.value)"
                :rows="form[secretListOf(option.value)]"
                :errors="errors"
                :disabled="busy"
                @add="addRow(secretListOf(option.value))"
                @remove="uid => removeRow(secretListOf(option.value), uid)"
                @update="(uid, field, value) => updateRow(secretListOf(option.value), uid, field, value)"
              />
            </TabsContent>
          </Tabs>
        </div>

        <div class="grid gap-2">
          <Label :for="ids.policy">Approval policy</Label>
          <Select :model-value="form.policy" :disabled="busy" @update:model-value="onPolicy">
            <SelectTrigger
              :id="ids.policy"
              :aria-describedby="ids.policyHelp"
              data-field="policy"
              :data-value="form.policy"
              class="w-full sm:w-56"
            >
              <span>{{ policyLabel(form.policy) }}</span>
            </SelectTrigger>
            <SelectContent position="popper" align="start" class="w-64">
              <SelectItem
                v-for="option in POLICY_OPTIONS"
                :key="option.value"
                :value="option.value"
                :data-value="option.value"
              >
                <span class="flex flex-col gap-0.5">
                  <span>{{ option.label }}</span>
                  <span class="text-xs text-muted-foreground">{{ option.description }}</span>
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          <p :id="ids.policyHelp" class="text-xs text-muted-foreground">
            Tools marked read-only by the server are always Safe and destructive tools always ask.
          </p>
        </div>

        <p v-if="errors.form" role="alert" data-field="form-error" class="text-sm text-destructive">
          {{ errors.form }}
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" :disabled="saving" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button
            type="submit"
            :disabled="!canSave"
            :aria-busy="saving || undefined"
            :data-testid="testIds.mcpSave"
          >
            <Spinner v-if="saving" data-icon="inline-start" />
            {{ editing ? 'Save' : 'Add server' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <ConfirmPasswordDialog
    :open="freshAuth.open.value"
    description="Saving a server that runs a local command needs your password."
    :pending="freshAuth.pending.value"
    :error="freshAuth.error.value"
    @update:open="freshAuth.setOpen"
    @submit="freshAuth.submit"
  />
</template>
