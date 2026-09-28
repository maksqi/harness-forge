// Saving binary API responses as files (chat exports, plugin exports). Auto-imported (utils/).

/** A file name without path separators or control characters, at most 200 characters; null when nothing is left. */
function cleanFileName(name: string): string | null {
  let clean = ''
  for (const char of name) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7F || char === '/' || char === '\\')
      continue
    clean += char
  }
  clean = clean.trim().replace(/^\.+/, '').slice(0, 200)
  return clean === '' ? null : clean
}

/**
 * The file name of a `Content-Disposition` header: `filename*=UTF-8''<percent-encoded>` wins over
 * `filename="<name>"`; the result is stripped of path separators and control characters.
 */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  if (!header)
    return null
  const extended = header.match(/filename\*\s*=\s*utf-8''([^;]+)/i)
  if (extended?.[1]) {
    try {
      const name = cleanFileName(decodeURIComponent(extended[1].trim()))
      if (name)
        return name
    }
    catch {
      // Malformed percent-encoding: fall back to the plain parameter.
    }
  }
  const quoted = header.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/)
  if (quoted?.[1] !== undefined)
    return cleanFileName(quoted[1].replace(/\\(.)/g, '$1'))
  const bare = header.match(/filename\s*=\s*([^;\s]+)/)
  return bare?.[1] ? cleanFileName(bare[1]) : null
}

/**
 * Saves a response body as a download named by its `Content-Disposition` (else `fallbackName`) through a temporary
 * object URL and a hidden link.
 */
export async function downloadResponse(response: Response, fallbackName: string): Promise<void> {
  const blob = await response.blob()
  const name = fileNameFromDisposition(response.headers.get('content-disposition')) ?? cleanFileName(fallbackName) ?? 'download'
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.append(link)
  try {
    link.click()
  }
  finally {
    link.remove()
    // Some browsers read the object URL after click() returns; release it a little later.
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}
