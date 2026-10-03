// Shell rules store (docs/UI.md 7.23, 9.10, 11.5; docs/API.md shell rules; ADR-038): the allowlist of shell command
// prefixes, per project and global ("Allowed in every project"). Loaded on first use (Settings -> Projects, or a shell
// approval card that saves a rule) and again after an event-stream reconnect when loaded; there is no rule event.
// Rules are never edited: remove one and add a new one.
// Signature frozen from Gate P8-0b (C20). Stub bodies: `fetchAll` and `applyEvent` do nothing yet and `create` /
// `remove` call the API without touching the list; W8.11 implements the list (sorted getters, upserts, a 404 that
// counts as removed, dropping a deleted project's rules).
import type { ServerEvent, ShellRule } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { withHarnessErrors } from '~/utils/errors'

/** Sort order of rules: by prefix, then by id. */
function compareRules(a: ShellRule, b: ShellRule): number {
  return a.prefix.localeCompare(b.prefix) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
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

  // ---------- actions ----------

  /** `GET /shell-rules`. Throws `HarnessError`. Stub (C20): does nothing until W8.11. */
  async function fetchAll(): Promise<void> {}

  /**
   * `POST /shell-rules { projectId, prefix }` (projectId null = a global rule); the server stores the canonical prefix.
   * Throws `HarnessError` (409 `exists`, 400 a refused prefix or the cap). Stub (C20): the list is not updated yet.
   */
  function create(input: { projectId: string | null, prefix: string }): Promise<ShellRule> {
    return withHarnessErrors(api.shellRules.create({ body: input }))
  }

  /** `DELETE /shell-rules/:id`; a 404 counts as removed (W8.11). Stub (C20): the list is not updated yet. */
  async function remove(id: string): Promise<void> {
    await withHarnessErrors(api.shellRules.remove({ params: { id } }))
  }

  /** `project.changed` with `project: null`: drop that project's rules (the server deleted them). Stub (C20). */
  function applyEvent(_event: ServerEvent): void {}

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
