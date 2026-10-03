// URLs of stored files (the `url` of UI `file` parts, API.md 5.11). Re-exported by ./index.ts.

/** URL path of a stored file (the `url` of UI `file` parts). */
export const FILE_URL_PREFIX = '/api/files/'

export function fileUrl(id: string): string {
  return `${FILE_URL_PREFIX}${id}`
}
