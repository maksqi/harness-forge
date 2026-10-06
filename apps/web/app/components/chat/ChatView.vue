<script setup lang="ts">
// Transcript + composer of one chat (docs/UI.md 2.1, 2.2, 5.7-5.9, 7.6; contract in 10.4). The session comes from the
// registry (useChatSession), so leaving the page never stops a stream and coming back shows it still running. A new
// chat (`isNew`, the `/` page) shows the `empty` slot above an inline composer; its first send emits `created` so
// the page can move to /chat/<id> while the same session keeps streaming. Otherwise the transcript fills the pane and
// the composer is docked over its bottom (fade above it); `--hf-composer-h` feeds the transcript's bottom padding
// and the scroll pill position. A polite live region announces finished / stopped replies, approvals, errors, the
// version shown after a switch (ADR-023) and a deleted version. "Delete this version" (ADR-030) is confirmed here, in
// one ConfirmDialog; afterwards focus moves to the version now shown (or back to the button when nothing changed).
// The composer learns how many images the last reply holds ("Edit the previous image", ADR-028).
// Phase 7 (ADR-031): the session's project goes to the header slot (chip, "Move to project"), the empty slot (the
// new-chat picker) and the composer (Accept edits is offered in project chats); a chat request held off by a master-key
// rotation (`409 busy`, ADR-034) puts the message back into the composer with a toast. Approval cards learn the chat's
// permission mode and project name (TOOL_APPROVAL_CONTEXT: no "Accept all edits" in a chat that already accepts edits,
// "In {project}" on a shell approval).
// Phase 8 (ADR-036, ADR-038): the context also gives the cards the chat's project (the scope of a shell rule) and its
// sticky shell folder (session.cwd); a shell approval whose rules could not be saved shows "Could not save the rule".
// The transcript learns the chat's project ("Rewind files to here" only in project chats); the button opens the
// RewindDialog owned here: a restore shows the result toast with Undo (useRewindResultToast); "Restore files and edit"
// then opens the editor on the message (the existing edit / branch flow); a refused rewind comes back through
// REWIND_DIALOG_HOST: `409 run-active` -> "Wait for the responses in this project to finish before rewinding files."
// and, when this chat is the one running, the run is followed; `404` -> the stale-chat toast and a reload of the path.
// Closing the dialog any other way puts focus back on the button.
// Phase 9 (ADR-040 - ADR-042; C25 mounts, W9.9 implements; frozen from Gate P9-0b): the dock stacks TodoStrip (the
// session's `todos`) and QueuedMessages (the session's `queue`) above the composer; the transcript gets the session's
// transient `activity`. A submit while a run is active is queued by the session (announced "Message queued"; a full
// queue or another failure puts the text back into the composer with a toast); Stop hands the queued messages it
// dropped back to this tab's composer (`restoreQueued`); Cancel and Edit on a queued message cancel it ("Already sent to
// the agent." when it was delivered meanwhile), Edit then restores it. A plan approval's `planMode` / `reason` reach the
// session through the approval payload; the decision is announced ("Plan approved. Permission mode: Accept edits." /
// "Feedback sent. The agent keeps planning.") and focus goes back to the composer. A compaction marker that arrives in
// this tab's stream is announced once ("Conversation compacted").
// Phase 10 (ADR-046; C33 mounts, W10.10 implements; frozen from Gate P10-0b): BackgroundAgents sits in the dock between
// TodoStrip and QueuedMessages with the session's visible background agents; its Stop goes through the session ('gone'
// -> "It already finished.", other failures "Could not stop the background agent"), Stop all through the store (one
// at a time), and the composer's Stop and Esc never touch them. AGENT_TASK_CONTEXT gives the task blocks the live task,
// the delivered result of the shown path (`taskResultsOf`), the dock reveal (open the list, expand and focus the row)
// and "Go to the result" (scroll to the note, open its report, focus its toggle); BACKGROUND_TASK_INPUT gives the dock's
// rows the input of the launching `task` call. A turn the server started for finished background agents (`run.started`
// with `origin: 'task'`) announces "Background agent finished: {description}" for each result of its carrier once the
// carrier shows (the session reloads the path, then resumes), unless the dock already announced that agent's ending in
// this tab (`announcedTasks`: one announcement per agent and tab).
// Phase 11 (ADR-048 - ADR-051; C39 mounts, W11.11 implements; frozen from Gate P11-0b): the view hosts the project trust
// and project MCP dialogs of the chat's project (CHAT_VIEW_ACTIONS `openProjectTrust(focusKey?)` / `openProjectMcp
// (serverId?)`, used by the header's trust chip, the chat-chip menu, the composer refusal's Review… and the notices),
// provides the session's `hookActivity` (HOOK_ACTIVITY: the tool rows' "Running hook…"), passes the chat's own output
// style to the composer (`session.outputStyle`, never pinned), and puts a submit refused with 409 `hook-blocked` /
// `untrusted` (`refusalOf`) back into the composer (`restoreInput`, text and files) with its refusal (`showRefusal`),
// for a new turn (the `error` watcher) and for a queued message (`onSubmitFailed`).
import type { HarnessError, MessageBranch, ReasoningEffort, RestoreResult, ToolMode } from '@harness-forge/shared'
import type { FileUIPart } from 'ai'
import type { ChatComposerExposed, ComposerSubmitInput } from '~/components/chat/composer/types'
import type { ToolApprovalDecision } from '~/composables/useChatSession'
import { compactionMarkers } from '@harness-forge/shared'
import { useElementSize } from '@vueuse/core'
import { isToolUIPart } from 'ai'
import { computed, nextTick, onMounted, provide, ref, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import ChatComposer from '~/components/chat/composer/ChatComposer.vue'
import { refusalOf } from '~/components/chat/composer/output-style'
import { toolModeOption } from '~/components/chat/composer/permission'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { toHarnessErrorView } from '~/components/common/harness-error'
import ProjectMcpDialog from '~/components/projects/mcp/ProjectMcpDialog.vue'
import ProjectTrustDialog from '~/components/projects/trust/ProjectTrustDialog.vue'
import { REWIND_DIALOG_HOST, REWIND_RUN_ACTIVE_MESSAGE, runningChatOf } from '~/components/workspace/rewind/rewind'
import { useRewindResultToast } from '~/components/workspace/rewind/rewind-toast'
import RewindDialog from '~/components/workspace/rewind/RewindDialog.vue'
import { isBusyConflict, isRunActiveConflict, useChatSession } from '~/composables/useChatSession'
import { useServerEvents } from '~/composables/useServerEvents'
import { useBackgroundTasksStore } from '~/stores/background-tasks'
import { QUEUE_ITEM_GONE_MESSAGE } from '~/stores/chat-queue'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectsStore } from '~/stores/projects'
import { useProvidersStore } from '~/stores/providers'
import { useUiStore } from '~/stores/ui'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { taskInputOf } from './agent/agent-tools'
import TodoStrip from './agent/TodoStrip.vue'
import {
  announcedTasks,
  BACKGROUND_GONE_MESSAGE,
  BACKGROUND_STOP_FAILED_MESSAGE,
  endedAnnouncement,
  visibleTasks,
} from './background/background-agents'
import BackgroundAgents from './background/BackgroundAgents.vue'
import { AGENT_TASK_CONTEXT, BACKGROUND_TASK_INPUT, CHAT_VIEW_ACTIONS, HOOK_ACTIVITY } from './chat-context'
import { imageFileParts, isTaskResultMessage, messageText, PLAN_TOOL_NAME, taskResultsOf, toolNameOf } from './chat-format'
import ChatNotFound from './ChatNotFound.vue'
import ChatTranscript from './ChatTranscript.vue'
import { TOOL_APPROVAL_CONTEXT } from './parts/tool-approval-context'
import { toolApprovalLabel } from './parts/tool-row'
import QueuedMessages from './queue/QueuedMessages.vue'

