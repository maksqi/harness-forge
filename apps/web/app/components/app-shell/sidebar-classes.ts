// Shared classes for sidebar rows (docs/UI.md 3.5, 3.7): density-aware height, muted until hovered or active,
// inset focus ring that never changes the layout.
export const SIDEBAR_ROW_CLASS = [
  'h-(--row-height) text-sidebar-foreground/75 hover:text-sidebar-foreground',
  'data-active:text-sidebar-foreground',
  'focus-visible:ring-inset focus-visible:ring-sidebar-ring/50',
  '[&>svg]:text-sidebar-foreground/60 hover:[&>svg]:text-sidebar-foreground data-active:[&>svg]:text-sidebar-foreground',
].join(' ')

/**
 * Keyboard hint inside a sidebar row: quiet text instead of key caps, hidden below lg, on touch devices and in
 * icon mode (docs/UI.md 12).
 */
export const SIDEBAR_KBD_CLASS = [
  'ml-auto hidden lg:inline-flex pointer-coarse:hidden group-data-[collapsible=icon]:hidden',
  '**:data-[slot=kbd]:bg-transparent **:data-[slot=kbd]:px-0 **:data-[slot=kbd]:text-muted-foreground/70',
].join(' ')
