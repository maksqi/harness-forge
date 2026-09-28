// Status dot vocabulary (docs/UI.md 5.10).
export type StatusDotStatus = 'running' | 'approval' | 'unread' | 'ok' | 'off' | 'warning' | 'error'

/** Default visually hidden label and tooltip per status. */
export const statusDotLabels: Record<StatusDotStatus, string> = {
  running: 'Running',
  approval: 'Needs approval',
  unread: 'Unread',
  ok: 'Active',
  off: 'Off',
  warning: 'Needs attention',
  error: 'Error',
}

/** Dot classes per status; tokens only. `off` is a hollow ring. */
export const statusDotClasses: Record<StatusDotStatus, string> = {
  running: 'bg-primary animate-hf-pulse',
  approval: 'bg-warning',
  unread: 'bg-foreground',
  ok: 'bg-success',
  off: 'border-[1.5px] border-muted-foreground bg-transparent',
  warning: 'bg-warning',
  error: 'bg-destructive',
}
