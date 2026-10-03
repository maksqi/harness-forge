// Shell rules store (docs/UI.md 7.23, 9.10, 11.5; docs/API.md shell rules; ADR-038): the allowlist of shell command
// prefixes, per project and global ("Allowed in every project"). Loaded on first use (Settings -> Projects, or a shell
// approval card that saves a rule) and again after an event-stream reconnect when loaded; there is no rule event.
// Rules are never edited: remove one and add a new one.
// Signature frozen from Gate P8-0b (C20); implementation W8.11: `fetchAll` joins a load that is already running and
// replays the creates and removes that happened while it ran (so a slower list never brings a removed rule back or
// hides a new one), `create` adds the stored rule (and starts the first load in the background), `remove` drops the
// rule once the server answered (an unknown rule counts as removed), `applyEvent` drops the rules of a deleted project.
import type { ServerEvent, ShellRule } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, withHarnessErrors } from '~/utils/errors'

/** Sort order of rules: by prefix, then by id. */
function compareRules(a: ShellRule, b: ShellRule): number {
  return a.prefix.localeCompare(b.prefix) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** A local change of the list, replayed on a list that was requested before it. */
type ListChange = (list: ShellRule[]) => ShellRule[]

function upserted(rule: ShellRule): ListChange {
  return list => (list.some(item => item.id === rule.id)
    ? list.map(item => (item.id === rule.id ? rule : item))
    : [...list, rule])
}

function without(id: string): ListChange {
  return list => (list.some(item => item.id === id) ? list.filter(item => item.id !== id) : list)
}

function withoutProject(projectId: string): ListChange {
  return list => (list.some(item => item.projectId === projectId) ? list.filter(item => item.projectId !== projectId) : list)
}

export const useShellRulesStore = defineStore('shell-rules', () => {
  const api = useApi()

  // ---------- state ----------

  const items = ref<ShellRule[]>([])
  /** The list arrived once. */
  const loaded = ref(false)
  const loading = ref(false)

  // ---------- getters ----------

  /** The global rules (`projectId` null), sorted by prefix. */
  const global = computed<ShellRule[]>(() => items.value.filter(rule => rule.projectId === null).sort(compareRules))
  /** `forProject(projectId)`: the rules of one project, sorted by prefix. */
  const forProject = computed(() => (projectId: string): ShellRule[] =>
    items.value.filter(rule => rule.projectId === projectId).sort(compareRules))
  /** `countForProject(projectId)`: how many rules the project has ("{n} allowed commands"). */
  const countForProject = computed(() => (projectId: string): number =>
    items.value.reduce((count, rule) => (rule.projectId === projectId ? count + 1 : count), 0))

  // ---------- helpers ----------

  /** The load that is running; a second `fetchAll` joins it. */
  let pending: Promise<void> | null = null
  /** The local changes made while `pending` runs (replayed on its answer); null while nothing loads. */
  let changes: ListChange[] | null = null

  function apply(change: ListChange): void {
    const next = change(items.value)
    if (next !== items.value)
      items.value = next
    changes?.push(change)
  }

  // ---------- actions ----------

  /**
   * `GET /shell-rules` (every rule: global and of every project). A call while a load runs joins it. Throws
   * `HarnessError`; a failed load keeps the rules shown before.
   */
  function fetchAll(): Promise<void> {
    if (pending)
      return pending
    loading.value = true
    const replay: ListChange[] = []
    changes = replay
    const request = (async () => {
      try {
        const list = await withHarnessErrors(api.shellRules.list())
        items.value = replay.reduce((current, change) => change(current), list.items)
        loaded.value = true
      }
      finally {
        pending = null
        changes = null
        loading.value = false
      }
    })()
    pending = request
    return request
  }

  /**
   * `POST /shell-rules { projectId, prefix }` (projectId null = a global rule); the server stores the canonical prefix
   * and the stored rule joins the list. Throws `HarnessError` (409 `exists`, 400 a refused prefix or the cap, 404 an
   * unknown project). Before the list was ever loaded (a rule saved from an approval card), it starts loading.
   */
  async function create(input: { projectId: string | null, prefix: string }): Promise<ShellRule> {
    try {
      const rule = await withHarnessErrors(api.shellRules.create({ body: input }))
      apply(upserted(rule))
      return rule
    }
    finally {
      if (!loaded.value && !pending)
        fetchAll().catch(() => {})
    }
  }

  /** `DELETE /shell-rules/:id`; the rule leaves the list once the server answered (a 404 counts as removed). */
  async function remove(id: string): Promise<void> {
    try {
      await withHarnessErrors(api.shellRules.remove({ params: { id } }))
    }
    catch (error) {
      if (!hasErrorCode(error, 'not_found'))
        throw error
    }
    apply(without(id))
  }

  /** `project.changed` with `project: null`: drop that project's rules (the server deleted them with the project). */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'project.changed' && event.data.project === null)
      apply(withoutProject(event.data.id))
  }

  return {
    items,
    loaded,
    loading,
    global,
    forProject,
    countForProject,
    fetchAll,
    create,
    remove,
    applyEvent,
  }
})
