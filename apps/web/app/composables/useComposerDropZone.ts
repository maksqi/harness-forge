// Drag and drop of files onto the chat pane (docs/UI.md 7.7): while files are dragged over the window the drop
// overlay covers the pane ("Drop files to attach"); dropping attaches them. Listeners live on the document while
// the composer is mounted. The drop listener runs in the capture phase, so the files reach the composer's upload
// flow and never the prompt input's own (unused) attachment state, and the browser never navigates to a file.
import type { Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { ref } from 'vue'

export interface DropZoneRect {
  top: number
  left: number
  width: number
  height: number
}

export interface ComposerDropZoneOptions {
  onFiles: (files: File[]) => void
  /** The pane the overlay covers (default: the whole viewport). */
  pane?: () => Element | null | undefined
  /** False ignores drags (default: always on). */
  enabled?: () => boolean
}

export interface ComposerDropZone {
  /** A file drag is over the window. */
  active: Ref<boolean>
  /** Viewport rectangle of the pane, measured when the drag starts. */
  rect: Ref<DropZoneRect | null>
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function viewportRect(): DropZoneRect {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth
  const height = typeof window === 'undefined' ? 0 : window.innerHeight
  return { top: 0, left: 0, width, height }
}

export function useComposerDropZone(options: ComposerDropZoneOptions): ComposerDropZone {
  const active = ref(false)
  const rect = ref<DropZoneRect | null>(null)
  let depth = 0
  const enabled = () => options.enabled?.() ?? true

  function measure(): DropZoneRect {
    const viewport = viewportRect()
    const box = options.pane?.()?.getBoundingClientRect()
    if (!box || box.width === 0)
      return viewport
    const top = Math.max(box.top, 0)
    const bottom = Math.min(box.bottom, viewport.height || box.bottom)
    return { top, left: box.left, width: box.width, height: Math.max(bottom - top, 0) }
  }

  function show() {
    if (!active.value) {
      rect.value = measure()
      active.value = true
    }
  }

  function reset() {
    depth = 0
    active.value = false
  }

  if (typeof document !== 'undefined') {
    useEventListener(document, 'dragenter', (event: DragEvent) => {
      if (!carriesFiles(event) || !enabled())
        return
      event.preventDefault()
      depth += 1
      show()
    })
    useEventListener(document, 'dragover', (event: DragEvent) => {
      if (!carriesFiles(event) || !enabled())
        return
      // Allows the drop (and keeps the browser from opening the file).
      event.preventDefault()
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = 'copy'
      show()
    })
    useEventListener(document, 'dragleave', (event: DragEvent) => {
      if (!carriesFiles(event) || !active.value)
        return
      depth = Math.max(depth - 1, 0)
      if (depth === 0)
        active.value = false
    })
    useEventListener(document, 'drop', (event: DragEvent) => {
      if (!carriesFiles(event))
        return
      event.preventDefault()
      event.stopPropagation()
      reset()
      if (!enabled())
        return
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0)
        options.onFiles(files)
    }, { capture: true })
    useEventListener(document, 'dragend', reset)
  }

  return { active, rect }
}