const props = withDefaults(defineProps<{
  chatId: string
  /** The `/` page: no history to load; the first send emits `created`. */
  isNew?: boolean
}>(), {
  isNew: false,
})

const emit = defineEmits<{
  /** After the first send of a new chat. */
  created: [chatId: string]
}>()

defineSlots<{
  /**
   * Above the transcript (the chat header); `scrolled` = the transcript left its top; `projectId` = the chat's project
   * (null = none).
   */
  header?: (props: { scrolled: boolean, title: string | null, loading: boolean, projectId: string | null }) => any
  /**
   * Above the inline composer of an empty new chat (greeting, the project picker, callouts): the project the first send
   * carries and its setter.
   */
  empty?: (props: { projectId: string | null, setProject: (projectId: string | null) => void }) => any
}>()

const session = useChatSession(props.chatId, { isNew: props.isNew })
const chats = useChatsStore()
const models = useModelsStore()
const plugins = usePluginsStore()
const projects = useProjectsStore()
const providers = useProvidersStore()
const ui = useUiStore()
const backgroundTasks = useBackgroundTasksStore()

const composer = useTemplateRef<ChatComposerExposed>('composer')
const transcript = useTemplateRef<InstanceType<typeof ChatTranscript>>('transcript')
const dock = useTemplateRef<HTMLElement>('dock')
const { height: dockHeight } = useElementSize(dock, undefined, { box: 'border-box' })

