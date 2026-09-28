// Keyboard shortcut registry (docs/UI.md 11.2, 12). One `keydown` listener on window (plugins/shortcuts.client.ts)
// dispatches to the registered shortcuts; ShortcutsDialog lists them. `mod` = Meta on macOS, Ctrl elsewhere.
// Alt shortcuts match `event.code` (Option+M types a symbol on macOS), are ignored with Ctrl or Meta, and switch
// off with the `altShortcuts` setting. Nothing fires during IME composition; in text inputs only shortcuts with
// `allowInInputs`, in CodeMirror only those with `allowInEditor` (Mod+K, Mod+S).
import { getCurrentScope, onScopeDispose, shallowRef } from 'vue'
import { formatKeys, isApplePlatform } from '~/components/common/keys'

export type ShortcutGroup = 'General' | 'Chat' | 'Composer' | 'Editor'

export interface ShortcutDef {
  /** Stable id, e.g. 'new-chat'. A later registration with the same id replaces the earlier one in list(). */
  id: string
  /** Tokens `mod ctrl alt shift meta` + one key, joined by `+`: 'mod+shift+o', 'shift+escape'; 'code:KeyM' matches `event.code`. */
  keys: string
  /** Shown in ShortcutsDialog. */
  description: string
  group: ShortcutGroup
  /** Omitted = display-only (e.g. Mod+B, handled by SidebarProvider). */
  handler?: (event: KeyboardEvent) => void
  /** Evaluated per key press; false skips the shortcut. */
  when?: () => boolean
  /** Also fire while typing in an input, textarea, select or contenteditable. Default false. */
  allowInInputs?: boolean
  /** Also fire inside CodeMirror (`.cm-editor`). Default false; only Mod+K and Mod+S use it (docs/UI.md 12). */
  allowInEditor?: boolean
  /** An Alt shortcut (off when the `altShortcuts` setting is false). Default: the keys contain `alt`. */
  alt?: boolean
}

export interface ShortcutRegistryOptions {
  /** Default: detected from the browser. */
  isMac?: boolean
  /** Whether Alt shortcuts are on (the `altShortcuts` setting). Default: always on. */
  altEnabled?: () => boolean
}

export interface ShortcutRegistry {
  /** Registers shortcuts; returns the unregister function (also called automatically when the current scope ends). */
  register: (defs: ShortcutDef | ShortcutDef[]) => () => void
  /** Registered shortcuts for display: one per id (the latest), ordered General, Chat, Composer, Editor. Reactive. */
  list: () => ShortcutDef[]
  /** Display tokens of a combo: ['⌘', '⇧', 'O'] on macOS, ['Ctrl', 'Shift', 'O'] elsewhere. */
  format: (keys: string) => string[]
  isMac: boolean
  /** The window `keydown` handler (installed once by plugins/shortcuts.client.ts). */
  handleKeydown: (event: KeyboardEvent) => void
  /** Connects the `altShortcuts` setting. */
  setAltEnabled: (altEnabled: () => boolean) => void
}

interface ParsedKeys {
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  /** Lowercase `event.key` value to match. */
  key?: string
  /** `event.code` value to match ('code:' token). */
  code?: string
}

interface Registration {
  def: ShortcutDef
  parsed: ParsedKeys | null
}

const GROUP_ORDER: readonly ShortcutGroup[] = ['General', 'Chat', 'Composer', 'Editor']

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  space: ' ',
  spacebar: ' ',
  slash: '/',
  plus: '+',
  del: 'delete',
}

/** Parses a combo; `mod` resolves to Meta (macOS) or Ctrl. Null when there is no key or an unknown modifier. */
function parseKeys(keys: string, isMac: boolean): ParsedKeys | null {
  const parsed: ParsedKeys = { ctrl: false, meta: false, alt: false, shift: false }
  for (const part of keys.split('+').map(token => token.trim()).filter(Boolean)) {
    const token = part.toLowerCase()
    if (token === 'mod') {
      if (isMac)
        parsed.meta = true
      else
        parsed.ctrl = true
    }
    else if (token === 'ctrl' || token === 'control') {
      parsed.ctrl = true
    }
    else if (token === 'meta' || token === 'cmd' || token === 'command') {
      parsed.meta = true
    }
    else if (token === 'alt' || token === 'option') {
      parsed.alt = true
    }
    else if (token === 'shift') {
      parsed.shift = true
    }
    else if (parsed.key !== undefined || parsed.code !== undefined) {
      return null
    }
    else if (token.startsWith('code:')) {
      parsed.code = part.slice(5)
    }
    else {
      parsed.key = KEY_ALIASES[token] ?? token
    }
  }
  return parsed.key !== undefined || parsed.code !== undefined ? parsed : null
}

