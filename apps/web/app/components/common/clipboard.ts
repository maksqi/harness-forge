// Clipboard write with a fallback for insecure contexts (plain HTTP on a LAN has no navigator.clipboard).

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined')
    return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.opacity = '0'
  document.body.appendChild(area)
  const selection = document.getSelection()
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  area.select()
  let ok = false
  try {
    // Deprecated but still the only option without the async Clipboard API.
    ok = document.execCommand('copy')
  }
  catch {
    ok = false
  }
  document.body.removeChild(area)
  if (previous && selection) {
    selection.removeAllRanges()
    selection.addRange(previous)
  }
  return ok
}

/** Copies text to the clipboard. Resolves to false when every method failed. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    }
    catch {
      // Permission denied or not focused: try the legacy path.
    }
  }
  return legacyCopy(text)
}
