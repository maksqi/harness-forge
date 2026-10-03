// Quiet loading of the projects for the chat UI (the switcher, the pickers, the chip, the palette): the first caller
// loads the list, later callers reuse it; a failure shows nothing here (Settings -> Projects shows its own error).
import { useProjectsStore } from '~/stores/projects'

/** Loads the projects unless they are loaded or loading. Never rejects. */
export function loadProjectsOnce(): void {
  const projects = useProjectsStore()
  if (!projects.loaded && !projects.loading)
    projects.fetchAll().catch(() => {})
}

/** Refreshes the projects (chat counts and folder states change on the server) unless a request is running. */
export function refreshProjects(): void {
  const projects = useProjectsStore()
  if (!projects.loading)
    projects.fetchAll().catch(() => {})
}