/** Shift is part of the combo only for letters, digits and named keys: '/' needs Shift on some layouts. */
function shiftSensitive(key: string): boolean {
  return key.length > 1 || /^[\da-z]$/.test(key)
}

function matches(parsed: ParsedKeys, event: KeyboardEvent): boolean {
  if (event.ctrlKey !== parsed.ctrl || event.metaKey !== parsed.meta || event.altKey !== parsed.alt)
    return false
  if (parsed.code !== undefined)
    return event.code === parsed.code && event.shiftKey === parsed.shift
  const key = parsed.key!
  if (event.key.toLowerCase() === key)
    return parsed.shift ? event.shiftKey : !shiftSensitive(key) || !event.shiftKey
  // Non-Latin layouts (and Option on macOS) report another character: match letters by the physical key.
  if (/^[a-z]$/.test(key) && event.code === `Key${key.toUpperCase()}` && !/^[\x20-\x7E]$/.test(event.key))
    return event.shiftKey === parsed.shift
  return false
}

type TypingContext = 'editor' | 'input' | null

function typingContext(target: EventTarget | null): TypingContext {
  if (typeof Element === 'undefined' || !(target instanceof Element))
    return null
  if (target.closest('.cm-editor'))
    return 'editor'
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')))
    return 'input'
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
    return 'input'
  if (target instanceof HTMLInputElement)
    return ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(target.type) ? null : 'input'
  return null
}

/** A registry instance (tests create their own; the app uses the shared one through useShortcuts()). */
export function createShortcutRegistry(options: ShortcutRegistryOptions = {}): ShortcutRegistry {
  const isMac = options.isMac ?? isApplePlatform()
  let altEnabled = options.altEnabled ?? (() => true)
  const registrations = shallowRef<readonly Registration[]>([])

  function register(defs: ShortcutDef | ShortcutDef[]): () => void {
    const added = (Array.isArray(defs) ? defs : [defs]).map(def => ({ def, parsed: parseKeys(def.keys, isMac) }))
    registrations.value = [...registrations.value, ...added]
    let active = true
    const unregister = () => {
      if (!active)
        return
      active = false
      registrations.value = registrations.value.filter(item => !added.includes(item))
    }
    if (getCurrentScope())
      onScopeDispose(unregister)
    return unregister
  }

  function list(): ShortcutDef[] {
    const byId = new Map<string, ShortcutDef>()
    for (const { def } of registrations.value) {
      byId.delete(def.id)
      byId.set(def.id, def)
    }
    const defs = [...byId.values()]
    return GROUP_ORDER.flatMap(group => defs.filter(def => def.group === group))
  }

  function format(keys: string): string[] {
    return formatKeys(keys, isMac).map(token => token.label)
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
      return
    const context = typingContext(event.target)
    const current = registrations.value
    for (let position = current.length - 1; position >= 0; position--) {
      const { def, parsed } = current[position]!
      if (!def.handler || !parsed || !matches(parsed, event))
        continue
      if (context === 'editor' && !def.allowInEditor)
        continue
      if (context === 'input' && !def.allowInInputs)
        continue
      if ((def.alt ?? parsed.alt) && !altEnabled())
        continue
      if (def.when && !def.when())
        continue
      // Also for auto-repeat, so a held combo never reaches the browser's own shortcut.
      event.preventDefault()
      if (!event.repeat)
        def.handler(event)
      return
    }
  }

  function setAltEnabled(next: () => boolean) {
    altEnabled = next
  }

  return { register, list, format, isMac, handleKeydown, setAltEnabled }
}

let shared: ShortcutRegistry | undefined

/** The app-wide shortcut registry (docs/UI.md 11.2). */
export function useShortcuts(): ShortcutRegistry {
  shared ??= createShortcutRegistry()
  return shared
}