const messages = computed(() => session.chat.messages.value)
const status = computed(() => session.chat.status.value)
const error = computed(() => session.chat.error.value ?? null)
const modelRef = session.modelRef
const reasoningEffort = session.reasoningEffort
const toolMode = session.toolMode
const loaded = session.loaded
const notFound = session.notFound
const loadError = session.loadError
const branches = session.branches
const switching = session.switching
const projectId = session.projectId
/** + Phase 9: the dock and the streaming row. */
const queue = session.queue
const todos = session.todos
const activity = session.activity
/** + Phase 11: the chat's own output style (null = Automatic). */
const outputStyle = session.outputStyle
/** A run of this chat is active (this tab's request, or one the chats store reports). */
const runActive = computed(() => session.busy.value || chats.runState[props.chatId] === 'running')
/** Queued messages wait for the next run while the chat awaits an approval. */
const waitingForApproval = computed(() => session.runState.value === 'approval')
/** Queued messages whose cancel is in flight. */
const cancellingQueued = ref<string[]>([])

/** docs/UI.md 7.4: a run holds the chat (`409 conflict`, reason `run-active`). */
const RUN_ACTIVE_MESSAGE = 'A response is already running in this chat.'
/** A `404` to a chat request or a switch: the shown path was stale and the session reloaded it. */
const STALE_CHAT_MESSAGE = 'This chat changed elsewhere and was reloaded.'
/** docs/UI.md 7.4: a chat request answered `409 conflict` (`busy`): a master-key rotation holds off new runs. */
const KEY_ROTATION_BUSY_MESSAGE = 'The server is rotating its encryption key. Try again in a moment.'
/** docs/UI.md 7.26: the chat's queue already holds 10 messages (`409 conflict`, reason `queue-full`). */
const QUEUE_FULL_MESSAGE = 'The queue is full. Wait for the agent to take a message.'

const scrolled = ref(false)
const showEmpty = computed(() => props.isNew && messages.value.length === 0 && !session.busy.value)
const noProvider = computed(() => providers.loaded && !providers.hasUsableProvider)
const title = computed(() => chats.byId(props.chatId)?.title ?? session.summary.value?.title ?? null)
const composerStyle = computed(() => (dockHeight.value > 0 ? { '--hf-composer-h': `${Math.round(dockHeight.value)}px` } : {}))

const lastUsage = computed(() => {
  for (let index = messages.value.length - 1; index >= 0; index--) {
    const message = messages.value[index]!
    if (message.role === 'assistant' && message.metadata?.usage)
      return message.metadata.usage
  }
  return null
})
/** Images of the last reply on the path: the composer offers "Edit the previous image" when there are any. */
const previousImages = computed(() => {
  for (let index = messages.value.length - 1; index >= 0; index--) {
    const message = messages.value[index]!
    if (message.role === 'assistant')
      return imageFileParts(message).length
  }
  return 0
})
const chatCostUsd = computed(() => {
  let total = 0
  let known = false
  for (const message of messages.value) {
    const cost = message.metadata?.costUsd
    if (message.role === 'assistant' && typeof cost === 'number') {
      total += cost
      known = true
    }
  }
  return known ? total : null
})

// ---------- project trust and project MCP dialogs (Phase 11, ADR-049, ADR-050; W11.11 implements) ----------

/** The trust dialog of the chat's project and the item it opens on (a sha256). */
const trustOpen = ref(false)
const trustFocusKey = ref<string | null>(null)
/** The project MCP dialog of the chat's project and the server it opens on. */
const mcpOpen = ref(false)
const mcpFocusServerId = ref<string | null>(null)

function openProjectTrust(focusKey?: string) {
  trustFocusKey.value = focusKey ?? null
  trustOpen.value = true
}

function openProjectMcp(serverId?: string) {
  mcpFocusServerId.value = serverId ?? null
  mcpOpen.value = true
}

provide(CHAT_VIEW_ACTIONS, {
  openModelPicker: () => composer.value?.openModelPicker(),
  openProjectTrust,
  openProjectMcp,
})

// + Phase 11: the hooks running in this chat's stream, for the tool rows (they are `v-memo`ed: no props).
provide(HOOK_ACTIVITY, session.hookActivity)

// ---------- background agents (Phase 10, ADR-046; W10.10 implements) ----------

/** What the dock shows: running background agents and finished ones whose result was not delivered yet. */
const shownBackgroundTasks = computed(() => visibleTasks(session.backgroundTasks.value))
const stoppingBackgroundTasks = computed(() => shownBackgroundTasks.value.filter(task => backgroundTasks.stopping[task.id]).map(task => task.id))
/** A "Show in background agents" request of a task block (n bumps on each request). */
const backgroundReveal = ref<{ taskId: string, n: number } | null>(null)
/** The delivered results on the shown path, by task id. */
const taskResults = computed(() => taskResultsOf(messages.value))
const view = useTemplateRef<HTMLElement>('view')

