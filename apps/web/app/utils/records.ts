// Immutable record helpers for store state. Auto-imported (utils/).

/** A copy of `record` without `key`. */
export function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}
