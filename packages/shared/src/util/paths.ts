// Relative POSIX path rules for files inside a plugin directory (API.md section 5.18).

const SEGMENT = /^[\w.-]+$/

/** Maximum length of a relative plugin file path. */
export const RELATIVE_PATH_MAX_LENGTH = 256
/** Maximum number of segments of a relative plugin file path. */
export const RELATIVE_PATH_MAX_SEGMENTS = 8

/**
 * A relative POSIX path of 1..256 characters and at most 8 segments of `[A-Za-z0-9._-]`: no leading `/`, no empty,
 * `.` or `..` segments, no backslashes, no NUL. (The server still resolves it with `realpath` inside its root.)
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > RELATIVE_PATH_MAX_LENGTH)
    return false
  const segments = path.split('/')
  if (segments.length > RELATIVE_PATH_MAX_SEGMENTS)
    return false
  return segments.every(segment => segment !== '.' && segment !== '..' && SEGMENT.test(segment))
}