/** Scrolls to the result note of a task, opens its report and focuses its toggle (docs/UI.md 14.1). */
function revealResultNote(taskId: string) {
  const note = [...(view.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.taskResult}"]`) ?? [])]
    .find(element => element.dataset.taskId === taskId)
  if (!note)
    return
  note.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  // Opens the report when it is closed (the toggle's data-state), then focuses the toggle.
  note.querySelector<HTMLElement>(`[data-testid="${testIds.taskResultToggle}"][data-state="closed"]`)?.click()
  note.querySelector<HTMLElement>(`[data-testid="${testIds.taskResultToggle}"]`)?.focus({ preventScroll: true })
}

provide(AGENT_TASK_CONTEXT, {
  projectId: () => projectId.value,
  task: taskId => session.backgroundTasks.value.find(task => task.id === taskId) ?? null,
  tasksLoaded: () => backgroundTasks.loaded[props.chatId] === true,
  result: taskId => taskResults.value.get(taskId) ?? null,
  reveal: (taskId) => {
    backgroundReveal.value = { taskId, n: (backgroundReveal.value?.n ?? 0) + 1 }
  },
  showResult: (taskId) => {
    if (!taskResults.value.has(taskId))
      return false
    revealResultNote(taskId)
    return true
  },
})

// The dock's rows read the input of the `task` call that launched each agent (its prompt) from the shown path.
provide(BACKGROUND_TASK_INPUT, (task) => {
  const message = messages.value.find(item => item.id === task.messageId)
  const part = message?.parts.find(item => isToolUIPart(item) && item.toolCallId === task.toolCallId)
  return part && isToolUIPart(part) ? taskInputOf(part.input) : null
})

/** Stop of one background agent (never the composer's Stop): 'gone' -> "It already finished." */
function onStopBackgroundTask(taskId: string) {
  session.stopBackgroundTask(taskId)
    .then((result) => {
      if (result === 'gone')
        toast(BACKGROUND_GONE_MESSAGE)
    })
    .catch(failure => reportFailure(BACKGROUND_STOP_FAILED_MESSAGE, failure))
}

/** Stop all: one stop per running agent, in turn (there is no batch route); a second press waits for the first. */
let stoppingAll = false
function onStopAllBackgroundTasks() {
  if (stoppingAll)
    return
  stoppingAll = true
  backgroundTasks.stopAll(props.chatId)
    .catch(failure => reportFailure(BACKGROUND_STOP_FAILED_MESSAGE, failure))
    .finally(() => {
      stoppingAll = false
    })
}

/** The name of the chat's project, once the projects store knows it. */
const projectName = computed(() => (projectId.value ? projects.byId(projectId.value)?.name ?? null : null))
provide(TOOL_APPROVAL_CONTEXT, {
  toolMode: () => toolMode.value,
  projectName: () => projectName.value,
  projectId: () => projectId.value,
  shellCwd: () => session.cwd.value,
})

// ---------- announcements (polite live region) ----------

const announcement = ref('')
// Announcements made within the same tick are joined ("Conversation compacted. Response finished." for a `/compact`
// reply that streams and finishes at once), so the later one never silently replaces the earlier one.
let pendingAnnouncements: string[] = []
async function announce(text: string) {
  pendingAnnouncements.push(text)
  if (pendingAnnouncements.length > 1)
    return
  announcement.value = ''
  await nextTick()
  announcement.value = pendingAnnouncements.join('. ')
  pendingAnnouncements = []
}

let stopRequested = false
watch(status, (next, previous) => {
  const wasBusy = previous === 'submitted' || previous === 'streaming'
  if (wasBusy && next === 'ready') {
    void announce(stopRequested ? 'Response stopped' : 'Response finished')
    stopRequested = false
  }
  else if (next === 'error' && error.value) {
    void announce(`Error: ${toHarnessErrorView(error.value).message}`)
  }
})

/** Tool calls of the last reply waiting for a decision, with the card's label ("Approval needed: run {cmd}" for shell). */
const pendingApprovals = computed(() => {
  const last = messages.value.at(-1)
  if (last?.role !== 'assistant')
    return []
  return last.parts.flatMap(part => (isToolUIPart(part) && part.state === 'approval-requested'
    ? [{ id: part.toolCallId, label: toolApprovalLabel(toolNameOf(part), part.input) }]
    : []))
})
watch(pendingApprovals, (pending, previous) => {
  const added = pending.find(item => !previous?.some(known => known.id === item.id))
  if (added)
    void announce(added.label)
})

/**
 * + Phase 9 (ADR-040): compaction markers this view has seen (`<message>:<part>:<createdAt>`). A marker is announced once,
 * when it arrives in a stream of this tab ("Conversation compacted"); the markers of a loaded path are only remembered.
 */
const knownMarkers = new Set<string>()
// A `/compact` reply can arrive and finish within one tick, so the status is already `ready` when the marker shows:
// remember that this tab streamed (sync, on every status change) until the next marker check consumed it.
let streamedSinceCheck = false
watch(status, (value) => {
  if (value === 'submitted' || value === 'streaming')
    streamedSinceCheck = true
}, { flush: 'sync', immediate: true })
watch(() => messages.value.at(-1), (last) => {
  const streaming = status.value === 'submitted' || status.value === 'streaming' || streamedSinceCheck
  if (status.value !== 'submitted' && status.value !== 'streaming')
    streamedSinceCheck = false
  if (last?.role !== 'assistant')
    return
  let arrived = false
  for (const marker of compactionMarkers([last])) {
    const key = `${last.id}:${marker.partIndex}:${marker.data.createdAt}`
    if (!knownMarkers.has(key)) {
      knownMarkers.add(key)
      arrived = true
    }
  }
  if (arrived && streaming)
    void announce('Conversation compacted')
}, { immediate: true })

/**
 * + Phase 10 (ADR-046): the carrier messages of turns the server started for finished background agents
 * (`run.started` with `origin: 'task'`) that this view has not shown yet. When its carrier shows, each result whose
 * ending the dock did not announce in this tab (`announcedTasks`) is announced ("Background agent finished:
 * {description}"); carriers of a loaded path are never announced.
 */
const pendingCarriers = new Set<string>()
const announcedCarriers = new Set<string>()

function announceCarriers() {
  if (pendingCarriers.size === 0)
    return
  for (const message of messages.value) {
    if (!pendingCarriers.has(message.id))
      continue
    pendingCarriers.delete(message.id)
    if (announcedCarriers.has(message.id) || !isTaskResultMessage(message))
      continue
    announcedCarriers.add(message.id)
    // Once per tab: only the results whose ending the dock did not announce (e.g. right after a reload).
    for (const result of taskResultsOf([message]).values()) {
      if (announcedTasks.add(result.taskId))
        void announce(endedAnnouncement(result.output))
    }
  }
}

useServerEvents().on('run.started', (event) => {
  const { chatId, origin, userMessageId } = event.data
  if (chatId !== props.chatId || origin !== 'task' || !userMessageId || announcedCarriers.has(userMessageId))
    return
  pendingCarriers.add(userMessageId)
  // A carrier the path never showed (another version is shown) is forgotten after a while.
  if (pendingCarriers.size > 20)
    pendingCarriers.delete(pendingCarriers.values().next().value!)
  announceCarriers()
})
watch(messages, announceCarriers)

// ---------- data the transcript needs ----------

onMounted(() => {
  if (!providers.loaded)
    providers.fetchAll().catch(() => {})
  if (!models.loaded)
    models.fetchAll().catch(() => {})
  if (!plugins.toolsLoaded)
    plugins.fetchTools().catch(() => {})
  // The plugin names of the slash menu and the command badge (Phase 10; the plugins page may never have been opened).
  if (!plugins.loaded)
    plugins.fetchAll().catch(() => {})
  // The project chip, the new-chat picker and "Move to project" (the sidebar may not be mounted, e.g. on mobile).
  if (!projects.loaded && !projects.loading)
    projects.fetchAll().catch(() => {})
})

// A run that starts while the chat is shown (another tab, a continuation elsewhere) is followed live.
watch(() => chats.runState[props.chatId] === 'running', (running) => {
  if (running)
    void session.resumeIfRunning()
})

/** + Phase 11: the last input sent from this view (a refused submit goes back into the composer with its files). */
let lastInput: ComposerSubmitInput | null = null

// `409 conflict` (`run-active`): a reply is already running here; show the live run. `404 not_found`: the shown path
// is stale (the chat changed elsewhere) and the session reloads it. `409 conflict` (`busy`): a master-key rotation
// holds off new runs. In every case a message the server never stored goes back into the composer.
watch(error, (value) => {
  if (!value)
    return
  // + Phase 11: a hook blocked the turn, or a command runs unapproved shell lines: nothing was stored, so the input goes
  // back into the composer with the refusal.
  const refusal = refusalOf(value)
  if (refusal) {
    const unsent = session.takeBackUnstored()
    const text = unsent ? messageText(unsent) : lastInput?.text ?? ''
    // The composer's own input (with its files) when the refused message is the one it sent; else its text (an edit).
    const input = lastInput && lastInput.text === text ? lastInput : { text, files: [] }
    lastInput = null
    session.chat.clearError()
    composer.value?.restoreInput(input)
    composer.value?.showRefusal(refusal)
    return
  }
  const stale = toHarnessError(value).code === 'not_found'
  const busy = isBusyConflict(value)
  if (!stale && !busy && !isRunActiveConflict(value))
    return
  const unsent = session.takeBackUnstored()
  if (unsent)
    composer.value?.setText(messageText(unsent))
  session.chat.clearError()
  if (stale) {
    toast(STALE_CHAT_MESSAGE)
    return
  }
  if (busy) {
    toast(KEY_ROTATION_BUSY_MESSAGE)
    return
  }
  toast(RUN_ACTIVE_MESSAGE)
  chats.setRunState(props.chatId, 'running')
  void session.resumeIfRunning()
})

// ---------- actions ----------

function reportFailure(title: string, failure: unknown) {
  toast.error(title, { description: toHarnessError(failure).message })
}

function onSubmit(input: ComposerSubmitInput) {
  if (!session.modelRef.value) {
    toast.error('Choose a model first')
    composer.value?.openModelPicker()
    return
  }
  const first = props.isNew && messages.value.length === 0
  lastInput = input
  // + Phase 9 (ADR-042): while a run is active the session queues the message (it never enters the transcript).
  const queueing = runActive.value
  const submitting = session.submit(input)
  if (!queueing)
    transcript.value?.scrollToBottom('smooth')
  if (first)
    emit('created', props.chatId)
  submitting
    .then((result) => {
      if (result === 'queued')
        void announce('Message queued')
    })
    .catch(failure => onSubmitFailed(input, failure))
}

/** A message that was neither sent nor queued: its text goes back into the composer (which cleared itself). */
function onSubmitFailed(input: ComposerSubmitInput, failure: unknown) {
  // + Phase 11: a hook refused the queued message at enqueue (or it runs unapproved shell lines).
  const refusal = refusalOf(failure)
  if (refusal) {
    composer.value?.restoreInput(input)
    composer.value?.showRefusal(refusal)
    return
  }
  if (input.text)
    composer.value?.setText(input.text)
  const error = toHarnessError(failure)
  if (error.code === 'conflict' && (error.details as { reason?: unknown } | undefined)?.reason === 'queue-full')
    toast(QUEUE_FULL_MESSAGE)
  else
    reportFailure('Could not send the message', error)
}

function onStop() {
  stopRequested = true
  session.stop()
    .then((dropped) => {
      // + Phase 9: the queued messages the stop dropped go back into this tab's composer.
      if (dropped.length > 0)
        composer.value?.restoreQueued(dropped)
    })
    .catch(failure => reportFailure('Could not stop the response', failure))
}

// ---------- queued messages (Phase 9, ADR-042; W9.9 implements) ----------

/** Cancels a queued message; resolves with the item when it was still queued, else null. */
async function cancelQueued(itemId: string) {
  const item = queue.value.find(entry => entry.id === itemId) ?? null
  cancellingQueued.value = [...cancellingQueued.value, itemId]
  try {
    const result = await session.cancelQueued(itemId)
    if (result === 'gone')
      toast(QUEUE_ITEM_GONE_MESSAGE)
    return result === 'cancelled' ? item : null
  }
  finally {
    cancellingQueued.value = cancellingQueued.value.filter(id => id !== itemId)
  }
}

function onCancelQueued(itemId: string) {
  cancelQueued(itemId).catch(failure => reportFailure('Could not cancel the message', failure))
}

/** Edit = cancel, then the message goes back into the composer. */
function onEditQueued(itemId: string) {
  cancelQueued(itemId)
    .then((item) => {
      if (item)
        composer.value?.restoreQueued([item])
    })
    .catch(failure => reportFailure('Could not cancel the message', failure))
}

function onEditLast() {
  if (session.busy.value)
    return
  transcript.value?.editLastUserMessage()
}

function onEdit(messageId: string, text: string, files: FileUIPart[]) {
  session.edit(messageId, text, files).catch(failure => reportFailure('Could not send the message', failure))
  transcript.value?.scrollToBottom('smooth')
}

function onRegenerate(messageId: string) {
  session.regenerate(messageId).catch(failure => reportFailure('Could not regenerate the response', failure))
}

function onRetry() {
  session.regenerate().catch(failure => reportFailure('Could not retry', failure))
}

function onApproval(decision: ToolApprovalDecision) {
  // A shell approval with "Always allow commands starting with" rethrows a rule that could not be saved (the approval
  // itself was still sent).
  const title = decision.approved && decision.allowRules ? 'Could not save the rule' : 'Could not save the tool preference'
  session.approve(decision).catch(failure => reportFailure(title, failure))
  // + Phase 9 (ADR-041): the plan card's decision is announced, and focus goes back to the composer (desktop).
  if (decision.toolName === PLAN_TOOL_NAME) {
    void announce(decision.approved
      ? `Plan approved. Permission mode: ${toolModeOption(decision.planMode ?? toolMode.value).label}.`
      : 'Feedback sent. The agent keeps planning.')
    void nextTick(() => composer.value?.focus())
  }
}

function onSelectVersion(messageId: string) {
  session.switchBranch(messageId)
    .then(() => {
      // Listed only when the switch showed it (a request in flight makes the switch do nothing).
      const branch = session.branches.value[messageId]
      if (branch)
        void announce(`Version ${branch.index + 1} of ${branch.siblings.length}`)
    })
    .catch((failure) => {
      if (isRunActiveConflict(failure))
        toast(RUN_ACTIVE_MESSAGE)
      else if (toHarnessError(failure).code === 'not_found')
        toast(STALE_CHAT_MESSAGE)
      else
        reportFailure('Could not switch versions', failure)
    })
}

// ---------- delete a version (ADR-030) ----------

/** The version waiting for confirmation, with its versions when the dialog opened. */
const deleteTarget = ref<{ messageId: string, branch: MessageBranch } | null>(null)
const deleting = ref(false)

function onDeleteVersion(messageId: string) {
  const branch = session.branches.value[messageId]
  if (!branch || session.busy.value || session.switching.value)
    return
  deleteTarget.value = { messageId, branch }
}

function onDeleteOpenChange(open: boolean) {
  if (open || deleting.value)
    return
  const target = deleteTarget.value
  deleteTarget.value = null
  // Canceled: back on the button (the dialog has no trigger of its own).
  if (target)
    void nextTick(() => transcript.value?.focusDeleteVersion(target.messageId))
}

async function confirmDeleteVersion() {
  const target = deleteTarget.value
  if (!target || deleting.value)
    return
  deleting.value = true
  let answered = false
  try {
    await session.deleteVersion(target.messageId)
    answered = true
  }
  catch (failure) {
    if (isRunActiveConflict(failure))
      toast(RUN_ACTIVE_MESSAGE)
    else if (toHarnessError(failure).code === 'not_found')
      toast(STALE_CHAT_MESSAGE)
    else
      reportFailure('Could not delete the version', failure)
  }
  deleting.value = false
  deleteTarget.value = null
  const onPath = (messageId: string) => messages.value.some(message => message.id === messageId)
  // Still shown after an answer: nothing was done (a request started meanwhile).
  const deleted = answered && !onPath(target.messageId)
  const shown = deleted ? target.branch.siblings.find(sibling => sibling !== target.messageId && onPath(sibling)) : undefined
  await nextTick()
  if (deleted)
    void announce('Version deleted')
  if (shown)
    transcript.value?.focusShownVersion(shown)
  else if (!deleted)
    transcript.value?.focusDeleteVersion(target.messageId)
}

// ---------- rewind files (Phase 8, ADR-036) ----------

/** The user message whose "Rewind files to here" opened the dialog; null while it is closed. */
const rewindTarget = ref<string | null>(null)
/** The dialog finished with "Restore files and edit": the editor opens on the message once it closed. */
let editAfterRewind = false
const showRewindResult = useRewindResultToast()

function onRewind(messageId: string) {
  if (session.busy.value || !projectId.value)
    return
  editAfterRewind = false
  rewindTarget.value = messageId
}

/** The dialog closed on a `404` or a `409 run-active` answer (its focus returns to the button like a cancel). */
function onRewindRefused(failure: HarnessError) {
  if (failure.code === 'not_found') {
    toast(STALE_CHAT_MESSAGE)
    void session.refresh()
    return
  }
  toast(REWIND_RUN_ACTIVE_MESSAGE)
  // Another chat of the project runs: nothing to follow here.
  const running = runningChatOf(failure)
  if (running !== null && running !== props.chatId)
    return
  chats.setRunState(props.chatId, 'running')
  void session.resumeIfRunning()
}

provide(REWIND_DIALOG_HOST, { refused: onRewindRefused })

function onRewindOpenChange(open: boolean) {
  if (open)
    return
  const target = rewindTarget.value
  rewindTarget.value = null
  if (!target)
    return
  void nextTick(() => {
    if (editAfterRewind)
      transcript.value?.startEdit(target)
    else
      transcript.value?.focusRewind(target)
    editAfterRewind = false
  })
}

function onRewindRestored(result: RestoreResult, then: 'none' | 'edit') {
  editAfterRewind = then === 'edit'
  showRewindResult(props.chatId, result)
}

function onModelChange(value: string) {
  modelRef.value = value
}

function onEffortChange(value: ReasoningEffort) {
  reasoningEffort.value = value
}

function onToolModeChange(value: ToolMode) {
  toolMode.value = value
}

/** + Phase 11: the chat's own output style (null = Automatic); applies from the next turn. */
function onOutputStyleChange(value: string | null) {
  outputStyle.value = value
}

/** The new-chat picker: local until the first send (a saved chat moves through `PATCH`, which can fail). */
function setProject(value: string | null) {
  session.setProject(value).catch(failure => reportFailure('Could not move the chat', failure))
}
</script>

<template>
  <div ref="view" data-slot="chat-view" :data-chat-id="chatId" class="relative flex h-dvh min-h-0 flex-col" :style="composerStyle">
    <slot v-if="!notFound" name="header" :scrolled="scrolled" :title="title" :loading="!loaded" :project-id="projectId" />

    <ChatNotFound v-if="notFound" />

    <div
      v-else-if="showEmpty"
      class="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-[max(2rem,calc(38dvh-5rem))] pb-8 md:px-6"
    >
      <div class="flex w-full max-w-3xl flex-col items-center gap-8">
        <slot name="empty" :project-id="projectId" :set-project="setProject" />
        <div class="w-full">
          <ChatComposer
            ref="composer"
            :chat-id="chatId"
            :status="status"
            :model-ref="modelRef"
            :reasoning-effort="reasoningEffort"
            :tool-mode="toolMode"
            :usage="lastUsage"
            :chat-cost-usd="chatCostUsd"
            :previous-images="previousImages"
            :project-id="projectId"
            :output-style="outputStyle"
            :disabled="noProvider"
            placeholder="Ask anything…"
            @update:model-ref="onModelChange"
            @update:reasoning-effort="onEffortChange"
            @update:tool-mode="onToolModeChange"
            @update:output-style="onOutputStyleChange"
            @submit="onSubmit"
            @stop="onStop"
            @edit-last="onEditLast"
          />
        </div>
      </div>
    </div>

    <div v-else class="relative flex min-h-0 flex-1 flex-col">
      <ChatTranscript
        ref="transcript"
        v-model:scrolled="scrolled"
        :messages="messages"
        :status="status"
        :error="error"
        :show-thinking="ui.showThinking"
        :loading="!loaded && !loadError"
        :branches="branches"
        :switching="switching"
        :project-id="projectId"
        :activity="activity"
        @regenerate="onRegenerate"
        @edit="onEdit"
        @approval="onApproval"
        @retry="onRetry"
        @select-version="onSelectVersion"
        @delete-version="onDeleteVersion"
        @rewind="onRewind"
      />
      <div
        v-if="loadError && !loaded"
        class="pointer-events-none absolute inset-x-0 top-6 z-10 mx-auto w-full max-w-3xl px-4 md:px-6"
      >
        <Alert variant="destructive" class="pointer-events-auto border-destructive/35 bg-destructive/5">
          <AlertTitle>Could not load this chat</AlertTitle>
          <AlertDescription class="text-foreground/80">
            {{ loadError.message }}
          </AlertDescription>
          <div class="col-start-2 mt-2">
            <Button type="button" size="sm" variant="outline" class="text-foreground" @click="session.load()">
              Retry
            </Button>
          </div>
        </Alert>
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-0 z-20">
        <div aria-hidden="true" class="h-6 bg-linear-to-t from-background to-transparent" />
        <div ref="dock" class="pointer-events-auto bg-background px-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6">
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <TodoStrip :state="todos" :running="runActive" />
            <BackgroundAgents
              :tasks="shownBackgroundTasks"
              :stopping="stoppingBackgroundTasks"
              :reveal="backgroundReveal"
              @stop="onStopBackgroundTask"
              @stop-all="onStopAllBackgroundTasks"
            />
            <QueuedMessages
              :items="queue"
              :waiting-for-approval="waitingForApproval"
              :cancelling="cancellingQueued"
              @cancel="onCancelQueued"
              @edit="onEditQueued"
            />
            <ChatComposer
              ref="composer"
              :chat-id="chatId"
              :status="status"
              :model-ref="modelRef"
              :reasoning-effort="reasoningEffort"
              :tool-mode="toolMode"
              :usage="lastUsage"
              :chat-cost-usd="chatCostUsd"
              :previous-images="previousImages"
              :project-id="projectId"
              :output-style="outputStyle"
              :disabled="noProvider"
              placeholder="Reply…"
              @update:model-ref="onModelChange"
              @update:reasoning-effort="onEffortChange"
              @update:tool-mode="onToolModeChange"
              @update:output-style="onOutputStyleChange"
              @submit="onSubmit"
              @stop="onStop"
              @edit-last="onEditLast"
            />
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="deleteTarget !== null"
      title="Delete this version?"
      description="This version and every message after it are deleted. Other versions stay."
      confirm-label="Delete version"
      :pending="deleting"
      :data-testid="testIds.messageDeleteVersionConfirm"
      @update:open="onDeleteOpenChange"
      @confirm="confirmDeleteVersion"
    />

    <RewindDialog
      :open="rewindTarget !== null"
      :chat-id="chatId"
      :message-id="rewindTarget"
      @update:open="onRewindOpenChange"
      @restored="onRewindRestored"
    />

    <ProjectTrustDialog v-model:open="trustOpen" :project-id="projectId" :focus-key="trustFocusKey" />
    <ProjectMcpDialog v-model:open="mcpOpen" :project-id="projectId" :focus-server-id="mcpFocusServerId" />

    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </div>
  </div>
</template>
